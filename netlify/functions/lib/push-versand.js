/**
 * lib/push-versand.js
 * ----------------------------------------------------------------------------
 * Rundruf an die Push-Abonnenten (Web-Push über VAPID plus iOS-App über das
 * FCM-Thema „alle“). Benutzt von push-send.js (sofort senden) und vom
 * Zeitplan push-plan-lauf.js (geplante Nachrichten, lib/push-plan.js).
 *
 * Abgelaufene oder ungültige Web-Abos (404/410) werden dabei gelöscht.
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');

const TITEL_MAX = 80, TEXT_MAX = 200, URL_MAX = 200;
const ZIELE = ['alle', 'app', 'web'];

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

/** Eingaben auf die erlaubten Längen und Werte bringen */
function nachricht(e) {
  const x = e || {};
  return {
    title: String(x.title || 'Grilln Chill').trim().slice(0, TITEL_MAX),
    body: String(x.body || '').trim().slice(0, TEXT_MAX),
    url: String(x.url || '/').trim().slice(0, URL_MAX) || '/',
    ziel: ZIELE.includes(x.ziel) ? x.ziel : 'alle',
  };
}

/**
 * Schickt eine Nachricht an alle passenden Abonnenten.
 * @param n      { title, body, url, ziel }
 * @param deps   für Tests: { holeStore, webpush, sendeAnIOS }
 * @returns {{ ziel, sent, removed, failed, uebersprungen, total, ios }}
 * @throws  Error mit code 'vapid_not_configured', wenn die Schlüssel fehlen
 *          (dann ist nachweislich nichts rausgegangen)
 */
async function versenden(n, deps = {}) {
  const m = nachricht(n);
  const webpush = deps.webpush || require('web-push');
  const sendeAnIOS = deps.sendeAnIOS || require('./fcm').sendeAnIOS;
  const holeStore = deps.holeStore || store;

  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) { const e = new Error('vapid_not_configured'); e.code = 'vapid_not_configured'; throw e; }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:info@grillnchill-foodtruck.de', pub, priv);

  const payload = JSON.stringify({ title: m.title, body: m.body, url: m.url });
  const s = holeStore('push-subs');
  const { blobs } = await s.list({ prefix: 'sub:' });
  let sent = 0, removed = 0, failed = 0, uebersprungen = 0;
  for (const b of blobs) {
    const sub = await s.get(b.key, { type: 'json' });
    if (!sub) continue;
    const istApp = !!sub.app;
    if ((m.ziel === 'app' && !istApp) || (m.ziel === 'web' && istApp)) { uebersprungen++; continue; }
    try {
      await webpush.sendNotification(sub, payload, { TTL: 3600 });
      sent++;
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) { await s.delete(b.key); removed++; }
      else failed++;
    }
  }
  // Zusätzlich an die iOS-App (FCM-Thema „alle“). Ohne eingerichtetes
  // Dienstkonto bleibt es beim Web-Push.
  const ios = m.ziel === 'web'
    ? { ok: false, grund: 'übersprungen (nur Browser)' }
    : await sendeAnIOS(m.title, m.body, m.url);

  return { ziel: m.ziel, sent, removed, failed, uebersprungen, total: blobs.length, ios: ios.ok ? 'gesendet' : ios.grund };
}

module.exports = { versenden, nachricht, store, ZIELE, TITEL_MAX, TEXT_MAX };
