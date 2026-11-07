#!/usr/bin/env node
/**
 * werkzeug/google-profil-test.js
 * ----------------------------------------------------------------------------
 * Google-Unternehmensprofil (lib/google-profil.js, google-profil.js) von der
 * Verbindung bis zur Karte auf der Website:
 *
 *   node werkzeug/google-profil-test.js
 *
 * Fährt die ECHTEN Handler (google-profil, google-reviews-daily) und
 * lib/google-bewertungen.js gegen einen Blob-Speicher im Arbeitsspeicher.
 * Google (OAuth, Business Profile, Places, Translation) und Telegram sind
 * nachgebaut, nichts verlässt den Rechner.
 * ----------------------------------------------------------------------------
 */
const path = require('path');
const Module = require('module');

const DATEN = new Map();
const store = (name) => ({
  async get(k, o) { const v = DATEN.get(name + '|' + k); return v === undefined ? null : (o && o.type === 'json' ? JSON.parse(v) : v); },
  async setJSON(k, v, o) {
    const key = name + '|' + k;
    if (o && o.onlyIfNew && DATEN.has(key)) return { modified: false };
    DATEN.set(key, JSON.stringify(v)); return { modified: true };
  },
  async set(k, v) { DATEN.set(name + '|' + k, String(v)); return { modified: true }; },
  async delete(k) { DATEN.delete(name + '|' + k); },
  async list({ prefix } = {}) { return { blobs: [...DATEN.keys()].filter((k) => k.startsWith(name + '|' + (prefix || ''))).map((k) => ({ key: k.slice(name.length + 1) })) }; },
});
const lies = (name, k) => { const v = DATEN.get(name + '|' + k); return v === undefined ? null : JSON.parse(v); };
const roh = (name, k) => DATEN.get(name + '|' + k) || '';
const originalLoad = Module._load;
Module._load = function (anfrage, ...rest) {
  if (anfrage === '@netlify/blobs') return { getStore: (o) => store(typeof o === 'string' ? o : o.name) };
  return originalLoad.call(this, anfrage, ...rest);
};

Object.assign(process.env, {
  ADMIN_PASSWORD: 'admin-test', ZWEI_FAKTOR: 'aus',
  GOOGLE_PLACES_API_KEY: 'places-test-key',
  TELEGRAM_BOT_TOKEN: 'tg-test', TELEGRAM_CHAT_ID: '42',
});
delete process.env.NETLIFY_BLOBS_SITE_ID;
delete process.env.GOOGLE_PROFIL_CLIENT_ID;
delete process.env.GOOGLE_PROFIL_CLIENT_SECRET;
delete process.env.GOOGLE_TRANSLATE_API_KEY;

const F = path.join(__dirname, '..', 'netlify', 'functions');

/* --- Google nachbauen -------------------------------------------------------- */
const G = {
  freigegeben: false,       // Business-Profile-Kontingent > 0
  refreshGueltig: true,
  uebersetzenAn: true,
  aufrufe: [],
  telegram: [],
  widerrufen: [],
};
const REFRESH = 'rt-geheim-1234567890';
const ID_TOKEN = 'x.' + Buffer.from(JSON.stringify({ email: 'kubi@example.com' })).toString('base64url') + '.y';
const REZENSIONEN = [
  { reviewId: 'r1', reviewer: { displayName: 'Christina Mitrovic' }, starRating: 'FIVE', comment: 'Mega leckere Burger und nette Mitarbeiter', createTime: '2026-11-06T18:00:00Z', updateTime: '2026-11-06T18:00:00Z' },
  { reviewId: 'r2', reviewer: { displayName: 'John Smith' }, starRating: 'FIVE', comment: '(Translated by Google) Best burger in town\n\n(Original)\nBester Burger der Stadt', createTime: '2026-11-05T12:00:00Z' },
  { reviewId: 'r3', reviewer: { displayName: 'Zwen H.' }, starRating: 'THREE', comment: 'Käse vergessen', createTime: '2026-11-04T12:00:00Z' },
  { reviewId: 'r4', reviewer: { displayName: 'Ohne Text' }, starRating: 'FIVE', createTime: '2026-11-03T12:00:00Z' },
  { reviewId: 'r5', reviewer: { isAnonymous: true }, starRating: 'FIVE', comment: 'Lecker', createTime: '2026-11-02T12:00:00Z' },
];
const antwort = (status, d) => ({ ok: status >= 200 && status < 300, status, json: async () => d, text: async () => JSON.stringify(d), headers: { get: () => null } });

