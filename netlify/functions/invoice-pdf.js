/**
 * invoice-pdf.js
 * ----------------------------------------------------------------------------
 * Eine einzelne Rechnung als PDF.
 *
 *   GET /.netlify/functions/invoice-pdf?password=...&no=GNC-2026-0001
 *       → application/pdf
 *
 * ZUGRIFF: wie invoices-list und invoices-zip nur superadmin und admin.
 * Rechnungen enthalten Kunden- und Umsatzdaten – Personal am Truck sieht sie
 * ausdrücklich nicht.
 *
 * Das PDF wird bei jedem Abruf neu erzeugt, nicht gespeichert: so trägt auch
 * eine ältere Rechnung immer das aktuelle Layout. Fehlende Felder älterer
 * Datensätze holt ergaenzeAusBestellung aus dem Bestellarchiv nach.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { buildInvoicePdf, ergaenzeAusBestellung } = require('./lib/invoice');

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

async function authRole(pw) {
  if (!pw) return null;
  const admin = process.env.ADMIN_PASSWORD || '';
  if (admin && pw === admin) return { role: 'superadmin' };
  try {
    const t = store('team');
    const { blobs } = await t.list({ prefix: 'u:' });
    const h = crypto.createHash('sha256').update(String(pw)).digest('hex');
    for (const b of blobs) {
      const u = await t.get(b.key, { type: 'json' });
      if (u && u.pwHash === h) return { role: u.role === 'admin' ? 'admin' : 'staff' };
    }
  } catch (e) {}
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'method_not_allowed' };
  const p = event.queryStringParameters || {};

  const who = await authRole(p.password);
  if (!who) return { statusCode: 401, body: 'unauthorized' };
  if (who.role !== 'superadmin' && who.role !== 'admin') {
    return { statusCode: 403, body: 'forbidden' };
  }

  // Nur das erwartete Muster zulassen – die Nummer geht direkt in den
  // Speicherschlüssel und in den Dateinamen.
  const nummer = String(p.no || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 40);
  if (!/^GNC-\d{4}-\d{4}$/.test(nummer)) return { statusCode: 400, body: 'bad_invoice_no' };

  try {
    const rec = await store('invoices').get('inv:' + nummer, { type: 'json' });
    // Ein reservierter Platzhalter ist keine Rechnung – die Nummer wurde
    // vergeben, der Satz aber nie gefüllt.
    if (!rec || !rec.invoiceNo || rec.platzhalter) return { statusCode: 404, body: 'not_found' };

    const voll = await ergaenzeAusBestellung(rec, store('orders'));
    const pdf = await buildInvoicePdf(voll);

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="Rechnung-${nummer}.pdf"`,
        'Access-Control-Allow-Origin': '*',
      },
      body: pdf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e) {
    console.error('invoice-pdf:', e);
    return { statusCode: 500, body: 'server_error' };
  }
};
