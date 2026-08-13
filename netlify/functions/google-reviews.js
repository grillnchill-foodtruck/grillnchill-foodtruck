/**
 * google-reviews.js
 * ----------------------------------------------------------------------------
 * Liefert die aktuelle Google-Bewertung (Sterne + Anzahl) für die Hero-Zeile.
 *
 *   GET /google-reviews   →  { rating: 5.0, total: 229, cached: true|false, ... }
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
const KEY = 'data';
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

async function readCache() {
  try {
    const data = await store().get(KEY, { type: 'json' });
    if (data && typeof data === 'object' && data.fetchedAt) return data;
  } catch (e) { /* ignore */ }
  return null;
}

async function fetchFromGoogle(apiKey, placeId) {
  // Places API (New): Resource-Name = places/<PLACE_ID>, Felder via Field-Mask-Header.
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=de`;
  const res = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'rating,userRatingCount',
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) ? data.error.message : ('HTTP ' + res.status);
    throw new Error(msg);
  }
  const rating = typeof data.rating === 'number' ? data.rating : null;
  const total = typeof data.userRatingCount === 'number' ? data.userRatingCount : null;
  if (rating == null || total == null) throw new Error('Antwort ohne rating/userRatingCount');
  return { rating, total };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'method_not_allowed' });
  }

  // Browser/CDN darf das Ergebnis ein paar Stunden cachen (entlastet die Function).
  const clientCache = { 'Cache-Control': 'public, max-age=21600' };

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  const placeId = process.env.GOOGLE_PLACE_ID || DEFAULT_PLACE_ID;

  const cached = await readCache();
  const fresh = cached && (Date.now() - cached.fetchedAt < CACHE_TTL_MS);

  // 1) Frischer Cache → direkt ausliefern, kein Google-Aufruf.
  if (fresh) {
    return json(200, { rating: cached.rating, total: cached.total, cached: true }, clientCache);
  }

  // 2) Kein Key konfiguriert → letzten bekannten Wert oder null (Seite nutzt Fallback).
  if (!apiKey) {
    if (cached) return json(200, { rating: cached.rating, total: cached.total, cached: true, stale: true }, clientCache);
    return json(200, { rating: null, total: null, note: 'GOOGLE_PLACES_API_KEY nicht gesetzt' });
  }

  // 3) Cache abgelaufen/leer → bei Google nachfragen.
  try {
    const { rating, total } = await fetchFromGoogle(apiKey, placeId);
    try { await store().setJSON(KEY, { rating, total, fetchedAt: Date.now() }); } catch (e) { /* ignore */ }
    return json(200, { rating, total, cached: false }, clientCache);
  } catch (e) {
    // Google-Fehler → falls vorhanden veralteten Cache liefern, sonst null.
    if (cached) return json(200, { rating: cached.rating, total: cached.total, stale: true }, clientCache);
    return json(200, { rating: null, total: null, error: String(e.message || e) });
  }
};
