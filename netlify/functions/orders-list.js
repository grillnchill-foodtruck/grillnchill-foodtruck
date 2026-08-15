/**
 * orders-list.js
 * ----------------------------------------------------------------------------
 * Bestell-Archiv fürs Admin-Tool (Tab "Bestellungen").
 *
 *   GET /.netlify/functions/orders-list?password=...&days=30
 *   → { orders: [ { reference, status, createdAt, completedAt, order:{...} } ] }
 *
 * status: completed (abgeschlossen & benachrichtigt) · pending (Online-Zahlung
 * offen, wird alle 15 Min. abgeglichen) · abandoned (Zahlungsabbruch).
 * Aufbewahrung: 90 Tage (Aufräumen in orders-reconcile.js).
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');

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

function store() {
  const opts = { name: 'orders', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}


// --- Team-Auth: admin (ADMIN_PASSWORD) oder staff (Team-Store, siehe team.js) ---
const _teamCrypto = require('crypto');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
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

  const days = Math.min(parseInt(p.days || '30', 10) || 30, 90);
  const since = Date.now() - days * 86400000;

  try {
    const s = store();
    const { blobs } = await s.list({ prefix: 'o:' });
    const out = [];
    for (const b of blobs) {
      if (out.length >= 400) break;
      const rec = await s.get(b.key, { type: 'json' });
      if (!rec) continue;
      // Stornierte Vorgänge (Rückzieher im Zahlungsfenster, Supersede, Admin-Storno)
      // bleiben unsichtbar – sie existieren nur noch als Sicherheitsnetz für den
      // Webhook (Zahlung schlägt Storno) und werden nach 14 Tagen aufgeräumt.
      if (rec.status === 'cancelled') continue;
      if (rec.kind === 'giftcard') continue; // Gutschein-Käufe: eigener Bereich im Gutschein-Tab
      const ts = new Date(rec.completedAt || rec.createdAt || 0).getTime();
      if (ts < since) continue;
      out.push({
        reference: (rec.order && rec.order.reference) || b.key.slice(2),
        status: rec.status || 'completed',
        fstate: rec.fstate || null,
        createdAt: rec.createdAt || null,
        completedAt: rec.completedAt || null,
        payStatus: rec.payStatus || null,
        order: rec.order || null,
      });
    }
    out.sort((a, b2) => new Date(b2.completedAt || b2.createdAt) - new Date(a.completedAt || a.createdAt));
    return json(200, { orders: out, days });
  } catch (e) {
    return json(500, { error: 'read_failed', detail: String((e && e.message) || e) });
  }
};
