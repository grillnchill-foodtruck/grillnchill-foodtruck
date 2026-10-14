/**
 * google-reviews.js
 * ----------------------------------------------------------------------------
 * Liefert die aktuelle Google-Bewertung (Sterne + Anzahl) für die Hero-Zeile
 * und die gesammelten Rezensionen (neueste zuerst) für das Karussell.
 *
 *   GET /google-reviews?lang=de   →  { rating: 5.0, total: 255, reviews: [...], cached: true|false, ... }
 *
 * lang = de|en|tr|it|es|pt|fr|nl – Google übersetzt die Rezensionstexte selbst in
 * die gewünschte Sprache. Je Sprache eigener Cache-Eintrag (data:<lang>).
 * Rezensionen ohne Text oder unter 5 Sternen werden nicht ausgeliefert; Namen
 * werden auf „Vorname N.“ gekürzt (wie die fest hinterlegten Zitate).
 *
 * Aufgefrischt wird jeden Morgen durch google-reviews-daily.js (Zeitplan in
 * netlify.toml). Ist der Cache trotzdem älter als 24 h, fragt diese Function
 * selbst bei Google nach, nach einem Fehlschlag aber höchstens einmal pro
 * Stunde. Die eigentliche Abruf-Logik liegt in lib/google-bewertungen.js.
 *
 * Benötigte Environment Variable in Netlify:
 *   GOOGLE_PLACES_API_KEY = API-Key mit aktivierter "Places API (New)"
 *                           (optional zusätzlich "Places API" für die neuesten 5)
 * Optional:
 *   GOOGLE_PLACE_ID       = Place-ID (Default = Grill'n Chill)
 *
 * Fehlt der Key oder schlägt Google fehl, wird – falls vorhanden – der letzte
 * gecachte Wert geliefert; sonst liefert die Function null und die Seite
 * behält ihre fest hinterlegten Fallback-Zahlen.
 * ----------------------------------------------------------------------------
 */

const g = require('./lib/google-bewertungen');

const RETRY_PAUSE_MS = 60 * 60 * 1000;

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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'method_not_allowed' });
  }

  const q = event.queryStringParameters || {};
  const lang = g.LANGS.indexOf(q.lang) !== -1 ? q.lang : 'de';

  // Browser/CDN darf das Ergebnis ein paar Stunden cachen (entlastet die Function).
  const clientCache = { 'Cache-Control': 'public, max-age=21600' };

  const cached = await g.leseCache(lang);
  const fresh = cached && (Date.now() - cached.fetchedAt < g.CACHE_TTL_MS);
  const ausCache = (c, extra) => json(200, {
    rating: c.rating, total: c.total, reviews: Array.isArray(c.reviews) ? c.reviews : [],
    lang, cached: true, fetchedAt: new Date(c.fetchedAt).toISOString(), ...(extra || {}),
  }, clientCache);

  // 1) Frischer Cache → direkt ausliefern, kein Google-Aufruf.
  // "fetchedAt" steht mit in der Antwort: so lässt sich von außen mit einem
  // einzigen Aufruf prüfen, ob die tägliche Auffrischung läuft.
  if (fresh) return ausCache(cached);

  // 2) Gerade erst fehlgeschlagen → Google nicht bei jedem Besucher erneut fragen.
  const status = await g.leseStatus();
  const kuerzlich = status.letzterVersuch && (Date.now() - status.letzterVersuch < RETRY_PAUSE_MS);
  if (kuerzlich && status.fehlerSeit) {
    const extra = { stale: true, error: status.letzterFehler || null, diag: status.diag || null, fehlerSeit: new Date(status.fehlerSeit).toISOString() };
    if (cached) return ausCache(cached, extra);
    return json(200, { rating: null, total: null, reviews: [], lang, ...extra });
  }

  // 3) Cache abgelaufen/leer → bei Google nachfragen.
  try {
    const d = await g.aktualisiere(lang);
    await g.schreibeStatus({ letzterVersuch: Date.now(), letzterErfolg: d.fetchedAt, fehlerSeit: null, letzterFehler: null, diag: null });
    return json(200, {
      rating: d.rating, total: d.total, reviews: d.reviews, lang, cached: false,
      fetchedAt: new Date(d.fetchedAt).toISOString(), ueber: d.ueber, quellen: d.quellen,
    }, clientCache);
  } catch (e) {
    // Google-Fehler → falls vorhanden veralteten Cache liefern, sonst null.
    const diag = e.diag || null;
    console.error('google-reviews: Google lehnt ab', JSON.stringify(diag));
    const jetzt = Date.now();
    await g.schreibeStatus({ letzterVersuch: jetzt, fehlerSeit: status.fehlerSeit || jetzt, letzterFehler: String(e.message || e), diag });
    if (cached) return ausCache(cached, { stale: true, error: String(e.message || e), diag });
    return json(200, { rating: null, total: null, reviews: [], lang, error: String(e.message || e), diag });
  }
};
