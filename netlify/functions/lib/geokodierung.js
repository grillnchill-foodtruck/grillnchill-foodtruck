/**
 * lib/geokodierung.js
 * ----------------------------------------------------------------------------
 * Adresse zu Koordinaten, nur auf dem Server. Besitzer: Paket lieferung.
 *
 *   const { geokodiere, ausCache } = require('./lib/geokodierung');
 *   const p = await geokodiere({ street, zip, city });
 *   // p = { lat, lng, plz, stadtteil, ausCache } oder null
 *
 * ANBIETER
 * --------
 * Nominatim der OpenStreetMap Foundation (St John's Innovation Centre, Cowley
 * Road, Cambridge, CB4 0WS, Großbritannien). Übertragen werden Straße mit
 * Hausnummer, PLZ und Ort, dazu die IP-Adresse der Function und unser
 * User-Agent. Kein Name, keine Telefonnummer, keine Bestelldaten.
 *
 * Regeln von Nominatim, die hier eingehalten werden:
 *   - höchstens 1 Anfrage pro Sekunde (Drossel unten, auch über mehrere
 *     warme Function-Instanzen hinweg über den Merker _takt im Speicher)
 *   - eigener User-Agent mit Kontakt
 *   - Ergebnisse dauerhaft zwischenspeichern, nie zweimal dieselbe Adresse
 *
 * SPEICHER
 * --------
 * Blob-Store "geo", Schlüssel = sha256 der vereinheitlichten Adresse (hex).
 * Treffer:        { lat, lng, plz, stadtteil, at }
 * Nicht gefunden: { leer: true, at }   (nach 7 Tagen neuer Versuch)
 * Netzfehler werden nicht gespeichert, der nächste Aufruf versucht es wieder.
 *
 * Eingegrenzt auf Deutschland und ein Rechteck um Bielefeld, das die
 * Lieferzone (13 km Luftlinie um den Truck) mit Rand abdeckt. Treffer
 * außerhalb gelten als nicht gefunden.
 *
 * Fehler liefern null und werfen nie: eine Lieferung darf nicht daran
 * scheitern, dass die Karte klemmt.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'GrillnChill/1.0 (info@grillnchill-foodtruck.de)';
// links, oben, rechts, unten (Längengrad, Breitengrad)
const BEREICH = { west: 8.25, nord: 52.15, ost: 8.75, sued: 51.84 };
const ABSTAND_MS = 1100;          // etwas mehr als 1 s, die Uhren laufen nie ganz gleich
const MAX_WARTEN_MS = 4000;       // länger nicht anstehen, dann lieber später
const TIMEOUT_MS = 4000;
const LEER_GILT_MS = 7 * 86400000;

function store() {
  const opts = { name: 'geo', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

/* Für Tests austauschbar: Uhr, Warten, fetch */
const umgebung = {
  jetzt: () => Date.now(),
  schlafen: (ms) => new Promise((r) => setTimeout(r, ms)),
  fetch: (...a) => fetch(...a),
};

/* ---------------- Vereinheitlichen ---------------- */
function teil(x) {
  return String(x == null ? '' : x)
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/ß/g, 'ss')
    .replace(/str\.(?=\s|\d|$)/g, 'strasse')
    .replace(/(^|[^a-zäöü])str(?=\s|\d|$)/g, '$1strasse')
    .replace(/[^0-9a-zäöüéèêàâçñ]+/g, ' ')
    .replace(/(\d)\s+([a-z])\b/g, '$1$2')   // "12 a" = "12a"
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** Adresse als Text in fester Form: "strasse 12|33649|bielefeld". */
function vereinheitlichen(adr) {
  if (!adr) return '';
  if (typeof adr === 'string') return teil(adr);
  const s = teil(adr.street), z = String(adr.zip || '').replace(/\D/g, '').slice(0, 5), c = teil(adr.city);
  if (!s || !z) return '';
  return s + '|' + z + '|' + c;
}

function schluessel(adr) {
  const v = vereinheitlichen(adr);
  return v ? crypto.createHash('sha256').update(v).digest('hex') : '';
}

/* ---------------- Zwischenspeicher ---------------- */
/**
 * Nur nachsehen, nie beim Anbieter fragen.
 * @returns {{ status: 'treffer'|'leer'|'fehlt', wert?: object, key: string }}
 */
async function ausCache(adr, s) {
  const key = schluessel(adr);
  if (!key) return { status: 'leer', key: '' };
  try {
    const rec = await (s || store()).get(key, { type: 'json' });
    if (!rec) return { status: 'fehlt', key };
    if (rec.leer) {
      const alt = umgebung.jetzt() - (Date.parse(rec.at || '') || 0);
      return alt < LEER_GILT_MS ? { status: 'leer', key } : { status: 'fehlt', key };
    }
    if (typeof rec.lat !== 'number' || typeof rec.lng !== 'number') return { status: 'fehlt', key };
    return { status: 'treffer', key, wert: rec };
  } catch (e) {
    return { status: 'fehlt', key };
  }
}

