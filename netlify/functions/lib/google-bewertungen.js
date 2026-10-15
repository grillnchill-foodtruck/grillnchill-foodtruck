/**
 * lib/google-bewertungen.js
 * ----------------------------------------------------------------------------
 * Gemeinsame Logik für google-reviews.js (Abruf durch Besucher) und
 * google-reviews-daily.js (täglicher Zeitplan).
 *
 * Woher die Rezensionen kommen:
 *   1. Places API (New): Sterne, Anzahl und bis zu 5 Rezensionen. Google wählt
 *      dort die „relevantesten“, eine Sortierung nach Datum gibt es nicht.
 *   2. Place Details (Legacy) mit reviews_sort=newest: die 5 neuesten. Klappt
 *      nur, wenn im Google-Cloud-Projekt die alte „Places API“ aktiv ist. Fehlt
 *      sie, läuft alles über Weg 1 weiter.
 *   3. Archiv je Sprache (Blob archiv:<lang>): jede Rezension, die einmal
 *      geliefert wurde, bleibt hier liegen. So wächst die Liste mit jeder neuen
 *      Rezension, auch wenn Google selbst nur 5 auf einmal herausgibt.
 *
 * Status (Blob "status"): letzter Erfolg, letzter Fehler als Kategorie, seit
 * wann es hakt. Hakt der Abruf, meldet der tägliche Lauf das höchstens einmal
 * pro Woche per Telegram; läuft er wieder, kommt eine kurze Entwarnung.
 * Schlüssel und Projektnummern landen nie im Status oder in einer Meldung.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'google-reviews';
const KEY_PREFIX = 'data:';
const ARCHIV_PREFIX = 'archiv:';
const STATUS_KEY = 'status';
const LANGS = ['de', 'en', 'tr', 'it', 'es', 'pt', 'fr', 'nl'];
const MAX_TEXT = 400;       // längere Rezensionen werden am Wortende gekürzt
const MIN_STARS = 5;        // Karussell zeigt nur 5-Sterne-Rezensionen (Schnitt ist 5,0; Google-Link darunter zeigt alle)
const ARCHIV_MAX = 30;      // so viele Rezensionen hält das Archiv je Sprache
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PLACE_ID = 'ChIJJ9h4Tk09ukcRAAFxrgGWsSc';
const MELDE_PAUSE_MS = 7 * 24 * 60 * 60 * 1000;

function store() {
  const opts = { name: STORE_NAME, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

async function leseJson(key) {
  try { return await store().get(key, { type: 'json' }); } catch (e) { return null; }
}
async function schreibeJson(key, wert) {
  try { await store().setJSON(key, wert); } catch (e) { /* Speicher kurz weg: nächster Lauf holt es nach */ }
}

async function leseCache(lang) {
  const d = await leseJson(KEY_PREFIX + lang);
  return d && typeof d === 'object' && d.fetchedAt ? d : null;
}
async function leseStatus() {
  return (await leseJson(STATUS_KEY)) || {};
}
async function schreibeStatus(teil) {
  const alt = await leseStatus();
  await schreibeJson(STATUS_KEY, { ...alt, ...teil });
}

// „Heike Sielemann“ → „Heike S.“. Kürzel und Spitznamen wie „S. A.“ oder
// „I like Tea“ (erstes Wort nur ein Buchstabe) bleiben, wie sie sind.
function kurzName(name) {
  const teile = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!teile.length) return 'Google-Nutzer';
  if (teile.length === 1) return teile[0];
  if (teile[0].replace(/[^\p{L}]/gu, '').length <= 1) return teile.join(' ');
  const vor = teile[0].charAt(0).toUpperCase() + teile[0].slice(1);
  return vor + ' ' + teile[teile.length - 1].charAt(0).toUpperCase() + '.';
}

function kuerzeText(text) {
  if (text.length <= MAX_TEXT) return text;
  const cut = text.slice(0, MAX_TEXT);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 200)).replace(/[\s,.;:!?…-]+$/, '') + ' …';
}

function baueEintrag(name, stars, text, date, lang) {
  stars = Math.round(Number(stars) || 0);
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (stars < MIN_STARS || !text) return null;
  return { name: kurzName(name), stars, text: kuerzeText(text), date: date || null, lang: lang || null };
}

