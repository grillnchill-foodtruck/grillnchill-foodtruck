/**
 * push-send.js
 * ----------------------------------------------------------------------------
 * Push-Benachrichtigungen an alle Abonnenten (nur Admin): sofort senden oder
 * planen. Geplante Nachrichten lassen sich bis zum Versand ändern (lib/push-plan.js,
 * Versand durch den Zeitplan push-plan-lauf.js alle 5 Minuten).
 *
 *   POST /push-send   Body: { password, title, body, url?, ziel? }        sofort senden
 *                     { password, action: 'planen', title, body, ziel, sendAt }
 *                     { password, action: 'liste' }
 *                     { password, action: 'aendern', id, stand, title, body, ziel, sendAt }
 *                     { password, action: 'streichen' | 'zurueckholen' | 'jetzt', id }
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

const { getStore } = require('@netlify/blobs');
const versand = require('./lib/push-versand');
const plan = require('./lib/push-plan');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(statusCode, data) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(data) };
}


// --- Team-Auth: superadmin (ADMIN_PASSWORD) oder Team-Admin (Team-Store) ---
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung } = require('./lib/admin-sitzung');
const { mitglied } = require('./lib/team-passwort');
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
    const { u } = (await mitglied(t, pw, blobs)) || {};
    if (u) return u.role === 'admin' ? { role: 'admin', name: u.name || '?' } : null;
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
  const who = await authAdmin(await passwortAusSitzung(body.password));
  await meldeErgebnis(event, !!who);
  if (!who) return json(401, { error: 'unauthorized' });

  // ---- Geplante Nachrichten ------------------------------------------------
  const antwort = (r) => (r.status === 200
    ? json(200, { ok: true, eintrag: r.eintrag })
    : json(r.status, { error: r.fehler, hint: r.hint, eintrag: r.eintrag || null }));
  const id = String(body.id || '');
  try {
    switch (body.action) {
      case 'liste': return json(200, { ok: true, jetzt: new Date().toISOString(), ...(await plan.liste()) });
      case 'planen': return antwort(await plan.anlegen(body, who));
      case 'aendern': return antwort(await plan.aendern(id, body, who, String(body.stand || '')));
      case 'streichen': return antwort(await plan.streichen(id, who));
      case 'zurueckholen': return antwort(await plan.zurueckholen(id, who));
      case 'jetzt': return antwort(await plan.jetztSenden(id, who));
      default: break;
    }
  } catch (e) {
    console.error('push-plan:', (e && e.message) || e);
    return json(500, { error: 'plan_failed', detail: String((e && e.message) || e).slice(0, 200) });
  }
  if (body.action && body.action !== 'senden') return json(400, { error: 'bad_action' });

  // ---- Sofort senden -------------------------------------------------------
  const n = versand.nachricht(body);
  try {
    const d = await versand.versenden(n);
    const zielText = { alle: 'alle', app: 'nur App', web: 'nur Browser' }[d.ziel];
    await auditLog(who, 'Push', '„' + String(n.title).slice(0, 60) + '“ (' + zielText + ') an ' + d.sent + ' Abonnenten gesendet'
      + (d.ios === 'gesendet' ? ' + iOS-App' : ''));
    return json(200, { ok: true, ...d });
  } catch (e) {
    if (e && e.code === 'vapid_not_configured') return json(500, { error: 'vapid_not_configured' });
    return json(500, { error: 'send_failed', detail: String((e && e.message) || e) });
  }
};
