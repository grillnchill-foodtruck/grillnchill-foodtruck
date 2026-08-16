/**
 * catering-list.js
 * ----------------------------------------------------------------------------
 * Catering-Anfragen fürs Admin-Tool (Tab "Catering").
 * Die Anfragen werden von send-email.js (type catering_request) im Blob-Store
 * "catering" abgelegt – als Sicherheitsnetz zusätzlich zur E-Mail.
 *
 *   GET  /.netlify/functions/catering-list?password=...&days=180
 *   → { requests: [ { key, name, email, phone, date, guests, location,
 *                     package, msg, receivedAt, emailSent, done } ] }
 *
 *   POST /.netlify/functions/catering-list
 *   Body: { password, key, action: 'done' | 'undone' | 'delete' }
 *
 * Aufbewahrung: 365 Tage (ältere Einträge werden beim Listen entfernt).
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify(data),
});

function store() {
  const opts = { name: 'catering', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

// --- Team-Auth: admin (ADMIN_PASSWORD) oder staff (Team-Store, siehe team.js) ---
const _teamCrypto = require('crypto');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung } = require('./lib/admin-sitzung');
function _teamStore() {
  const opts = { name: 'team', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}
async function authRole(pw) {
  if (!pw) return null;
  const admin = process.env.ADMIN_PASSWORD || '';
  if (admin && pw === admin) return { role: 'admin', name: 'Kubi' };
  try {
    const t = _teamStore();
    const { blobs } = await t.list({ prefix: 'u:' });
    const h = _teamCrypto.createHash('sha256').update(String(pw)).digest('hex');
    for (const b of blobs) {
      const u = await t.get(b.key, { type: 'json' });
      if (u && u.pwHash === h) return { role: u.role === 'admin' ? 'admin' : 'staff', name: u.name || b.key.slice(2) };
    }
  } catch (e) {}
  return null;
}

const RETENTION_MS = 365 * 86400000;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  if (event.httpMethod === 'GET') {
    const p = event.queryStringParameters || {};
    // Bremse gegen Durchprobieren – siehe lib/auth-guard.js
    const gesperrt = await pruefeSperre(event);
    if (gesperrt) return gesperrt;
    const who = await authRole(await passwortAusSitzung(p.password));
    await meldeErgebnis(event, !!who);
    if (!who) return json(401, { error: 'unauthorized' });

    const days = Math.min(parseInt(p.days || '180', 10) || 180, 365);
    const since = Date.now() - days * 86400000;

    try {
      const s = store();
      const { blobs } = await s.list({ prefix: 'c:' });
      const out = [];
      for (const b of blobs) {
        const rec = await s.get(b.key, { type: 'json' });
        if (!rec) continue;
        const ts = new Date(rec.receivedAt || 0).getTime();
        // Aufräumen: alles über der Aufbewahrungsfrist löschen (DSGVO)
        if (ts < Date.now() - RETENTION_MS) { try { await s.delete(b.key); } catch (e) {} continue; }
        if (ts < since) continue;
        out.push({ key: b.key, ...rec });
      }
      out.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
      return json(200, { requests: out });
    } catch (e) {
      return json(500, { error: 'list_failed', detail: e.message });
    }
  }

  if (event.httpMethod === 'POST') {
    let input;
    try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad_json' }); }
    // Bremse gegen Durchprobieren – siehe lib/auth-guard.js
    const gesperrt = await pruefeSperre(event);
    if (gesperrt) return gesperrt;
    const who = await authRole(await passwortAusSitzung(input.password));
    await meldeErgebnis(event, !!who);
    if (!who) return json(401, { error: 'unauthorized' });
    const key = String(input.key || '');
    if (!key.startsWith('c:')) return json(400, { error: 'bad_key' });

    try {
      const s = store();
      if (input.action === 'delete') {
        await s.delete(key);
        return json(200, { ok: true });
      }
      const rec = await s.get(key, { type: 'json' });
      if (!rec) return json(404, { error: 'not_found' });
      if (input.action === 'done') rec.done = true;
      else if (input.action === 'undone') rec.done = false;
      else return json(400, { error: 'bad_action' });
      await s.setJSON(key, rec);
      return json(200, { ok: true, done: rec.done });
    } catch (e) {
      return json(500, { error: 'update_failed', detail: e.message });
    }
  }

  return json(405, { error: 'method_not_allowed' });
};
