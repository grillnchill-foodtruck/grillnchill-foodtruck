/**
 * lib/bremse.js
 * ----------------------------------------------------------------------------
 * Grundschutz für jeden öffentlichen Endpunkt, als eine Zeile am Anfang:
 *
 *     const halt = await schutz(event, { name: 'bestellung', max: 20, maxKB: 64 });
 *     if (halt) return halt;
 *
 * 1. Anfragen je Absender begrenzen: höchstens `max` in `fensterMin` Minuten
 *    (Standard 10). Danach 429 mit Retry-After.
 * 2. Zu große Anfragen ablehnen (413), bevor jemand sie liest.
 *
 * Die Grenzen sind bewusst großzügig: Im Mobilfunk teilen sich oft viele
 * Kunden eine IP-Adresse (CGNAT), im Büro alle Kollegen. Die Bremse soll
 * Skripte stoppen, die hundertfach Bestellungen, Codes oder Mails auslösen,
 * keine Mittagspause.
 *
 * Fehlgeschlagene ANMELDUNGEN zählt weiter lib/auth-guard.js, strenger
 * (5 in 15 Minuten).
 *
 * Wie lib/auth-guard.js: Im Störungsfall wird durchgelassen. Ein klemmender
 * Speicher darf keine Bestellung verhindern.
 *
 * Interne Aufrufe zwischen eigenen Functions (z. B. der SumUp-Webhook ruft
 * send-email) laufen alle über dieselben Netlify-Adressen und würden sonst
 * gemeinsam gezählt. Sie tragen den Header x-gnc-intern (internHeader) und
 * zählen nicht.
 *
 * Speicher: Blob-Store "bremse", Schlüssel <Tag>/<name>/<IP-Hash>. Der Tag
 * im Schlüssel macht das Aufräumen billig: gelegentlich werden Einträge von
 * vor zwei Tagen gelöscht.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

function store() {
  const opts = { name: 'bremse', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

/* Gleiche Regel wie lib/auth-guard.js: x-nf-client-connection-ip setzt Netlify
   selbst, der Aufrufer kann ihn nicht fälschen. */
function absender(event) {
  const h = (event && event.headers) || {};
  const roh = h['x-nf-client-connection-ip'] || String(h['x-forwarded-for'] || '').split(',')[0].trim() || '';
  return roh ? sha(roh).slice(0, 32) : null;
}

/* ---- Interne Aufrufe ------------------------------------------------------ */
// Aus einem Server-Geheimnis abgeleitet, das immer gesetzt ist. Der Header
// verrät das Geheimnis nicht, und ohne es lässt er sich nicht berechnen.
function internWert() {
  const geheim = process.env.INTERNAL_HOOK_SECRET || process.env.STATUS_UPDATE_SECRET || process.env.ADMIN_PASSWORD || '';
  return geheim ? crypto.createHmac('sha256', geheim).update('gnc-intern-v1').digest('hex') : '';
}
function internHeader() {
  const w = internWert();
  return w ? { 'x-gnc-intern': w } : {};
}
function istIntern(event) {
  const h = (event && event.headers) || {};
  const ist = String(h['x-gnc-intern'] || '');
  const soll = internWert();
  return !!soll && ist.length === soll.length && crypto.timingSafeEqual(Buffer.from(ist), Buffer.from(soll));
}

/* ---- Antworten ------------------------------------------------------------ */
const CORS = { 'Access-Control-Allow-Origin': '*' };
function antwort(statusCode, data, extra) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...(extra || {}) },
    body: JSON.stringify(data),
  };
}

function groesse(event) {
  const b = (event && event.body) || '';
  return event && event.isBase64Encoded ? Math.floor(b.length * 3 / 4) : Buffer.byteLength(b);
}

/* ---- Aufräumen ------------------------------------------------------------ */
async function aufraeumen(s) {
  const alt = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const { blobs } = await s.list({ prefix: alt + '/' });
  for (const b of blobs.slice(0, 200)) { try { await s.delete(b.key); } catch (e) {} }
}

/**
 * Grundschutz. Gibt eine fertige Antwort zurück, wenn abgelehnt wird, sonst null.
 * @param {object} o  name (Pflicht), max (Anfragen je Fenster), fensterMin (Standard 10),
 *                    maxKB (Standard 32)
 */
async function schutz(event, o) {
  if (event && event.httpMethod === 'OPTIONS') return null;   // Vorab-Anfrage des Browsers, zählt nicht
  const maxKB = o.maxKB || 32;
  if (groesse(event) > maxKB * 1024) {
    return antwort(413, { error: 'payload_too_large', hint: 'Die Anfrage ist zu groß.' });
  }
  if (istIntern(event)) return null;
  const ip = absender(event);
  if (!ip || !o.max) return null;

  const fensterMs = (o.fensterMin || 10) * 60 * 1000;
  const jetzt = Date.now();
  try {
    const s = store();
    const key = new Date(jetzt).toISOString().slice(0, 10) + '/' + o.name + '/' + ip;
    const rec = await s.get(key, { type: 'json' });
    const frisch = !rec || jetzt - rec.seit > fensterMs;
    const n = frisch ? 1 : rec.n + 1;
    if (!frisch && rec.n >= o.max) {
      const sek = Math.max(1, Math.ceil((rec.seit + fensterMs - jetzt) / 1000));
      return antwort(429, { error: 'too_many_requests', hint: 'Zu viele Anfragen. Bitte in ein paar Minuten erneut versuchen.', retryAfter: sek }, { 'Retry-After': String(sek) });
    }
    await s.setJSON(key, { n, seit: frisch ? jetzt : rec.seit });
    if (Math.random() < 0.01) await aufraeumen(s);
  } catch (e) {
    console.error('bremse ' + o.name + ':', e.message);   // im Zweifel durchlassen
  }
  return null;
}

/* ---- Eingaben säubern ----------------------------------------------------- */
// Kürzt Texte, entfernt Steuerzeichen (Zeilenumbruch und Tab bleiben), begrenzt
// Listen und Verschachtelung. Kein HTML-Escaping: das passiert beim Ausgeben
// (esc() in Mails, esc2() im Admin-Tool), sonst würde doppelt maskiert.
function saeubern(wert, o, tiefe) {
  const opt = o || {};
  const t = tiefe || 0;
  const maxText = opt.maxText || 2000;
  if (typeof wert === 'string') {
    return wert.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '').slice(0, maxText);
  }
  if (typeof wert === 'number') return Number.isFinite(wert) ? wert : 0;
  if (typeof wert === 'boolean' || wert === null) return wert;
  if (t >= (opt.maxTiefe || 6)) return null;
  if (Array.isArray(wert)) return wert.slice(0, opt.maxListe || 200).map((x) => saeubern(x, opt, t + 1));
  if (typeof wert === 'object') {
    const aus = {};
    for (const k of Object.keys(wert).slice(0, opt.maxFelder || 200)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      aus[saeubern(k, { maxText: 120 })] = saeubern(wert[k], opt, t + 1);
    }
    return aus;
  }
  return null;
}

module.exports = { schutz, saeubern, internHeader, istIntern, absender };
