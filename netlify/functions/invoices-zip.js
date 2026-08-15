/**
 * invoices-zip.js
 * ----------------------------------------------------------------------------
 * Alle Rechnungen als ZIP mit einzelnen PDFs.
 *
 *   GET /.netlify/functions/invoices-zip?password=...&year=2026
 *       → application/zip
 *
 * ZUGRIFF: wie invoices-list nur superadmin und admin.
 *
 * Grenze: Eine Function darf höchstens rund 6 MB zurückgeben, und die
 * Base64-Kodierung bläht das noch einmal um ein Drittel auf. Deshalb wird
 * bei MAX_PDF gedeckelt und im Dateinamen vermerkt, wenn nicht alles
 * hineinpasste – lieber ein ehrlich benanntes Teilpaket als ein Abbruch
 * ohne Erklärung.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { buildInvoicePdf, ergaenzeAusBestellung } = require('./lib/invoice');
const { buildZip } = require('./lib/zip');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');

const MAX_PDF = 150;

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

/* Dateinamen bewusst auf ASCII beschränken: aeltere Entpacker unter Windows
   stellen Umlaute sonst falsch dar. Die Rechnungsnummer ist ohnehin ASCII. */
const sicherName = (s) => String(s || '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60);

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'method_not_allowed' };
  const p = event.queryStringParameters || {};
  // Bremse gegen Durchprobieren – siehe lib/auth-guard.js
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;
  const who = await authRole(p.password);
  await meldeErgebnis(event, !!who);
  if (!who) return { statusCode: 401, body: 'unauthorized' };
  if (who.role !== 'superadmin' && who.role !== 'admin') {
    return { statusCode: 403, body: 'forbidden' };
  }

  try {
    const s = store('invoices');
    const { blobs } = await s.list({ prefix: 'inv:' });
    let liste = [];
    for (const b of blobs) {
      const r = await s.get(b.key, { type: 'json' });
      if (r && r.invoiceNo && !r.platzhalter) liste.push(await ergaenzeAusBestellung(r, store('orders')));
    }
    if (p.year) liste = liste.filter(r => String(r.invoiceNo).includes('-' + p.year + '-'));
    liste.sort((a, b) => String(a.invoiceNo).localeCompare(String(b.invoiceNo)));

    if (!liste.length) return { statusCode: 404, body: 'keine_rechnungen' };

    const gekuerzt = liste.length > MAX_PDF;
    const auswahl = gekuerzt ? liste.slice(-MAX_PDF) : liste;   // die neuesten zuerst sichern

    const dateien = [];
    for (const r of auswahl) {
      try {
        const pdf = await buildInvoicePdf(r);
        dateien.push({ name: `Rechnung-${sicherName(r.invoiceNo)}.pdf`, data: pdf });
      } catch (e) {
        console.error('PDF fehlgeschlagen für', r.invoiceNo, e);
      }
    }
    if (!dateien.length) return { statusCode: 500, body: 'keine_pdfs' };

    const zip = buildZip(dateien);
    const stand = p.year ? String(p.year) : 'alle';
    const name = `Rechnungen-${stand}${gekuerzt ? `-letzte-${MAX_PDF}` : ''}.zip`;

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${name}"`,
        'X-Invoice-Count': String(dateien.length),
        'X-Invoice-Truncated': gekuerzt ? '1' : '0',
        'Access-Control-Allow-Origin': '*',
      },
      body: zip.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e) {
    console.error('invoices-zip:', e);
    return { statusCode: 500, body: 'server_error' };
  }
};
