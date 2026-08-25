/**
 * lib/wallet-push.js
 * ----------------------------------------------------------------------------
 * Sagt iOS Bescheid, dass sich eine Wallet-Karte geaendert hat.
 *
 * Ablauf der Live-Aktualisierung: Nach jeder Treue-Aenderung schicken wir an
 * alle registrierten Geraete des Kunden einen LEEREN Apple-Push (Thema =
 * Pass-Typ-ID). iOS holt sich daraufhin selbst den frischen Pass ueber
 * wallet-api.js. Der Push transportiert also keine Daten - er ist nur die
 * Klingel.
 *
 * Zugang: derselbe APNs-Schluessel (.p8), der auch fuer Firebase hinterlegt
 * wurde - als Netlify-Variablen APPLE_APNS_KEY_B64 + APPLE_APNS_KEY_ID.
 * Signatur ES256 mit Node-crypto, Versand ueber Node http2 (Apples API
 * spricht nur HTTP/2). Fehlt etwas davon: stiller Ausstieg - die Karte
 * aktualisiert sich dann eben erst beim naechsten manuellen Hinzufuegen.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

/* APNs-Schluessel (.p8): wie der Pass-Schluessel im Blobs-Store "geheim"
   ('apple-apns-key'), Env APPLE_APNS_KEY_B64 als Vorrang fuer lokale Tests. */
let apnsKeyCache = null;
async function ladeApnsKey() {
  if (apnsKeyCache) return true;
  if (process.env.APPLE_APNS_KEY_B64) {
    apnsKeyCache = Buffer.from(process.env.APPLE_APNS_KEY_B64, 'base64').toString('utf8');
    return true;
  }
  const pem = await require('./geheim').holeGeheim('apple-apns-key');
  if (pem && pem.includes('PRIVATE KEY')) { apnsKeyCache = pem; return true; }
  return false;
}
function apnsKonfiguriert() {
  return !!process.env.APPLE_APNS_KEY_ID;
}

const b64u = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* APNs-Anmelde-JWT (ES256), ~50 Min wiederverwendet (Apple erlaubt bis 60). */
let jwtCache = { wert: null, ablauf: 0 };
function apnsJwt() {
  if (jwtCache.wert && Date.now() < jwtCache.ablauf) return jwtCache.wert;
  const key = apnsKeyCache;
  const teamId = process.env.APPLE_TEAM_ID || '99R8K7386U';
  const kopf = b64u({ alg: 'ES256', kid: process.env.APPLE_APNS_KEY_ID });
  const daten = b64u({ iss: teamId, iat: Math.floor(Date.now() / 1000) });
  const sig = crypto.sign('sha256', Buffer.from(kopf + '.' + daten),
    { key, dsaEncoding: 'ieee-p1363' })
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  jwtCache = { wert: kopf + '.' + daten + '.' + sig, ablauf: Date.now() + 50 * 60 * 1000 };
  return jwtCache.wert;
}

/* Ein leerer Push an ein Geraet; loest Status als Zahl ein. */
function sendeApns(pushToken, topic) {
  const http2 = require('http2');
  return new Promise((resolve) => {
    const client = http2.connect('https://api.push.apple.com');
    const zu = (status) => { try { client.close(); } catch (e) {} resolve(status); };
    client.on('error', () => zu(0));
    const req = client.request({
      ':method': 'POST',
      ':path': '/3/device/' + pushToken,
      authorization: 'bearer ' + apnsJwt(),
      'apns-topic': topic,
      'apns-push-type': 'background',
      'content-type': 'application/json',
    });
    let status = 0;
    req.on('response', (h) => { status = h[':status'] || 0; });
    req.on('close', () => zu(status));
    req.on('error', () => zu(0));
    req.setTimeout(4000, () => { try { req.close(); } catch (e) {} zu(0); });
    req.end('{}');
  });
}

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

/**
 * Alle Geraete anstupsen, die die Karte dieses Kunden im Wallet haben.
 * Wirft nie - eine kaputte Wallet-Klingel darf keine Bestellung stoppen.
 * @param emailHash sha256(email) hex
 */
async function stupseWalletAn(emailHash) {
  try {
    if (!apnsKonfiguriert() || !(await ladeApnsKey())) return { ok: false, grund: 'nicht_eingerichtet' };
    let applePass;
    try { applePass = require('./apple-pass'); } catch (e) { return { ok: false, grund: 'lib' }; }
    if (!applePass.konfiguriert()) return { ok: false, grund: 'nicht_eingerichtet' };

    const serial = applePass.serialFuer(emailHash);
    const s = store('wallet');
    const { blobs } = await s.list({ prefix: 'reg:' + serial + ':' });
    if (!blobs.length) return { ok: true, gesendet: 0 };

    let gesendet = 0;
    for (const b of blobs) {
      const reg = await s.get(b.key, { type: 'json' });
      if (!reg || !reg.pushToken) continue;
      const status = await sendeApns(reg.pushToken, applePass.passTypeId());
      if (status === 200) gesendet++;
      // 410 = Token tot (Pass geloescht, Geraet weg) -> Registrierung aufraeumen
      if (status === 410 || status === 400) {
        try {
          await s.delete(b.key);
          const geraet = b.key.slice(('reg:' + serial + ':').length);
          await s.delete('devreg:' + geraet + ':' + serial);
        } catch (e) {}
      }
    }
    return { ok: true, gesendet };
  } catch (e) {
    console.error('wallet-push:', e.message);
    return { ok: false, grund: String(e.message).slice(0, 120) };
  }
}

module.exports = { stupseWalletAn };