global.fetch = async (url, opts = {}) => {
  url = String(url);
  G.aufrufe.push(url.split('?')[0]);
  if (url === 'https://oauth2.googleapis.com/token') {
    const p = new URLSearchParams(opts.body);
    if (p.get('client_secret') !== 'secret-test') return antwort(401, { error: 'invalid_client' });
    if (p.get('grant_type') === 'authorization_code') {
      if (p.get('code') !== 'code-ok') return antwort(400, { error: 'invalid_grant' });
      if (p.get('redirect_uri') !== 'https://grillnchill-foodtruck.de/google-profil/rueckruf') return antwort(400, { error: 'redirect_uri_mismatch' });
      return antwort(200, { access_token: 'at-1', expires_in: 3600, refresh_token: REFRESH, id_token: ID_TOKEN, scope: 'https://www.googleapis.com/auth/business.manage openid email' });
    }
    if (p.get('grant_type') === 'refresh_token') {
      if (!G.refreshGueltig || p.get('refresh_token') !== REFRESH) return antwort(400, { error: 'invalid_grant' });
      return antwort(200, { access_token: 'at-2', expires_in: 3600 });
    }
  }
  if (url.startsWith('https://oauth2.googleapis.com/revoke')) { G.widerrufen.push(url); return antwort(200, {}); }
  const bearer = opts.headers && opts.headers.Authorization;
  if (url.startsWith('https://mybusiness')) {
    if (!/^Bearer at-/.test(bearer || '')) return antwort(401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
    if (!G.freigegeben) return antwort(429, { error: { code: 429, message: "Quota exceeded for quota metric 'Requests' and limit 'Requests per minute' of service 'mybusinessaccountmanagement.googleapis.com' ... limit 0", status: 'RESOURCE_EXHAUSTED' } });
  }
  if (url.startsWith('https://mybusinessaccountmanagement.googleapis.com/v1/accounts')) {
    return antwort(200, { accounts: [{ name: 'accounts/111', accountName: 'Kubi' }] });
  }
  if (url.startsWith('https://mybusinessbusinessinformation.googleapis.com/v1/accounts/111/locations')) {
    return antwort(200, { locations: [
      { name: 'locations/999', title: 'Anderer Laden', metadata: { placeId: 'ChIJanders' } },
      { name: 'locations/222', title: 'Grilln Chill', metadata: { placeId: 'ChIJJ9h4Tk09ukcRAAFxrgGWsSc' } },
    ] });
  }
  if (url.startsWith('https://mybusiness.googleapis.com/v4/accounts/111/locations/222/reviews')) {
    return antwort(200, { reviews: REZENSIONEN, averageRating: 4.93, totalReviewCount: 274 });
  }
  if (url === 'https://translation.googleapis.com/language/translate/v2') {
    if (!G.uebersetzenAn) return antwort(403, { error: { code: 403, status: 'PERMISSION_DENIED' } });
    if ((opts.headers || {})['X-Goog-Api-Key'] !== 'places-test-key') return antwort(403, {});
    const b = JSON.parse(opts.body);
    return antwort(200, { data: { translations: b.q.map((q) => ({ translatedText: '[' + b.target + '] ' + q, detectedSourceLanguage: 'de' })) } });
  }
  if (url.startsWith('https://places.googleapis.com/v1/places/')) {
    return antwort(200, { rating: 4.9, userRatingCount: 273, reviews: [
      { authorAttribution: { displayName: 'Ha Cu' }, rating: 5, text: { text: 'Toller Foodtruck', languageCode: 'de' }, publishTime: '2026-10-24T20:00:00Z' },
    ] });
  }
  if (url.startsWith('https://maps.googleapis.com/maps/api/place/details/json')) return antwort(200, { status: 'REQUEST_DENIED' });
  if (url.startsWith('https://api.telegram.org/')) { G.telegram.push(JSON.parse(opts.body).text); return antwort(200, { ok: true }); }
  throw new Error('Unerwarteter Aufruf: ' + url);
};

/* --- Prüfen ------------------------------------------------------------------ */
let fehler = 0, ok = 0;
function pruef(bed, text) { if (bed) { ok++; } else { fehler++; console.log('  FEHLER: ' + text); } }
const post = (h, body) => h({ httpMethod: 'POST', headers: { 'x-forwarded-for': '10.0.0.' + (1 + (ok % 200)) }, body: JSON.stringify(body) });
const get = (h, q) => h({ httpMethod: 'GET', headers: { 'x-forwarded-for': '10.0.1.1' }, queryStringParameters: q });
const j = (r) => JSON.parse(r.body || '{}');

(async () => {
  const { hashen } = require(F + '/lib/team-passwort.js');
  DATEN.set('team|u:lena', JSON.stringify({ name: 'Lena', role: 'staff', pwHash: await hashen('lena-test') }));

  // Module erst nach dem Umbiegen laden
  const handler = require(F + '/google-profil.js').handler;
  const daily = require(F + '/google-reviews-daily.js').handler;
  const gb = require(F + '/lib/google-bewertungen.js');

  console.log('1. Anmeldung');
  pruef((await post(handler, { action: 'status' })).statusCode === 401, 'ohne Passwort → 401');
  pruef((await post(handler, { action: 'status', password: 'lena-test' })).statusCode === 403, 'Minijobber → 403');

  console.log('2. Ohne Umgebungsvariablen');
  let r = await post(handler, { action: 'status', password: 'admin-test' });
  pruef(r.statusCode === 200 && j(r).profil.freigabe === 'nicht_eingerichtet', 'Status nicht_eingerichtet');
  pruef(j(r).profil.rueckrufUrl === 'https://grillnchill-foodtruck.de/google-profil/rueckruf', 'Weiterleitungs-URI im Status');
  r = await post(handler, { action: 'start', password: 'admin-test' });
  pruef(r.statusCode === 409, 'start ohne Client → 409');

  process.env.GOOGLE_PROFIL_CLIENT_ID = 'client-test.apps.googleusercontent.com';
  process.env.GOOGLE_PROFIL_CLIENT_SECRET = 'secret-test';

  console.log('3. Verbinden starten');
  r = await post(handler, { action: 'status', password: 'admin-test' });
  pruef(j(r).profil.freigabe === 'nicht_verbunden', 'Status nicht_verbunden');
  r = await post(handler, { action: 'start', password: 'admin-test' });
  const startUrl = new URL(j(r).url);
  pruef(startUrl.origin === 'https://accounts.google.com', 'Google-Anmeldung als Ziel');
  pruef(startUrl.searchParams.get('access_type') === 'offline' && startUrl.searchParams.get('prompt') === 'consent', 'offline + consent (Refresh-Token)');
  pruef(startUrl.searchParams.get('scope').includes('business.manage'), 'Scope business.manage');
  const state = startUrl.searchParams.get('state');

  console.log('4. Rücksprung');
  r = await get(handler, { error: 'access_denied', state });
  pruef(r.statusCode === 302 && r.headers.Location === '/admin?google=abgebrochen', 'Abbruch → abgebrochen');
  r = await get(handler, { code: 'code-ok', state: 'f'.repeat(48) });
  pruef(r.headers.Location === '/admin?google=abgelaufen', 'fremder state → abgelaufen');
  r = await get(handler, { code: 'code-ok', state });
  pruef(r.headers.Location === '/admin?google=verbunden', 'gültiger Rücksprung → verbunden');
  r = await get(handler, { code: 'code-ok', state });
  pruef(r.headers.Location === '/admin?google=abgelaufen', 'state nur einmal gültig');
  pruef(!roh('google-reviews', 'profil:verbindung').includes(REFRESH), 'Refresh-Token liegt nicht im Klartext');
  r = await post(handler, { action: 'status', password: 'admin-test' });
  let p = j(r).profil;
  pruef(p.verbunden && p.konto === 'kubi@example.com', 'Konto erkannt');
  pruef(p.freigabe === 'wartet_auf_freigabe', 'Kontingent 0 → wartet_auf_freigabe (ist: ' + p.freigabe + ')');
  pruef(!JSON.stringify(j(r)).includes(REFRESH) && !JSON.stringify(j(r)).includes('at-1'), 'Status verrät keine Tokens');

  console.log('5. Morgenlauf vor der Freigabe');
  await daily({});
  pruef(G.telegram.length === 0, 'kein Telegram, solange Google nicht freigibt');
  let de = lies('google-reviews', 'data:de');
  pruef(de && de.total === 273 && de.quellen.profil === 'aus', 'Places läuft weiter wie bisher');

  console.log('6. Google gibt frei');
  G.freigegeben = true;
  await daily({});
  pruef(G.telegram.some((t) => t.includes('Unternehmensprofil') && t.includes('274')), 'Telegram meldet die Freigabe einmal');
  const neueste = lies('google-reviews', 'profil:neueste');
  pruef(neueste && neueste.total === 274 && neueste.rating === 4.9, 'Anzahl und Schnitt aus dem Profil');
  pruef(neueste.reviews.length === 4, 'nur Rezensionen mit Text (4)');
  const john = neueste.reviews.find((x) => x.id === 'r2');
  pruef(john && john.texte.de === 'Bester Burger der Stadt', 'Original statt Google-Übersetzung');
  pruef(john.texte.en === '[en] Bester Burger der Stadt', 'übersetzt ins Englische');
  pruef(neueste.reviews.find((x) => x.id === 'r1').texte.de === 'Mega leckere Burger und nette Mitarbeiter', 'Originalsprache bleibt unverändert');
  de = lies('google-reviews', 'data:de');
  const en = lies('google-reviews', 'data:en');
  pruef(de.total === 274, 'Website-Zahl nimmt das Maximum (274)');
  pruef(de.rating === 4.9, 'Sterne aus dem Profil');
  pruef(de.reviews[0].name === 'Christina M.' && de.reviews[0].date === '2026-11-06T18:00:00Z', 'neueste Rezension vorne, Name gekürzt');
  pruef(!de.reviews.some((x) => x.name.startsWith('Zwen')), '3 Sterne bleiben draußen');
  pruef(de.reviews.some((x) => x.name === 'Ha C.'), 'Places-Rezension bleibt im Archiv');
  pruef(en.reviews.find((x) => x.name === 'John S.').text === '[en] Bester Burger der Stadt', 'Englische Seite zeigt die Übersetzung');
  pruef(de.reviews.some((x) => x.name === 'Google-Nutzer'), 'anonyme Rezension als Google-Nutzer');

  console.log('7. Zweiter Lauf übersetzt nichts doppelt');
  const vorher = G.aufrufe.filter((u) => u.includes('translate')).length;
  G.telegram.length = 0;
  await daily({});
  pruef(G.aufrufe.filter((u) => u.includes('translate')).length === vorher, 'keine erneute Übersetzung');
  pruef(G.telegram.length === 0, 'keine zweite Freigabe-Meldung');

  console.log('8. Übersetzung gesperrt');
  REZENSIONEN.unshift({ reviewId: 'r0', reviewer: { displayName: 'Neu Kunde' }, starRating: 'FIVE', comment: 'Ganz frisch', createTime: '2026-11-07T08:00:00Z' });
  G.uebersetzenAn = false;
  r = await post(handler, { action: 'testen', password: 'admin-test' });
  pruef(j(r).ok && j(r).profil.uebersetzung === 'fehler', 'Abruf klappt, Übersetzung als fehlend gemeldet');
  pruef(lies('google-reviews', 'profil:neueste').reviews[0].texte.en === 'Ganz frisch', 'ohne Übersetzung zeigt jede Sprache das Original');
  G.uebersetzenAn = true;
  await daily({});
  pruef(lies('google-reviews', 'profil:neueste').reviews[0].texte.en === '[en] Ganz frisch', 'nächster Lauf holt die Übersetzung nach');

  console.log('9. Google beendet die Verbindung');
  G.refreshGueltig = false;
  // Access-Token der Instanz verfällt nicht im Test: Modul neu laden
  delete require.cache[require.resolve(F + '/lib/google-profil.js')];
  delete require.cache[require.resolve(F + '/lib/google-bewertungen.js')];
  delete require.cache[require.resolve(F + '/google-reviews-daily.js')];
  delete require.cache[require.resolve(F + '/google-profil.js')];
  const daily2 = require(F + '/google-reviews-daily.js').handler;
  const handler2 = require(F + '/google-profil.js').handler;
  G.telegram.length = 0;
  await daily2({});
  p = j(await post(handler2, { action: 'status', password: 'admin-test' })).profil;
  pruef(p.freigabe === 'neu_verbinden', 'Status neu_verbinden');
  pruef(G.telegram.some((t) => t.includes('neu verbinden')), 'Telegram-Hinweis');
  G.telegram.length = 0;
  await daily2({});
  pruef(G.telegram.length === 0, 'Hinweis höchstens einmal pro Woche');
  pruef(lies('google-reviews', 'data:de').total === 274, 'Website behält den letzten Stand');

  console.log('10. Trennen');
  G.refreshGueltig = true;
  r = await post(handler2, { action: 'trennen', password: 'admin-test' });
  pruef(r.statusCode === 200 && j(r).profil.freigabe === 'nicht_verbunden', 'getrennt');
  pruef(G.widerrufen.length === 1, 'Token bei Google widerrufen');
  pruef(!lies('google-reviews', 'profil:verbindung') && !lies('google-reviews', 'profil:neueste'), 'Verbindung und Profil-Daten gelöscht');

  console.log('11. Kommentar-Formate');
  const { originalText } = require(F + '/lib/google-profil.js');
  pruef(originalText('(Translated by Google) Hi\n\n(Original)\nHallo') === 'Hallo', 'Original aus Übersetzung');
  pruef(originalText('Nur Text') === 'Nur Text', 'normaler Text bleibt');

  console.log('\n' + (fehler ? '✗ ' + fehler + ' Fehler, ' : '✓ ') + ok + ' Prüfungen bestanden');
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