/* ---------------- Drossel: höchstens 1 Anfrage pro Sekunde ---------------- */
let kette = Promise.resolve();
let letzte = 0;
function drossel(s) {
  const lauf = kette.then(async () => {
    let frei = letzte + ABSTAND_MS;
    try {
      const t = await s.get('_takt', { type: 'json' });
      if (t && typeof t.at === 'number') frei = Math.max(frei, t.at + ABSTAND_MS);
    } catch (e) {}
    const warten = frei - umgebung.jetzt();
    if (warten > MAX_WARTEN_MS) return false;   // jemand anders fragt gerade viel, später wieder
    if (warten > 0) await umgebung.schlafen(warten);
    letzte = umgebung.jetzt();
    try { await s.setJSON('_takt', { at: letzte }); } catch (e) {}
    return true;
  });
  kette = lauf.catch(() => {});
  return lauf;
}

function imBereich(lat, lng) {
  return lat >= BEREICH.sued && lat <= BEREICH.nord && lng >= BEREICH.west && lng <= BEREICH.ost;
}
const r5 = (x) => Math.round(x * 1e5) / 1e5;

/* ---------------- Anfrage ---------------- */
async function frage(adr) {
  const p = new URLSearchParams({
    format: 'jsonv2',
    limit: '1',
    addressdetails: '1',
    countrycodes: 'de',
    viewbox: [BEREICH.west, BEREICH.nord, BEREICH.ost, BEREICH.sued].join(','),
    bounded: '1',
    'accept-language': 'de',
  });
  if (typeof adr === 'string') p.set('q', String(adr).slice(0, 200));
  else {
    p.set('street', String(adr.street || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120));
    p.set('postalcode', String(adr.zip || '').replace(/\D/g, '').slice(0, 5));
    p.set('city', String(adr.city || 'Bielefeld').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) || 'Bielefeld');
  }
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const t = ac ? setTimeout(() => ac.abort(), TIMEOUT_MS) : null;
  try {
    const res = await umgebung.fetch(NOMINATIM + '?' + p.toString(), {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: ac ? ac.signal : undefined,
    });
    if (!res || !res.ok) return { fehler: true };
    const d = await res.json();
    if (!Array.isArray(d)) return { fehler: true };
    if (!d.length) return { leer: true };
    const lat = parseFloat(d[0].lat), lng = parseFloat(d[0].lon);
    if (!isFinite(lat) || !isFinite(lng) || !imBereich(lat, lng)) return { leer: true };
    const a = d[0].address || {};
    return {
      lat: r5(lat),
      lng: r5(lng),
      plz: String(a.postcode || '').replace(/\D/g, '').slice(0, 5) || null,
      stadtteil: String(a.suburb || a.city_district || a.quarter || a.borough || a.village || a.town || '').slice(0, 60) || null,
    };
  } catch (e) {
    return { fehler: true };
  } finally {
    if (t) clearTimeout(t);
  }
}

/**
 * Adresse geokodieren. Erst Zwischenspeicher, sonst Nominatim (gedrosselt).
 * @param {object|string} adr  { street, zip, city } oder freier Text
 * @param {object} [o]         { store }
 * @returns {Promise<{lat:number,lng:number,plz:?string,stadtteil:?string,ausCache:boolean}|null>}
 */
async function geokodiere(adr, o) {
  try {
    const s = (o && o.store) || store();
    const c = await ausCache(adr, s);
    if (c.status === 'treffer') return { lat: c.wert.lat, lng: c.wert.lng, plz: c.wert.plz || null, stadtteil: c.wert.stadtteil || null, ausCache: true };
    if (c.status === 'leer' || !c.key) return null;
    if (!(await drossel(s))) return null;
    const r = await frage(adr);
    if (r.fehler) return null;
    const at = new Date(umgebung.jetzt()).toISOString();
    if (r.leer) {
      try { await s.setJSON(c.key, { leer: true, at }); } catch (e) {}
      return null;
    }
    try { await s.setJSON(c.key, { lat: r.lat, lng: r.lng, plz: r.plz, stadtteil: r.stadtteil, at }); } catch (e) {}
    return { lat: r.lat, lng: r.lng, plz: r.plz, stadtteil: r.stadtteil, ausCache: false };
  } catch (e) {
    console.error('geokodierung:', e && e.message);
    return null;
  }
}

/* Nur für werkzeug/lieferung-test.js */
function _test(o) {
  Object.assign(umgebung, o || {});
  letzte = 0;
  kette = Promise.resolve();
}

module.exports = { geokodiere, ausCache, vereinheitlichen, schluessel, USER_AGENT, BEREICH, ABSTAND_MS, _test };
