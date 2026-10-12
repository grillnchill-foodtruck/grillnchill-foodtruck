/**
 * lib/apns.js
 * ----------------------------------------------------------------------------
 * Gemeinsamer Versand an Apples Push-Dienst (APNs).
 *
 * Genutzt von:
 *   lib/wallet-push.js   leerer Push an Wallet-Karten (nur Produktion)
 *   order-status.js      Live-Activity-Updates fuer die Bestellung in der App
 *
 *   const { sendeApns } = require('./lib/apns');
 *   const r = await sendeApns({ token, topic, pushType, payload, priority,
 *                               expiration, collapseId });
 *   // r = { ok, status, reason, sandbox }
 *
 * Zugang: der APNs-Schluessel (.p8) - Env APPLE_APNS_KEY_B64 hat Vorrang
 * (lokale Tests), sonst Blobs-Store "geheim" unter 'apple-apns-key'. Dazu
 * APPLE_APNS_KEY_ID und optional APPLE_TEAM_ID. Signatur ES256 mit
 * Node-crypto, Versand ueber http2 (Apples API spricht nur HTTP/2).
 *
 * Produktion oder Sandbox: Ein Token aus einem Entwickler-Build kennt nur
 * der Sandbox-Host, ein Token aus TestFlight/App Store nur der Produktions-
 * Host. Wir versuchen zuerst die Produktion. Meldet sie 400 BadDeviceToken,
 * folgt ein zweiter Versuch ueber api.sandbox.push.apple.com. Welcher Host
 * je Token geklappt hat, merkt sich die Instanz in einer kleinen Tabelle,
 * damit der naechste Push gleich richtig landet.
 *
 * Wirft nie. Fehlt die Einrichtung, kommt { ok:false, reason:'nicht_eingerichtet' }.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');

const HOST_PROD = 'https://api.push.apple.com';
const HOST_SANDBOX = 'https://api.sandbox.push.apple.com';
const TIMEOUT_MS = 4000;

/* ---------- Schluessel ---------- */
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

/* APNs-Anmelde-JWT (ES256), ~50 Min wiederverwendet (Apple erlaubt bis 60).
   Derselbe JWT gilt fuer Produktion und Sandbox. */
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

/* ---------- Welcher Host je Token (nur im Speicher dieser Instanz) ---------- */
const HOST_MERKER_MAX = 500;
const hostMerker = new Map();   // token -> 'prod' | 'sandbox'
function merkeHost(token, art) {
  if (hostMerker.has(token)) hostMerker.delete(token);
  hostMerker.set(token, art);
  if (hostMerker.size > HOST_MERKER_MAX) {
    const aeltester = hostMerker.keys().next().value;
    hostMerker.delete(aeltester);
  }
}

/* Ein Versuch an genau einem Host. Loest { status, reason } ein, nie reject.
   Der JWT kommt fertig mit, damit ein kaputter Schluessel gar nicht erst
   eine Verbindung oeffnet. */
