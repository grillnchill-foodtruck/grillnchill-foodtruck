/**
 * push-send.js
 * ----------------------------------------------------------------------------
 * Versendet eine Push-Benachrichtigung an ALLE Abonnenten (nur Admin).
 *
 *   POST /push-send   Body: { password, title, body, url? }
 *
 * Benötigte Environment Variablen:
 *   ADMIN_PASSWORD        (wie shop-status.js)
 *   VAPID_PUBLIC_KEY      (siehe PUSH-SETUP.md)
 *   VAPID_PRIVATE_KEY
 *   VAPID_SUBJECT         z. B. mailto:info@grillnchill-foodtruck.de
 *
 * Abgelaufene/ungültige Abos (410/404) werden automatisch aufgeräumt.
 * ----------------------------------------------------------------------------
 */

const webpush = require('web-push');
const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'push-subs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(statusCode, data) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(data) };
}

function store() {
  const opts = { name: STORE_NAME, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}


// --- Team-Auth: superadmin (ADMIN_PASSWORD) oder Team-Admin (Team-Store) ---
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
async function authAdmin(pw) {
  if (!pw) return null;
  const admin = process.env.ADMIN_PASSWORD || '';
  if (admin && pw === admin) return { role: 'superadmin', name: 'Kubi' };
  try {
    const t = _teamStore();
    const { blobs } = await t.list({ prefix: 'u:' });
    const h = _teamCrypto.createHash('sha256').update(String(pw)).digest('hex');
    for (const b of blobs) {
      const u = await t.get(b.key, { type: 'json' });
      if (u && u.pwHash === h) return u.role === 'admin' ? { role: 'admin', name: u.name || '?' } : null;
    }
  } catch (e) {}
  return null;
}
// --- Änderungs-Protokoll (Store: audit) – best effort, blockiert nie ---
async function auditLog(who, action, detail) {
  try {
    const opts = { name: 'audit', consistency: 'strong' };
    if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
      opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
      opts.token = process.env.NETLIFY_BLOBS_TOKEN;
    }
    const s = getStore(opts);
    const key = 'a:' + new Date().toISOString() + '_' + Math.random().toString(36).slice(2, 7);
    await s.setJSON(key, {
      at: new Date().toISOString(),
      name: (who && who.name) || '?',
      role: (who && who.role) || '?',
      action,
      detail: String(detail || '').slice(0, 300),
    });
  } catch (e) {}
}


exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}

  // Bremse gegen Durchprobieren – siehe lib/auth-guard.js
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;
  const who = await authAdmin(body.password);
  await meldeErgebnis(event, !!who);
  if (!who) return json(401, { error: 'unauthorized' });

  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:info@grillnchill-foodtruck.de';
  if (!pub || !priv) return json(500, { error: 'vapid_not_configured' });
  webpush.setVapidDetails(subject, pub, priv);

  const payload = JSON.stringify({
    title: (body.title || 'Grilln Chill').toString().slice(0, 80),
    body: (body.body || '').toString().slice(0, 200),
    url: (body.url || '/').toString().slice(0, 200),
  });

  try {
    const s = store();
    const { blobs } = await s.list({ prefix: 'sub:' });
    let sent = 0, removed = 0, failed = 0;
    for (const b of blobs) {
      const sub = await s.get(b.key, { type: 'json' });
      if (!sub) continue;
      try {
        await webpush.sendNotification(sub, payload, { TTL: 3600 });
        sent++;
      } catch (err) {
        const code = err && err.statusCode;
        if (code === 404 || code === 410) { await s.delete(b.key); removed++; }
        else failed++;
      }
    }
    await auditLog(who, 'Push', '„' + String(body.title || '').slice(0, 60) + '“ an ' + sent + ' Abonnenten gesendet');
    return json(200, { ok: true, sent, removed, failed, total: blobs.length });
  } catch (e) {
    return json(500, { error: 'send_failed', detail: String((e && e.message) || e) });
  }
};
