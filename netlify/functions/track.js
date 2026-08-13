/**
 * track.js
 * ----------------------------------------------------------------------------
 * Anonyme, Cookie-freie Statistik (DSGVO-freundlich).
 *
 * Es werden AUSSCHLIESSLICH aggregierte Tages-Zähler gespeichert:
 *   { "pageview": 123, "add_to_cart": 45, ... }
 * KEINE IP-Adressen, KEINE Cookies, KEINE User-IDs, KEIN Fingerprinting.
 *
 *   POST /track            Body: { event }          → Zähler +1 (öffentlich)
 *   GET  /track?days=7&password=...                 → Auswertung (nur Admin)
 *
 * Benötigte Environment Variable: ADMIN_PASSWORD (wie shop-status.js)
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'analytics';

// Nur diese Events werden gezählt (Whitelist gegen Müll-Daten)
const ALLOWED_EVENTS = [
  'pageview',
  'add_to_cart',
  'checkout_details',
  'order_success',
  'sig_add',        // Best-of-3: In den Warenkorb
  'fab_open',       // Mobiler Warenkorb-Pill angetippt
  'push_enabled',   // Benachrichtigungen aktiviert
  'voucher_sent',   // Retargeting-Gutschein versendet (serverseitig)
  'voucher_redeemed', // Gutschein eingelöst (serverseitig)
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(statusCode, data) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS },
    body: JSON.stringify(data),
  };
}

function store() {
  const opts = { name: STORE_NAME, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

// Lokales Datum in Deutschland (Zähl-Tag)
function dayKey(offset = 0) {
  const now = new Date(Date.now() - offset * 86400000);
  const de = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(now);
  return de; // YYYY-MM-DD
}


// --- Team-Auth: superadmin (ADMIN_PASSWORD) oder Team-Admin (Team-Store) ---
const _teamCrypto = require('crypto');
function _teamStore() {
  const opts = { name: 'team', consistency: 'strong' };
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
    const t = _teamStore();
    const { blobs } = await t.list({ prefix: 'u:' });
    const h = _teamCrypto.createHash('sha256').update(String(pw)).digest('hex');
    for (const b of blobs) {
      const u = await t.get(b.key, { type: 'json' });
      if (u && u.pwHash === h) return u.role === 'admin';
    }
  } catch (e) {}
  return false;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // ---------- Zählen (öffentlich, anonym) ----------
  if (event.httpMethod === 'POST') {
    let name = '';
    try { name = (JSON.parse(event.body || '{}').event || '').toString(); } catch (e) {}
    if (!ALLOWED_EVENTS.includes(name)) return json(204, {});
    try {
      const s = store();
      const key = 'day:' + dayKey();
      const data = (await s.get(key, { type: 'json' })) || {};
      data[name] = (data[name] || 0) + 1;
      await s.setJSON(key, data);
    } catch (e) {
      // Statistik darf NIE die Seite stören → Fehler still schlucken
    }
    return json(204, {});
  }

  // ---------- Auswertung (nur Admin) ----------
  if (event.httpMethod === 'GET') {
    const params = event.queryStringParameters || {};
    if (!(await authAdmin(params.password))) return json(401, { error: 'unauthorized' });
    const days = Math.min(parseInt(params.days || '7', 10) || 7, 30);
    try {
      const s = store();
      const out = [];
      for (let i = 0; i < days; i++) {
        const key = dayKey(i);
        const data = (await s.get('day:' + key, { type: 'json' })) || {};
        out.push({ date: key, ...data });
      }
      return json(200, { days: out, events: ALLOWED_EVENTS });
    } catch (e) {
      return json(500, { error: 'read_failed', detail: String((e && e.message) || e) });
    }
  }

  return json(405, { error: 'method_not_allowed' });
};