// Places API (New)
function ausNeu(r) {
  return baueEintrag(
    r && r.authorAttribution && r.authorAttribution.displayName,
    r && r.rating,
    (r.text && r.text.text) || (r.originalText && r.originalText.text),
    r.publishTime,
    r.text && r.text.languageCode
  );
}
// Place Details (Legacy)
function ausLegacy(r) {
  return baueEintrag(
    r && r.author_name,
    r && r.rating,
    r && r.text,
    r && r.time ? new Date(r.time * 1000).toISOString() : null,
    r && r.language
  );
}

async function placesRequest(apiKey, placeId, lang, fieldMask) {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=${encodeURIComponent(lang)}`;
  const res = await fetch(url, { headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fieldMask } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data && data.error) || {};
    // Grund als Kategorie mitgeben (z. B. API_KEY_SERVICE_BLOCKED, BILLING_DISABLED).
    // Keine Schlüssel, keine Projektnummern.
    const reasons = (Array.isArray(err.details) ? err.details : []).map(d => d && d.reason).filter(Boolean);
    const e = new Error(err.message || ('HTTP ' + res.status));
    e.diag = { http: res.status, status: err.status || null, reason: reasons[0] || null };
    throw e;
  }
  return data;
}

// Zweiter Weg zum Ort: Textsuche statt fester Place-ID. Hilft, wenn Google die
// ID geändert hat oder der Detail-Abruf für diese ID verweigert wird.
async function searchPlace(apiKey, lang) {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.rating,places.userRatingCount,places.reviews',
    },
    body: JSON.stringify({ textQuery: "Grill'n Chill Foodtruck Bielefeld", languageCode: lang, maxResultCount: 3 }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data && data.error) || {};
    const e = new Error(err.message || ('HTTP ' + res.status));
    e.diag = { http: res.status, status: err.status || null };
    throw e;
  }
  return (data.places || []).find(p => /grill.?n.?chill/i.test((p.displayName && p.displayName.text) || '')) || null;
}

async function holeNeu(apiKey, placeId, lang) {
  let data, ueber = 'details', detailFehler = null;
  try {
    data = await placesRequest(apiKey, placeId, lang, 'rating,userRatingCount,reviews');
  } catch (e) {
    detailFehler = e;
    // Rezensionen gesperrt (Feld/SKU)? Sterne + Anzahl dürfen trotzdem nicht veralten.
    try {
      data = await placesRequest(apiKey, placeId, lang, 'rating,userRatingCount');
      data.reviews = [];
    } catch (e2) { data = null; }
  }
  if (!data) {
    let treffer = null;
    try { treffer = await searchPlace(apiKey, lang); }
    catch (e3) {
      const e = new Error((detailFehler && detailFehler.message) || e3.message);
      e.diag = { details: detailFehler && detailFehler.diag, suche: e3.diag || { error: String(e3.message) } };
      throw e;
    }
    if (!treffer) {
      const e = new Error('Ort per Textsuche nicht gefunden');
      e.diag = { details: detailFehler && detailFehler.diag, suche: 'kein Treffer' };
      throw e;
    }
    data = treffer;
    ueber = 'suche' + (treffer.id && treffer.id !== placeId ? ':neue-id:' + treffer.id : ':gleiche-id');
  }
  return {
    rating: typeof data.rating === 'number' ? data.rating : null,
    total: typeof data.userRatingCount === 'number' ? data.userRatingCount : null,
    reviews: Array.isArray(data.reviews) ? data.reviews.map(ausNeu).filter(Boolean) : [],
    ueber,
  };
}

// Die 5 neuesten Rezensionen. Der Schlüssel steht hier in der URL (so will es
// die alte API); die URL wird deshalb nie geloggt oder zurückgegeben.
async function holeNeuesteLegacy(apiKey, placeId, lang) {
  const url = 'https://maps.googleapis.com/maps/api/place/details/json'
    + '?place_id=' + encodeURIComponent(placeId)
    + '&fields=rating,user_ratings_total,reviews&reviews_sort=newest'
    + '&language=' + encodeURIComponent(lang)
    + '&key=' + encodeURIComponent(apiKey);
  const res = await fetch(url);
  const d = await res.json().catch(() => ({}));
  if (!d || d.status !== 'OK' || !d.result) {
    const e = new Error('Legacy ' + ((d && d.status) || ('HTTP ' + res.status)));
    e.diag = { http: res.status, status: (d && d.status) || null };
    throw e;
  }
  return {
    rating: typeof d.result.rating === 'number' ? d.result.rating : null,
    total: typeof d.result.user_ratings_total === 'number' ? d.result.user_ratings_total : null,
    reviews: Array.isArray(d.result.reviews) ? d.result.reviews.map(ausLegacy).filter(Boolean) : [],
  };
}

const zeit = r => { const t = Date.parse(r && r.date || ''); return isNaN(t) ? 0 : t; };

// Frische Rezensionen ins Archiv: eine Rezension je Person (die jüngste),
// neueste zuerst, höchstens ARCHIV_MAX.
function mischeArchiv(alt, frisch) {
  const je = new Map();
  for (const r of [...(alt || []), ...(frisch || [])]) {
    if (!r || !r.name || !r.text) continue;
    const k = String(r.name).toLowerCase();
    const da = je.get(k);
    if (!da || zeit(r) >= zeit(da)) je.set(k, r);
  }
  return [...je.values()].sort((a, b) => zeit(b) - zeit(a)).slice(0, ARCHIV_MAX);
}

/**
 * Holt eine Sprache frisch von Google, mischt ins Archiv und schreibt den Cache.
 * Wirft bei Misserfolg einen Fehler mit e.diag (nur Kategorien).
 */
async function aktualisiere(lang) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const placeId = process.env.GOOGLE_PLACE_ID || DEFAULT_PLACE_ID;
  if (!apiKey) {
    const e = new Error('GOOGLE_PLACES_API_KEY nicht gesetzt');
    e.diag = { status: 'KEIN_SCHLUESSEL' };
    throw e;
  }
  const [neu, legacy] = await Promise.allSettled([
    holeNeu(apiKey, placeId, lang),
    holeNeuesteLegacy(apiKey, placeId, lang),
  ]);
  const n = neu.status === 'fulfilled' ? neu.value : null;
  const l = legacy.status === 'fulfilled' ? legacy.value : null;
  const rating = n && n.rating != null ? n.rating : (l && l.rating);
  const total = Math.max((n && n.total) || 0, (l && l.total) || 0) || null;
  if (rating == null || total == null) {
    const e = new Error(neu.status === 'rejected' ? neu.reason.message : 'Antwort ohne rating/userRatingCount');
    e.diag = {
      neu: neu.status === 'rejected' ? (neu.reason.diag || { error: String(neu.reason.message) }) : 'ohne Zahlen',
      neueste: legacy.status === 'rejected' ? (legacy.reason.diag || null) : 'ok',
    };
    throw e;
  }
  const archivAlt = await leseJson(ARCHIV_PREFIX + lang);
  const reviews = mischeArchiv(archivAlt && archivAlt.reviews, [...(l ? l.reviews : []), ...(n ? n.reviews : [])]);
  const jetzt = Date.now();
  const quellen = { neu: n ? 'ok' : 'fehler', neueste: l ? 'ok' : (legacy.reason && legacy.reason.diag && legacy.reason.diag.status) || 'fehler' };
  await schreibeJson(ARCHIV_PREFIX + lang, { reviews, aktualisiert: jetzt });
  const daten = { rating, total, reviews, fetchedAt: jetzt, ueber: n ? n.ueber : 'legacy', quellen };
  await schreibeJson(KEY_PREFIX + lang, daten);
  return daten;
}

// Wiedererkennungsmarke des aktuellen Schlüssels (gekürzter Hash). Steht nur
// im Status-Blob und wird nie ausgeliefert. Wechselt der Schlüssel, endet die
// Pause nach einem Fehlschlag sofort.
function schluesselMarke() {
  const k = process.env.GOOGLE_PLACES_API_KEY;
  return k ? crypto.createHash('sha256').update(k).digest('hex').slice(0, 16) : null;
}

async function melde(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const res = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' }),
    });
    return res.ok;
  } catch (e) { return false; }
}

module.exports = {
  LANGS, CACHE_TTL_MS, MELDE_PAUSE_MS,
  leseCache, leseStatus, schreibeStatus, aktualisiere, melde, kurzName, mischeArchiv, schluesselMarke,
};
