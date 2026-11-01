/**
 * lib/lieferung.js
 * ----------------------------------------------------------------------------
 * Rechnen rund um Kubis Lieferfahrten. Besitzer: Paket lieferung.
 * Reine Funktionen ohne Speicher, damit sie sich ohne Netlify testen lassen
 * (werkzeug/lieferung-test.js).
 *
 *   tour(start, stopps)        Reihenfolge: ab dem Truck jeweils zur nächsten
 *                              Adresse (Luftlinie), ohne Koordinaten ans Ende
 *   buendel(start, stopps)     Paare in derselben Richtung, die sich als eine
 *                              Fahrt lohnen
 *   ankunftVorschlag(km)       Minuten bei rund 25 km/h plus 3 Min., gerundet
 *                              auf die Wahl 10, 15, 20 oder 30
 *   heatZellen(punkte)         Raster von etwa 250 m, nur Zellen ab 3
 *                              Bestellungen (und 2 verschiedenen Adressen)
 *   gebiete(punkte)            stärkste Postleitzahlen mit Stadtteil, ab 3
 *   statusKey(ref)             gleicher Schlüssel wie order-status.js
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');

/* Truck: Gütersloher Str. 122, 33649 Bielefeld (wie LOCATIONS in index.html) */
const TRUCK = { lat: 51.9784, lng: 8.4814, adresse: 'Gütersloher Str. 122, 33649 Bielefeld' };
const KMH = 25;
const PUFFER_MIN = 3;
const WAHL = [10, 15, 20, 30];

const rad = (x) => x * Math.PI / 180;
const hatKoord = (p) => p && typeof p.lat === 'number' && typeof p.lng === 'number' && isFinite(p.lat) && isFinite(p.lng);

