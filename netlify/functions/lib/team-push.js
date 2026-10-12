/**
 * lib/team-push.js
 * ----------------------------------------------------------------------------
 * Web-Push an alle Team-Geraete (Kanal admin:), z. B. "Gast ist da".
 *
 * Logik wie der Bestell-Alarm in send-email.js (sendOrderAlertPush):
 * VAPID setzen, alle Abos mit Praefix 'admin:' holen, parallel senden,
 * abgelaufene Abos (404/410) loeschen.
 *
 * Wo die Abos liegen: push-subscribe.js legt den Kanal admin: im Store
 * "push-subs" ab, aeltere Abos koennen im Store "push" liegen. Wir lesen
 * beide und senden je Endpoint nur einmal. Auch der Bestell-Alarm in
 * send-email.js laeuft seit Build 7 hierueber.
 *
 *   await sendeTeamPush({ title, body, url, ttl })
 *   -> { gesendet, fehler }   wirft nie
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');

const STORES = ['push-subs', 'push'];

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

async function sendeTeamPush({ title, body, url, ttl } = {}) {
  let gesendet = 0, fehler = 0;
  try {
    const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
    if (!pub || !priv) return { gesendet, fehler, grund: 'nicht_eingerichtet' };
    const webpush = require('web-push');
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:info@grillnchill-foodtruck.de', pub, priv);

    // Ziele sammeln, je Endpoint nur einmal
    const ziele = [];
    const gesehen = new Set();
    for (const name of STORES) {
      try {
        const s = store(name);
        const { blobs } = await s.list({ prefix: 'admin:' });
        for (const b of blobs) {
          const sub = await s.get(b.key, { type: 'json' });
          if (!sub || !sub.endpoint || gesehen.has(sub.endpoint)) continue;
          gesehen.add(sub.endpoint);
          ziele.push({ s, key: b.key, sub });
        }
      } catch (e) {}
    }
    if (!ziele.length) return { gesendet, fehler };

    const payload = JSON.stringify({
      title: String(title || '').slice(0, 80),
      body: String(body || '').slice(0, 200),
      url: url || '/admin.html?tab=orders',
    });
    await Promise.all(ziele.map(async ({ s, key, sub }) => {
      try {
        await webpush.sendNotification(sub, payload, { TTL: ttl || 900 });
        gesendet++;
      } catch (err) {
        fehler++;
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          try { await s.delete(key); } catch (e2) {}
        }
      }
    }));
  } catch (e) {
    console.error('team-push:', e && e.message);
  }
  return { gesendet, fehler };
}

module.exports = { sendeTeamPush };
