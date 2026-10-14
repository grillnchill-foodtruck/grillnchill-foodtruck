/**
 * google-reviews.js
 * ----------------------------------------------------------------------------
 * Liefert die aktuelle Google-Bewertung (Sterne + Anzahl) für die Hero-Zeile
 * und bis zu 5 Rezensionen (Google wählt die „relevantesten") für das Karussell.
 *
 *   GET /google-reviews?lang=de   →  { rating: 5.0, total: 246, reviews: [...], cached: true|false, ... }
 *
 * lang = de|en|tr|it|es|pt|fr|nl – Google übersetzt die Rezensionstexte selbst in
 * die gewünschte Sprache. Je Sprache eigener Cache-Eintrag (data:<lang>).
 * Rezensionen ohne Text oder unter 5 Sternen werden nicht ausgeliefert; Namen
 * werden auf „Vorname N." gekürzt (wie die fest hinterlegten Zitate).
 *
 * Die Google Places API wird höchstens ~1×/24h aufgerufen; das Ergebnis wird
 * in Netlify Blobs zwischengespeichert. Dadurch praktisch keine Kosten und
 * keine Rate-Limit-Probleme, egal wie viele Besucher die Seite hat.
 *
 * Benötigte Environment Variable in Netlify:
 *   GOOGLE_PLACES_API_KEY = API-Key mit aktivierter "Places API (New)"
 * Optional:
 *   GOOGLE_PLACE_ID       = Place-ID (Default = Grill'n Chill)
 *
 * Fehlt der Key oder schlägt Google fehl, wird – falls vorhanden – der letzte
 * gecachte Wert geliefert; sonst liefert die Function null und die Seite
 * behält ihre fest hinterlegten Fallback-Zahlen.
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'google-reviews';
const KEY_PREFIX = 'data:';
const LANGS = ['de', 'en', 'tr', 'it', 'es', 'pt', 'fr', 'nl'];
const MAX_TEXT = 400; // laengere Rezensionen werden am Wortende gekuerzt
const MIN_STARS = 5;  // Karussell zeigt nur 5-Sterne-Rezensionen (Schnitt ist 5,0; Google-Link darunter zeigt alle)
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 Stunden
const DEFAULT_PLACE_ID = 'ChIJJ9h4Tk09ukcRAAFxrgGWsSc';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(statusCode, data, extraHeaders) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS, ...(extraHeaders || {}) },
    body: JSON.stringify(data),
  };
}

function store() {
  const opts = { name: STORE_NAME, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

async function readCache(lang) {
  try {
    const data = await store().get(KEY_PREFIX + lang, { type: 'json' });
    if (data && typeof data === 'object' && data.fetchedAt) return data;
  } catch (e) { /* ignore */ }
  return null;
}

// „Heike Sielemann" → „Heike S." (einzelne Namen bleiben wie sie sind)
function kurzName(name) {
  const teile = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!teile.length) return 'Google-Nutzer';
  if (teile.length === 1) return teile[0];
  return teile[0] + ' ' + teile[teile.length - 1].charAt(0).toUpperCase() + '.';
}

function kuerzeText(text) {
  if (text.length <= MAX_TEXT) return text;
  const cut = text.slice(0, MAX_TEXT);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 200)).replace(/[\s,.;:!?…-]+$/, '') + ' …';
}

function mapReview(r) {
  const stars = Math.round(Number(r && r.rating) || 0);
  const text = ((r.text && r.text.text) || (r.originalText && r.originalText.text) || '').replace(/\s+/g, ' ').trim();
  if (stars < MIN_STARS || !text) return null;
  return {
    name: kurzName(r.authorAttribution && r.authorAttribution.displayName),
    stars,
    text: kuerzeText(text),
    date: r.publishTime || null,
    lang: (r.text && r.text.languageCode) || null,
  };
}

