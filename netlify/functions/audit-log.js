/**
 * audit-log.js
 * ----------------------------------------------------------------------------
 * Änderungs-Protokoll fürs Admin-Tool (Karte im Team-Tab).
 *
 *   GET /.netlify/functions/audit-log?password=...&days=14
 *   → { entries: [ { at, name, role, action, detail } ] }   (neueste zuerst)
 *
 * Sichtbar für Admins & Superadmin. Geloggt wird von: shop-status (Pause,
 * Ausverkauft, Special, Wartezeit), push-send, orders-action (abschließen,
 * prüfen, rückerstatten) und team (Zugänge). Aufbewahrung: 30 Tage – ältere
 * Einträge werden beim Lesen automatisch entfernt.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const RETENTION_DAYS = 30;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify(data),
});

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

async function authAdmin(pw) {
  if (!pw) return false;
  const admin = process.env.ADMIN_PASSWORD || '';
  if (admin && pw === admin) return true;
  try {
    const t = store('team');
    const { blobs } = await t.list({ prefix: 'u:' });
    const h = crypto.createHash('sha256').update(String(pw)).digest('hex');
    for (const b of blobs) {
      const u = await t.get(b.key, { type: 'json' });
      if (u && u.pwHash === h) return u.role === 'admin';
    }
  } catch (e) {}
  return false;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return json(405, { error: 'method_not_allowed' });

  const p = event.queryStringParameters || {};
  if (!(await authAdmin(p.password))) return json(401, { error: 'unauthorized' });

  const days = Math.min(parseInt(p.days || '14', 10) || 14, 30);
  const since = Date.now() - days * 86400000;
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;

  try {
    const s = store('audit');
    const { blobs } = await s.list({ prefix: 'a:' });
    // Schlüssel beginnen mit ISO-Zeitstempel → alphabetisch = chronologisch
    blobs.sort((a, b) => b.key.localeCompare(a.key));
    const entries = [];
    for (const b of blobs) {
      const ts = new Date(b.key.slice(2, 26)).getTime();
      if (ts && ts < cutoff) {
        try { await s.delete(b.key); } catch (e) {}
        continue;
      }
      if (entries.length >= 200 || (ts && ts < since)) continue;
      const rec = await s.get(b.key, { type: 'json' });
      if (rec) entries.push(rec);
    }
    return json(200, { entries, days });
  } catch (e) {
    return json(500, { error: 'read_failed', detail: String((e && e.message) || e) });
  }
};
