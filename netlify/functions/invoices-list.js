/**
 * invoices-list.js
 * ----------------------------------------------------------------------------
 * Rechnungen für das Admin-Tool.
 *
 *   GET /.netlify/functions/invoices-list?password=...&year=2026
 *       → { ok, invoices: [...], years: [...] }
 *
 * ZUGRIFF: ausdrücklich NUR superadmin und admin. Personal (role "staff")
 * bekommt 403 – Rechnungen enthalten Kunden- und Umsatzdaten, die nicht
 * jeder am Truck sehen muss.
 *
 * Rechnungen werden NICHT automatisch gelöscht (§ 147 AO: 8 Jahre
 * Aufbewahrungspflicht), anders als die Bestelldaten nach 90 Tagen.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { ergaenzeAusBestellung } = require('./lib/invoice');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify(body),
});

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

/* Rolle bestimmen – gleiche Logik wie in team.js und orders-list.js. */
async function authRole(pw) {
  if (!pw) return null;
  const admin = process.env.ADMIN_PASSWORD || '';
  if (admin && pw === admin) return { role: 'superadmin', name: 'Kubi' };
  try {
    const t = store('team');
    const { blobs } = await t.list({ prefix: 'u:' });
    const h = crypto.createHash('sha256').update(String(pw)).digest('hex');
    for (const b of blobs) {
      const u = await t.get(b.key, { type: 'json' });
      if (u && u.pwHash === h) {
        return { role: u.role === 'admin' ? 'admin' : 'staff', name: u.name || b.key.slice(2) };
      }
    }
  } catch (e) {}
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return json(405, { error: 'method_not_allowed' });

  const p = event.queryStringParameters || {};
  // Bremse gegen Durchprobieren – siehe lib/auth-guard.js
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;
  const who = await authRole(p.password);
  await meldeErgebnis(event, !!who);
  if (!who) return json(401, { error: 'unauthorized' });
  // Nur Admins – Personal ausdrücklich ausgeschlossen
  if (who.role !== 'superadmin' && who.role !== 'admin') {
    return json(403, { error: 'forbidden', hint: 'Rechnungen sind nur für Admins sichtbar' });
  }

  try {
    const s = store('invoices');
    const { blobs } = await s.list({ prefix: 'inv:' });
    const alle = [];
    for (const b of blobs) {
      const r = await s.get(b.key, { type: 'json' });
      // Reservierte, aber nie ausgefuellte Nummern ueberspringen – sie sind
      // nur ein Platzhalter aus der Nummernvergabe, keine echte Rechnung.
      if (r && r.invoiceNo && !r.platzhalter) alle.push(await ergaenzeAusBestellung(r, store('orders')));
    }

    // Jahre für den Filter – aus der Nummer GNC-JJJJ-NNNN
    const years = [...new Set(alle.map(r => (r.invoiceNo.split('-')[1] || '')).filter(Boolean))]
      .sort().reverse();

    let liste = alle;
    if (p.year) liste = liste.filter(r => r.invoiceNo.includes('-' + p.year + '-'));

    // Neueste zuerst
    liste.sort((a, b) => String(b.invoiceNo).localeCompare(String(a.invoiceNo)));

    const summe = liste.reduce((n, r) => n + (Number(r.total) || 0), 0);
    const steuer = liste.reduce(
      (n, r) => n + (r.vat || []).reduce((m, v) => m + (Number(v.steuer) || 0), 0), 0);

    return json(200, {
      ok: true,
      role: who.role,
      years,
      count: liste.length,
      sumBrutto: +summe.toFixed(2),
      sumSteuer: +steuer.toFixed(2),
      invoices: liste,
    });
  } catch (e) {
    console.error('invoices-list:', e);
    return json(500, { error: 'server_error' });
  }
};
