/**
 * lib/idempotenz.js – Idempotenz-Schlüssel für Funktionen, die etwas anlegen
 * ----------------------------------------------------------------------------
 * Schickt der Browser dieselbe Anfrage zweimal (Doppeltipp, automatischer
 * zweiter Versuch nach einem Netzfehler, Antwort ging unterwegs verloren),
 * entsteht trotzdem nur EIN Bezahlvorgang bzw. EINE Bestellung.
 *
 *   exports.handler = mitIdempotenz(handler, { bereich: 'kasse' });
 *
 * Ablauf bei POST mit Kopfzeile „Idempotency-Key“:
 *   1. Schlüssel schon fertig → gespeicherte Antwort noch einmal ausliefern
 *      (Kopfzeile Idempotent-Replayed: true), der Handler läuft nicht.
 *   2. Schlüssel läuft gerade (unter 60 s) → 409 mit Retry-After: 1.
 *   3. Gleicher Schlüssel, anderer Inhalt → 422 (Fehler im Aufrufer).
 *   4. Sonst: Marke „läuft“ setzen, Handler ausführen, Antwort 24 h merken.
 * Gespeichert werden 2xx und fachliche 4xx. 5xx, 408, 409, 425 und 429 nicht,
 * damit ein späterer Versuch wieder echt laufen kann.
 * Ohne Kopfzeile (oder bei GET/OPTIONS) läuft alles wie bisher.
 * optionen.fingerabdruck(body): Inhalt für den Vergleich, ohne Felder, die je
 * Versuch wechseln dürfen (z. B. das Turnstile-Token).
 * ----------------------------------------------------------------------------
 */
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const GUELTIG_MS = 24 * 60 * 60 * 1000;
const LAEUFT_MS = 60 * 1000;
const SCHLUESSEL = /^[A-Za-z0-9._:-]{16,120}$/;
const NICHT_MERKEN = new Set([408, 409, 425, 429]);

function store() {
  const opts = { name: 'idempotenz', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

const hash = (s) => crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex');

function kopf(event, name) {
  const h = event.headers || {};
  return h[name] || h[name.toLowerCase()] || Object.keys(h).reduce((v, k) => (v || (k.toLowerCase() === name.toLowerCase() ? h[k] : '')), '');
}

function antwort(statusCode, body, extra) {
  return {
    statusCode,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}),
    body: JSON.stringify(body),
  };
}

function mitIdempotenz(handler, optionen) {
  const bereich = (optionen && optionen.bereich) || 'allgemein';
  return async function (event, context) {
    if (!event || event.httpMethod !== 'POST') return handler(event, context);
    const schluessel = String(kopf(event, 'Idempotency-Key') || '').trim();
    if (!schluessel) return handler(event, context);
    if (!SCHLUESSEL.test(schluessel)) return antwort(400, { error: 'Ungültiger Idempotency-Key' });

    let s;
    try { s = store(); } catch (e) { return handler(event, context); }   // ohne Speicher lieber ausführen als blockieren
    const id = bereich + '/' + hash(schluessel);
    let roh = event.body || '';
    if (optionen && typeof optionen.fingerabdruck === 'function') {
      try { roh = optionen.fingerabdruck(roh); } catch (e) {}
    }
    const inhalt = hash(roh);
    const jetzt = Date.now();

    let eintrag = null;
    try { eintrag = await s.get(id, { type: 'json' }); } catch (e) { eintrag = null; }
    if (eintrag && jetzt - (eintrag.t || 0) < GUELTIG_MS) {
      if (eintrag.inhalt && eintrag.inhalt !== inhalt) {
        return antwort(422, { error: 'Idempotency-Key wurde schon für eine andere Anfrage benutzt' });
      }
      if (eintrag.status === 'fertig' && eintrag.antwort) {
        const a = eintrag.antwort;
        return { statusCode: a.statusCode, headers: Object.assign({}, a.headers || {}, { 'Idempotent-Replayed': 'true' }), body: a.body };
      }
      if (eintrag.status === 'laeuft' && jetzt - eintrag.t < LAEUFT_MS) {
        return antwort(409, { error: 'Anfrage wird schon bearbeitet', retryAfter: 1 }, { 'Retry-After': '1' });
      }
    }

    try { await s.setJSON(id, { status: 'laeuft', t: jetzt, inhalt }); } catch (e) {}
    let ergebnis;
    try {
      ergebnis = await handler(event, context);
    } catch (fehler) {
      try { await s.delete(id); } catch (e) {}
      throw fehler;
    }
    const code = (ergebnis && ergebnis.statusCode) || 200;
    try {
      if (code < 500 && !NICHT_MERKEN.has(code)) {
        await s.setJSON(id, {
          status: 'fertig', t: Date.now(), inhalt,
          antwort: { statusCode: code, headers: ergebnis.headers || {}, body: ergebnis.body || '' },
        });
      } else {
        await s.delete(id);
      }
    } catch (e) {}
    return ergebnis;
  };
}

// Für aufraeumen.js: Einträge älter als 24 h löschen
async function idempotenzAufraeumen() {
  const s = store();
  let geloescht = 0;
  const { blobs } = await s.list();
  for (const b of blobs) {
    try {
      const e = await s.get(b.key, { type: 'json' });
      if (!e || Date.now() - (e.t || 0) > GUELTIG_MS) { await s.delete(b.key); geloescht++; }
    } catch (err) {}
  }
  return geloescht;
}

module.exports = { mitIdempotenz, idempotenzAufraeumen };