async function placesRequest(apiKey, placeId, lang, fieldMask) {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=${encodeURIComponent(lang)}`;
  const res = await fetch(url, {
    headers: { 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fieldMask },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data && data.error) || {};
    const msg = err.message ? err.message : ('HTTP ' + res.status);
    // Grund als Kategorie mitgeben (z. B. API_KEY_SERVICE_BLOCKED, BILLING_DISABLED,
    // API_KEY_IP_ADDRESS_BLOCKED). Keine Schluessel, keine Projektnummern.
    const reasons = (Array.isArray(err.details) ? err.details : []).map(d => d && d.reason).filter(Boolean);
    const e = new Error(msg);
    e.diag = { http: res.status, status: err.status || null, reason: reasons[0] || null };
    throw e;
  }
  return data;
}

// Zweiter Weg zum Ort: Textsuche statt fester Place-ID. Hilft, wenn Google die
// ID geaendert hat oder der Detail-Abruf fuer diese ID verweigert wird.
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
  const treffer = (data.places || []).find(p => /grill.?n.?chill/i.test((p.displayName && p.displayName.text) || '')) || null;
  return treffer;
}

async function fetchFromGoogle(apiKey, placeId, lang) {
  // Places API (New): Resource-Name = places/<PLACE_ID>, Felder via Field-Mask-Header.
  let data, ueber = 'details', detailFehler = null;
  try {
    data = await placesRequest(apiKey, placeId, lang, 'rating,userRatingCount,reviews');
  } catch (e) {
    detailFehler = e;
    // Sollten Rezensionen mal nicht abrufbar sein (Feld/SKU gesperrt), duerfen
    // Sterne + Anzahl trotzdem nicht veralten → zweiter Versuch ohne reviews.
    try {
      data = await placesRequest(apiKey, placeId, lang, 'rating,userRatingCount');
      data.reviews = [];
    } catch (e2) { data = null; }
  }
  if (!data) {
    // Detail-Abruf fuer diese ID verweigert: Ort per Textsuche finden
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
  const rating = typeof data.rating === 'number' ? data.rating : null;
  const total = typeof data.userRatingCount === 'number' ? data.userRatingCount : null;
  if (rating == null || total == null) throw new Error('Antwort ohne rating/userRatingCount');
  const reviews = Array.isArray(data.reviews) ? data.reviews.map(mapReview).filter(Boolean).slice(0, 5) : [];
  return { rating, total, reviews, ueber };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'method_not_allowed' });
  }

  const q = event.queryStringParameters || {};
  const lang = LANGS.indexOf(q.lang) !== -1 ? q.lang : 'de';

  // Browser/CDN darf das Ergebnis ein paar Stunden cachen (entlastet die Function).
  const clientCache = { 'Cache-Control': 'public, max-age=21600' };

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const placeId = process.env.GOOGLE_PLACE_ID || DEFAULT_PLACE_ID;

  const cached = await readCache(lang);
  const fresh = cached && (Date.now() - cached.fetchedAt < CACHE_TTL_MS);
  const ausCache = (c, extra) => json(200, {
    rating: c.rating, total: c.total, reviews: Array.isArray(c.reviews) ? c.reviews : [],
    lang, cached: true, fetchedAt: new Date(c.fetchedAt).toISOString(), ...(extra || {}),
  }, clientCache);

  // 1) Frischer Cache → direkt ausliefern, kein Google-Aufruf.
  // "fetchedAt" steht mit in der Antwort: ohne den Zeitstempel liess sich von
  // aussen nie beurteilen, ob die 24h-Auffrischung wirklich laeuft – genau
  // diese Frage kam auf. Jetzt beantwortet sie ein einziger Aufruf.
  if (fresh) return ausCache(cached);

  // 2) Kein Key konfiguriert → letzten bekannten Wert oder null (Seite nutzt Fallback).
  if (!apiKey) {
    if (cached) return ausCache(cached, { stale: true });
    return json(200, { rating: null, total: null, reviews: [], lang, note: 'GOOGLE_PLACES_API_KEY nicht gesetzt' });
  }

  // 3) Cache abgelaufen/leer → bei Google nachfragen.
  try {
    const { rating, total, reviews, ueber } = await fetchFromGoogle(apiKey, placeId, lang);
    const jetzt = Date.now();
    try { await store().setJSON(KEY_PREFIX + lang, { rating, total, reviews, fetchedAt: jetzt, ueber }); } catch (e) { /* ignore */ }
    return json(200, { rating, total, reviews, lang, cached: false, fetchedAt: new Date(jetzt).toISOString(), ueber }, clientCache);
  } catch (e) {
    // Google-Fehler → falls vorhanden veralteten Cache liefern, sonst null.
    const diag = e.diag || null;
    console.error('google-reviews: Google lehnt ab', JSON.stringify(diag));
    if (cached) return ausCache(cached, { stale: true, error: String(e.message || e), diag });
    return json(200, { rating: null, total: null, reviews: [], lang, error: String(e.message || e), diag });
  }
};
