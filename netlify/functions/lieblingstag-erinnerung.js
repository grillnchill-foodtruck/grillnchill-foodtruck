/**
 * lieblingstag-erinnerung.js
 * ----------------------------------------------------------------------------
 * Zeitplan alle 15 Minuten (netlify.toml): schickt fällige Erinnerungen zum
 * Lieblingstag (Regeln in lib/lieblingstag.js). Liest nur das Verzeichnis
 * der Eingeschalteten (Store "lieblingstag"), nicht alle Kunden.
 *
 * Web-Push an die hinterlegten Browser-Abos, in der iOS-App über das
 * persönliche FCM-Thema. Abgelaufene Web-Abos (404/410) fliegen raus.
 * ----------------------------------------------------------------------------
 */
const { getStore } = require('@netlify/blobs');
const { faellig, nachricht } = require('./lib/lieblingstag');

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

/**
 * @param deps  für Tests: { holeStore, webpush, sendeAnThema, jetzt }
 */
async function lauf(deps = {}) {
  const holeStore = deps.holeStore || store;
  const jetzt = deps.jetzt || new Date();
  const ende = Date.now() + (deps.budgetMs || 20000);
  const ergebnis = { geprueft: 0, gesendet: 0, web: 0, ios: 0, entfernt: 0, fehler: 0 };

  let status = null;
  try { status = await holeStore('shop-status').get('status', { type: 'json' }); } catch (e) {}

  let webpush = deps.webpush;
  if (!webpush && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush = require('web-push');
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:info@grillnchill-foodtruck.de',
      process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
  }
  const sendeAnThema = deps.sendeAnThema || require('./lib/fcm').sendeAnThema;

  const verzeichnis = holeStore('lieblingstag');
  const kunden = holeStore('customers');
  let liste = [];
  try { liste = (await verzeichnis.list()).blobs || []; } catch (e) { return ergebnis; }

  for (const b of liste) {
    if (Date.now() > ende) break;
    ergebnis.geprueft++;
    try {
      const rec = await kunden.get(b.key, { type: 'json' });
      if (!rec || !rec.lieblingstag || !rec.lieblingstag.an) { await verzeichnis.delete(b.key); continue; }
      const f = faellig(rec, jetzt, status);
      if (!f.ja) continue;
      const lt = rec.lieblingstag;
      const n = nachricht(lt.lang, f.fav);
      let zugestellt = false;

      if (webpush && Array.isArray(lt.web)) {
        const bleiben = [];
        for (const sub of lt.web) {
          try {
            await webpush.sendNotification(sub, JSON.stringify(n), { TTL: 1800 });
            zugestellt = true; ergebnis.web++;
            bleiben.push(sub);
          } catch (err) {
            const code = err && err.statusCode;
            if (code === 404 || code === 410) ergebnis.entfernt++;
            else { bleiben.push(sub); ergebnis.fehler++; }
          }
        }
        lt.web = bleiben;
      }
      if (lt.thema) {
        const r = await sendeAnThema(lt.thema, n.title, n.body, n.url);
        if (r && r.ok) { zugestellt = true; ergebnis.ios++; } else ergebnis.fehler++;
      }

      // Auch ohne Zustellung als erledigt merken: sonst versucht jeder Lauf es erneut
      lt.zuletzt = jetzt.toISOString();
      if (!(Array.isArray(lt.web) && lt.web.length) && !lt.thema) { delete rec.lieblingstag; await verzeichnis.delete(b.key); }
      await kunden.setJSON(b.key, rec);
      if (zugestellt) ergebnis.gesendet++;
    } catch (e) {
      ergebnis.fehler++;
      console.error('lieblingstag-erinnerung:', e.message);
    }
  }
  return ergebnis;
}

exports.handler = async () => {
  const r = await lauf();
  console.log('lieblingstag-erinnerung:', JSON.stringify(r));
  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
exports.lauf = lauf;