/** Luftlinie in km */
function km(a, b) {
  const R = 6371;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/** Kompassrichtung von a nach b in Grad (0 = Norden, 90 = Osten) */
function peilung(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const RICHTUNGEN = ['Norden', 'Nordosten', 'Osten', 'Südosten', 'Süden', 'Südwesten', 'Westen', 'Nordwesten'];
function richtung(grad) { return RICHTUNGEN[Math.round(((grad % 360) + 360) % 360 / 45) % 8]; }
function winkelAbstand(a, b) { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }

/**
 * Tourvorschlag: immer zur nächstgelegenen noch offenen Adresse.
 * @param {{lat,lng}} start
 * @param {Array<{ref:string,lat?:number,lng?:number}>} stopps
 * @returns {Array} dieselben Objekte in Reihenfolge, ergänzt um abKm (vom vorigen Halt)
 */
function tour(start, stopps) {
  const offen = (stopps || []).filter(hatKoord).slice();
  const ohne = (stopps || []).filter((s) => !hatKoord(s));
  const aus = [];
  let hier = start;
  while (offen.length) {
    let best = 0, bestKm = Infinity;
    offen.forEach((s, i) => {
      const d = km(hier, s);
      if (d < bestKm - 1e-9 || (Math.abs(d - bestKm) < 1e-9 && String(s.ref) < String(offen[best].ref))) { best = i; bestKm = d; }
    });
    const s = offen.splice(best, 1)[0];
    aus.push(Object.assign({}, s, { abKm: Math.round(bestKm * 10) / 10 }));
    hier = s;
  }
  return aus.concat(ohne.map((s) => Object.assign({}, s, { abKm: null })));
}

/**
 * Zwei Lieferungen, die in dieselbe Richtung liegen und zusammen weniger
 * Weg bedeuten als zwei einzelne Fahrten mit Rückkehr zum Truck.
 * Bedingungen: Richtung vom Truck aus höchstens 40 Grad auseinander und
 * mindestens 25 % weniger Strecke. Jede Lieferung steckt in höchstens einem Paar.
 * @returns {Array<{a:string,b:string,richtung:string,sparKm:number,zusammenKm:number}>}
 */
function buendel(start, stopps, o) {
  const maxWinkel = (o && o.maxWinkel) || 40;
  const minAnteil = (o && o.minAnteil) || 0.25;
  const s = (stopps || []).filter(hatKoord);
  const kand = [];
  for (let i = 0; i < s.length; i++) {
    for (let j = i + 1; j < s.length; j++) {
      const a = s[i], b = s[j];
      const dA = km(start, a), dB = km(start, b), dAB = km(a, b);
      if (dA < 0.3 || dB < 0.3) continue;   // direkt am Truck: kein Thema
      const wa = peilung(start, a), wb = peilung(start, b);
      if (winkelAbstand(wa, wb) > maxWinkel) continue;
      const einzeln = 2 * dA + 2 * dB;
      const zusammen = Math.min(dA, dB) + dAB + Math.max(dA, dB);
      const spar = einzeln - zusammen;
      if (spar / einzeln < minAnteil) continue;
      const erst = dA <= dB ? a : b, dann = dA <= dB ? b : a;
      const mitte = peilung(start, { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 });
      kand.push({ a: erst.ref, b: dann.ref, richtung: richtung(mitte), sparKm: Math.round(spar * 10) / 10, zusammenKm: Math.round(zusammen * 10) / 10 });
    }
  }
  kand.sort((x, y) => y.sparKm - x.sparKm);
  const belegt = new Set();
  const aus = [];
  for (const k of kand) {
    if (belegt.has(k.a) || belegt.has(k.b)) continue;
    belegt.add(k.a); belegt.add(k.b);
    aus.push(k);
  }
  return aus;
}

/**
 * Ankunftszeit vorschlagen: Luftlinie bei rund 25 km/h plus 3 Minuten,
 * dann die kleinste Wahl, die reicht (höchstens 30).
 */
function ankunftVorschlag(entfernungKm) {
  const d = Number(entfernungKm);
  if (!isFinite(d) || d < 0) return { minuten: null, wahl: 15 };
  const minuten = Math.ceil(d / KMH * 60 + PUFFER_MIN);
  const wahl = WAHL.find((w) => w >= minuten) || WAHL[WAHL.length - 1];
  return { minuten, wahl };
}

/* ---------------- Heatmap ---------------- */
const ZELLE_M = 250;
/* Raster fest am Breitengrad des Trucks ausgerichtet, damit Zellen von
   Aufruf zu Aufruf an derselben Stelle liegen. */
function raster(zelleM) {
  const m = zelleM || ZELLE_M;
  return { dLat: m / 111320, dLng: m / (111320 * Math.cos(rad(TRUCK.lat))) };
}

/**
 * @param {Array<{lat,lng,h?:string}>} punkte   eine Zeile je Bestellung, h = Adress-Hash
 * @param {object} [o]  min (Bestellungen je Zelle, Standard 3), minAdressen (Standard 2)
 * @returns {{ zellen: Array<{lat,lng,n}>, dLat, dLng, ausgeblendet: number }}
 *          lat/lng ist die MITTE der Rasterzelle, nie eine Adresse.
 */
function heatZellen(punkte, o) {
  const min = (o && o.min) || 3;
  const minAdressen = (o && o.minAdressen != null) ? o.minAdressen : 2;
  const { dLat, dLng } = raster(o && o.zelleM);
  const map = new Map();
  for (const p of punkte || []) {
    if (!hatKoord(p)) continue;
    const i = Math.floor(p.lat / dLat), j = Math.floor(p.lng / dLng);
    const k = i + ':' + j;
    const z = map.get(k) || { i, j, n: 0, adr: new Set() };
    z.n++;
    z.adr.add(p.h || (p.lat + ',' + p.lng));
    map.set(k, z);
  }
  const zellen = [];
  let ausgeblendet = 0;
  for (const z of map.values()) {
    if (z.n < min || z.adr.size < minAdressen) { ausgeblendet++; continue; }
    zellen.push({
      lat: Math.round((z.i + 0.5) * dLat * 1e5) / 1e5,
      lng: Math.round((z.j + 0.5) * dLng * 1e5) / 1e5,
      n: z.n,
    });
  }
  zellen.sort((a, b) => b.n - a.n);
  return { zellen, dLat: Math.round(dLat * 1e7) / 1e7, dLng: Math.round(dLng * 1e7) / 1e7, ausgeblendet };
}

/**
 * Stärkste Gegenden nach Postleitzahl, beschriftet mit dem häufigsten
 * Stadtteil. Gruppen unter min Bestellungen fallen weg.
 * @param {Array<{plz?:string,stadtteil?:string}>} punkte
 */
function gebiete(punkte, o) {
  const min = (o && o.min) || 3;
  const max = (o && o.max) || 8;
  const g = new Map();
  for (const p of punkte || []) {
    const plz = String((p && p.plz) || '').replace(/\D/g, '').slice(0, 5);
    if (plz.length !== 5) continue;
    const e = g.get(plz) || { plz, n: 0, teile: new Map() };
    e.n++;
    if (p.stadtteil) e.teile.set(p.stadtteil, (e.teile.get(p.stadtteil) || 0) + 1);
    g.set(plz, e);
  }
  return [...g.values()]
    .filter((e) => e.n >= min)
    .map((e) => {
      const teil = [...e.teile.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de'))[0];
      return { plz: e.plz, stadtteil: teil ? teil[0] : null, n: e.n };
    })
    .sort((a, b) => b.n - a.n || a.plz.localeCompare(b.plz))
    .slice(0, max);
}

/* Gleicher Schlüssel wie order-status.js und send-email.js (Statuslink) */
function statusKey(ref) {
  const secret = process.env.STATUS_UPDATE_SECRET || '';
  return crypto.createHash('sha256').update(ref + '|' + secret).digest('hex').slice(0, 20);
}
function statusKeyStimmt(ref, k) {
  const soll = statusKey(ref);
  const ist = String(k || '');
  return ist.length === soll.length && crypto.timingSafeEqual(Buffer.from(ist), Buffer.from(soll));
}

/* ---------------- Live-Position ----------------
   Blob-Store "fahrt", Schlüssel pos:<bestellnummer> = { lat, lng, acc, at }.
   Getrennt vom Bestelldatensatz, damit der nicht alle 15 s neu geschrieben
   wird. Gelöscht bei "Zugestellt", beim Stopp-Knopf und spätestens nach
   POS_HALTBAR_MS beim nächsten Aufräumen. */
const POS_FRISCH_MS = 3 * 60 * 1000;      // älter: Kunde sieht keinen Punkt mehr
const POS_HALTBAR_MS = 6 * 60 * 60 * 1000;

function fahrtStore() {
  const { getStore } = require('@netlify/blobs');
  const opts = { name: 'fahrt', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}
const posKey = (ref) => 'pos:' + String(ref || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);

/** Gespeicherte Positionen dieser Fahrten löschen. Wirft nie. */
async function positionenLoeschen(refs) {
  const liste = (Array.isArray(refs) ? refs : [refs]).filter(Boolean);
  if (!liste.length) return 0;
  let n = 0;
  try {
    const s = fahrtStore();
    for (const r of liste) { try { await s.delete(posKey(r)); n++; } catch (e) {} }
  } catch (e) {}
  return n;
}

/** Alte Positionen wegräumen (vergessene Fahrten). Wirft nie. */
async function positionenAufraeumen(jetzt) {
  let n = 0;
  try {
    const s = fahrtStore();
    const { blobs } = await s.list({ prefix: 'pos:' });
    for (const b of blobs.slice(0, 50)) {
      const p = await s.get(b.key, { type: 'json' }).catch(() => null);
      const alt = (jetzt || Date.now()) - (p ? Date.parse(p.at || '') || 0 : 0);
      if (!p || alt > POS_HALTBAR_MS) { try { await s.delete(b.key); n++; } catch (e) {} }
    }
  } catch (e) {}
  return n;
}

module.exports = {
  TRUCK, WAHL, ZELLE_M, POS_FRISCH_MS, POS_HALTBAR_MS,
  km, peilung, richtung, tour, buendel, ankunftVorschlag,
  raster, heatZellen, gebiete, statusKey, statusKeyStimmt,
  fahrtStore, posKey, positionenLoeschen, positionenAufraeumen,
};