function einVersuch(host, opts, jwt) {
  const http2 = require('http2');
  return new Promise((resolve) => {
    let fertig = false;
    let client;
    const zu = (status, reason) => {
      if (fertig) return;
      fertig = true;
      try { client && client.close(); } catch (e) {}
      resolve({ status: status || 0, reason: reason || '' });
    };
    try {
      client = http2.connect(host);
    } catch (e) {
      zu(0, 'connect');
      return;
    }
    client.on('error', () => zu(0, 'connect'));

    const kopf = {
      ':method': 'POST',
      ':path': '/3/device/' + opts.token,
      authorization: 'bearer ' + jwt,
      'apns-topic': opts.topic,
      'content-type': 'application/json',
    };
    if (opts.pushType) kopf['apns-push-type'] = opts.pushType;
    if (opts.priority != null) kopf['apns-priority'] = String(opts.priority);
    if (opts.expiration != null) kopf['apns-expiration'] = String(opts.expiration);
    if (opts.collapseId) kopf['apns-collapse-id'] = String(opts.collapseId).slice(0, 64);

    let req;
    try {
      req = client.request(kopf);
    } catch (e) {
      zu(0, 'request');
      return;
    }
    let status = 0;
    let antwort = '';
    req.setEncoding('utf8');
    req.on('response', (h) => { status = h[':status'] || 0; });
    req.on('data', (c) => { if (antwort.length < 2000) antwort += c; });
    req.on('end', () => {
      let reason = '';
      try { reason = (JSON.parse(antwort || '{}').reason) || ''; } catch (e) {}
      zu(status, reason);
    });
    req.on('close', () => zu(status, ''));
    req.on('error', () => zu(0, 'request'));
    req.setTimeout(TIMEOUT_MS, () => { try { req.close(); } catch (e) {} zu(0, 'timeout'); });

    const body = typeof opts.payload === 'string'
      ? opts.payload
      : JSON.stringify(opts.payload == null ? {} : opts.payload);
    req.end(body);
  });
}

/**
 * Einen Push an ein Geraet senden.
 * @param {object} o
 * @param {string} o.token        Geraete- bzw. Live-Activity-Token (hex)
 * @param {string} o.topic        apns-topic (Bundle-ID, Pass-Typ-ID, ...push-type.liveactivity)
 * @param {string} [o.pushType]   apns-push-type: alert, background, liveactivity ...
 * @param {object|string} [o.payload]  JSON-Inhalt, Standard {}
 * @param {number} [o.priority]   apns-priority (10 sofort, 5 sparsam)
 * @param {number} [o.expiration] apns-expiration (Unix-Sekunden)
 * @param {string} [o.collapseId] apns-collapse-id
 * @param {boolean} [o.sandboxFallback=true]  false: nur Produktion (Wallet)
 * @returns {Promise<{ok:boolean, status:number, reason:string, sandbox:boolean}>}
 */
async function sendeApns(o) {
  try {
    const opts = o || {};
    const token = String(opts.token || '').trim();
    // Nur Hex: der Token landet im Pfad der Anfrage. Antwort wie von Apple,
    // damit Aufrufer einen kaputten Token genauso aufraeumen.
    if (!/^[0-9a-fA-F]{16,512}$/.test(token)) {
      return { ok: false, status: 400, reason: 'BadDeviceToken', sandbox: false };
    }
    if (!opts.topic) return { ok: false, status: 0, reason: 'kein_topic', sandbox: false };
    if (!apnsKonfiguriert() || !(await ladeApnsKey())) {
      return { ok: false, status: 0, reason: 'nicht_eingerichtet', sandbox: false };
    }
    const mitSandbox = opts.sandboxFallback !== false;
    const versuch = { ...opts, token };
    const jwt = apnsJwt();

    let art = (mitSandbox && hostMerker.get(token) === 'sandbox') ? 'sandbox' : 'prod';
    let r = await einVersuch(art === 'sandbox' ? HOST_SANDBOX : HOST_PROD, versuch, jwt);

    if (mitSandbox && r.status === 400 && r.reason === 'BadDeviceToken') {
      const andere = art === 'sandbox' ? 'prod' : 'sandbox';
      r = await einVersuch(andere === 'sandbox' ? HOST_SANDBOX : HOST_PROD, versuch, jwt);
      art = andere;
    }

    if (r.status === 200) merkeHost(token, art);
    else if (r.status === 410 || r.reason === 'BadDeviceToken') hostMerker.delete(token);

    return { ok: r.status === 200, status: r.status, reason: r.reason, sandbox: art === 'sandbox' };
  } catch (e) {
    console.error('apns:', e && e.message);
    return { ok: false, status: 0, reason: String((e && e.message) || e).slice(0, 120), sandbox: false };
  }
}

module.exports = { sendeApns, apnsKonfiguriert, ladeApnsKey };
