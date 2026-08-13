/**
 * push-subscribe.js
 * ----------------------------------------------------------------------------
 * Speichert Web-Push-Abos in Netlify Blobs (Store: push-subs).
 *
 *   POST /push-subscribe    Body: { subscription }   → Abo speichern
 *   DELETE /push-subscribe  Body: { endpoint }       → Abo löschen
 *
 * Es wird ausschließlich das technische Push-Abo (Endpoint + Schlüssel)
 * gespeichert – keine Namen, keine E-Mails, keine IPs.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'push-subs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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

const keyFor = (endpoint) => 'sub:' + crypto.createHash('sha256').update(endpoint).digest('hex');


// --- Team-Auth für den Bestell-Alarm-Kanal (admin oder staff) ---
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
    const h = crypto.createHash('sha256').update(String(pw)).digest('hex');
    for (const b of blobs) {
      const u = await t.get(b.key, { type: 'json' });
      if (u && u.pwHash === h) return { role: u.role === 'admin' ? 'admin' : 'staff', name: u.name || b.key.slice(2) };
    }
  } catch (e) {}
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  // GET: liefert den öffentlichen VAPID-Schlüssel (fürs Frontend-Abo)
  if (event.httpMethod === 'GET') {
    return json(200, { publicKey: process.env.VAPID_PUBLIC_KEY || null });
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}

  try {
    if (event.httpMethod === 'POST') {
      const sub = body.subscription;
      if (!sub || !sub.endpoint || !sub.keys) return json(400, { error: 'invalid_subscription' });
      if (body.channel === 'admin') {
        // Bestell-Alarm: nur für eingeloggte Team-Mitglieder
        const who = await authRole(body.password);
        if (!who) return json(401, { error: 'unauthorized' });
        await store().setJSON('admin:' + crypto.createHash('sha256').update(sub.endpoint).digest('hex'),
          { ...sub, name: who.name, addedAt: new Date().toISOString() });
        return json(200, { ok: true, channel: 'admin' });
      }
      await store().setJSON(keyFor(sub.endpoint), { ...sub, addedAt: new Date().toISOString() });
      return json(200, { ok: true });
    }
    if (event.httpMethod === 'DELETE') {
      if (!body.endpoint) return json(400, { error: 'missing_endpoint' });
      if (body.channel === 'admin') {
        await store().delete('admin:' + crypto.createHash('sha256').update(body.endpoint).digest('hex'));
        return json(200, { ok: true, channel: 'admin' });
      }
      await store().delete(keyFor(body.endpoint));
      return json(200, { ok: true });
    }
  } catch (e) {
    return json(500, { error: 'storage_failed', detail: String((e && e.message) || e) });
  }
  return json(405, { error: 'method_not_allowed' });
};
