/**
 * lib/google-profil.js
 * ----------------------------------------------------------------------------
 * Rezensionen direkt aus dem Google-Unternehmensprofil (Business Profile API).
 *
 * Warum: Die Places API gibt nur 5 „relevante“ Rezensionen heraus, nie die
 * neuesten. Neue Rezensionen mussten deshalb von Hand nachgetragen werden.
 * Die Business Profile API liefert alle Rezensionen, neueste zuerst, dazu
 * Schnitt und Anzahl. Sie verlangt aber eine einmalige Verbindung mit dem
 * Google-Konto, das das Profil verwaltet (Inhaber oder Manager), und eine
 * Freigabe durch Google für das Cloud-Projekt (vorher Kontingent 0).
 *
 * Ablauf:
 *   1. Admin-Tool → Feedback → „Mit Google verbinden“ (google-profil.js, start)
 *   2. Google-Anmeldung, Rücksprung auf /google-profil/rueckruf
 *   3. Der Refresh-Token liegt verschlüsselt im Blob profil:verbindung.
 *      Schlüssel = Hash aus GOOGLE_PROFIL_CLIENT_SECRET, der Blob allein
 *      reicht also nicht, um an das Konto zu kommen.
 *   4. Der tägliche Lauf (google-reviews-daily.js) ruft aktualisiereProfil()
 *      auf: holt die neuesten Rezensionen, übersetzt neue Texte einmal in die
 *      8 Sprachen (Cloud Translation, optional) und legt alles in
 *      profil:neueste ab. lib/google-bewertungen.js mischt das in jede Sprache.
 *
 * Fehlt etwas (Umgebungsvariablen, Verbindung, Freigabe), läuft alles wie
 * vorher über die Places API weiter. Diese Datei wirft nach außen nie.
 *
 * Netlify-Umgebungsvariablen:
 *   GOOGLE_PROFIL_CLIENT_ID      OAuth-Client (Webanwendung) aus der Cloud Console
 *   GOOGLE_PROFIL_CLIENT_SECRET  dazu das Secret (GEHEIM, nie ins Repo)
 * Optional:
 *   GOOGLE_TRANSLATE_API_KEY     Schlüssel mit „Cloud Translation API“; fehlt er,
 *                                wird GOOGLE_PLACES_API_KEY versucht. Klappt beides
 *                                nicht, zeigt jede Sprache den Originaltext.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'google-reviews';
const K_VERBINDUNG = 'profil:verbindung';
const K_STATUS = 'profil:status';
const K_NEUESTE = 'profil:neueste';
const K_TEXT = 'profil:text:';          // + reviewId → { orig, quelle, de, en, … }
const K_OAUTH = 'profil:oauth:';        // + Hash des state-Werts, 15 Minuten gültig

const LANGS = ['de', 'en', 'tr', 'it', 'es', 'pt', 'fr', 'nl'];
const SCOPES = ['https://www.googleapis.com/auth/business.manage', 'openid', 'email'];
const BASIS_URL = 'https://grillnchill-foodtruck.de';
const RUECKRUF_PFAD = '/google-profil/rueckruf';
const OAUTH_TTL_MS = 15 * 60 * 1000;
const ANZAHL = 30;                      // so viele neueste Rezensionen je Abruf
const STERNE = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };
const DEFAULT_PLACE_ID = 'ChIJJ9h4Tk09ukcRAAFxrgGWsSc';

function store() {
  const opts = { name: STORE_NAME, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}
async function lies(key) { try { return await store().get(key, { type: 'json' }); } catch (e) { return null; } }
async function schreib(key, wert) { try { await store().setJSON(key, wert); return true; } catch (e) { return false; } }
async function loesch(key) { try { await store().delete(key); } catch (e) {} }

const clientId = () => process.env.GOOGLE_PROFIL_CLIENT_ID || '';
const clientSecret = () => process.env.GOOGLE_PROFIL_CLIENT_SECRET || '';
const eingerichtet = () => !!(clientId() && clientSecret());
const rueckrufUrl = () => (process.env.GOOGLE_PROFIL_BASIS_URL || BASIS_URL).replace(/\/+$/, '') + RUECKRUF_PFAD;
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* --- Refresh-Token verschlüsselt ablegen ----------------------------------- */
function schluessel() {
  return crypto.createHash('sha256').update('gnc-google-profil:' + clientSecret()).digest();
}
function verschluesseln(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', schluessel(), iv);
  const daten = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), daten: daten.toString('base64') };
}
function entschluesseln(v) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', schluessel(), Buffer.from(v.iv, 'base64'));
    d.setAuthTag(Buffer.from(v.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(v.daten, 'base64')), d.final()]).toString('utf8');
  } catch (e) { return null; }   // Secret gewechselt → neu verbinden
}

/* --- Status ---------------------------------------------------------------- */
async function leseStatus() { return (await lies(K_STATUS)) || {}; }
async function schreibeStatus(teil) {
  const alt = await leseStatus();
  const neu = { ...alt, ...teil };
  await schreib(K_STATUS, neu);
  return neu;
}

/* --- OAuth ----------------------------------------------------------------- */
async function startUrl(wer) {
  const state = crypto.randomBytes(24).toString('hex');
  await schreib(K_OAUTH + hash(state), { at: Date.now(), wer: wer || null });
  const p = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: rueckrufUrl(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',            // sonst gibt Google beim zweiten Mal keinen Refresh-Token
    include_granted_scopes: 'true',
    state,
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

// state prüfen und sofort verbrauchen (einmal gültig)
async function stateEinloesen(state) {
  if (!state || !/^[a-f0-9]{48}$/.test(state)) return null;
  const key = K_OAUTH + hash(state);
  const d = await lies(key);
  await loesch(key);
  if (!d || Date.now() - d.at > OAUTH_TTL_MS) return null;
  return d;
}

function emailAusIdToken(idToken) {
  try {
    const teil = String(idToken || '').split('.')[1];
    const p = JSON.parse(Buffer.from(teil.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return p.email || null;
  } catch (e) { return null; }
}

async function tokenAnfrage(params) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId(), client_secret: clientSecret(), ...params }).toString(),
  });
  const d = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, d };
}

/** Rücksprung von Google: Code gegen Tokens tauschen und ablegen. */
async function verbinden(code, wer) {
  const r = await tokenAnfrage({ code, grant_type: 'authorization_code', redirect_uri: rueckrufUrl() });
  if (!r.ok || !r.d.refresh_token) {
    return { ok: false, grund: r.ok ? 'kein_refresh_token' : (r.d.error || 'token_' + r.status) };
  }
  const konto = emailAusIdToken(r.d.id_token);
  await schreib(K_VERBINDUNG, {
    token: verschluesseln(r.d.refresh_token),
    konto, wer: wer || null, at: Date.now(),
    scope: r.d.scope || '',
  });
  ZUGRIFF = { token: r.d.access_token, bis: Date.now() + ((r.d.expires_in || 3600) - 120) * 1000 };
  await schreibeStatus({ verbundenAm: Date.now(), konto, standort: null, freigabe: 'unbekannt', letzterFehler: null });
  // Gleich prüfen, ob Google das Projekt schon freigegeben hat (ohne zu werfen).
  // Ohne Übersetzung, damit der Rücksprung schnell bleibt; die übernimmt der Morgenlauf.
  const probe = await aktualisiereProfil({ ohneUebersetzung: true });
  return { ok: true, konto, freigabe: probe.freigabe };
}

async function trennen() {
  const v = await lies(K_VERBINDUNG);
  const rt = v && v.token ? entschluesseln(v.token) : null;
  if (rt) {
    try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(rt), { method: 'POST' }); } catch (e) {}
  }
  await loesch(K_VERBINDUNG);
  await loesch(K_NEUESTE);
  ZUGRIFF = null;
  await schreibeStatus({ verbundenAm: null, konto: null, standort: null, freigabe: 'nicht_verbunden', getrenntAm: Date.now() });
}

let ZUGRIFF = null;   // Access-Token je Function-Instanz

class ProfilFehler extends Error {
  constructor(art, text, extra) { super(text || art); this.art = art; this.extra = extra || null; }
}

async function zugriffstoken() {
  if (ZUGRIFF && ZUGRIFF.bis > Date.now()) return ZUGRIFF.token;
  const v = await lies(K_VERBINDUNG);
  if (!v || !v.token) throw new ProfilFehler('nicht_verbunden');
  const rt = entschluesseln(v.token);
  if (!rt) throw new ProfilFehler('neu_verbinden', 'Token nicht lesbar (Client-Secret gewechselt?)');
  const r = await tokenAnfrage({ refresh_token: rt, grant_type: 'refresh_token' });
  if (!r.ok) {
    // invalid_grant = widerrufen, Passwort geändert oder App noch im Testmodus (7 Tage)
    if (r.d.error === 'invalid_grant') throw new ProfilFehler('neu_verbinden', 'Google hat die Verbindung beendet');
    throw new ProfilFehler('fehler', 'Token-Abruf ' + (r.d.error || r.status));
  }
  ZUGRIFF = { token: r.d.access_token, bis: Date.now() + ((r.d.expires_in || 3600) - 120) * 1000 };
  return ZUGRIFF.token;
}

// Google-Fehler in eine Kategorie übersetzen, die das Admin-Tool erklären kann
function einordnen(status, body) {
  const err = (body && body.error) || {};
  const details = Array.isArray(err.details) ? err.details : [];
  const reasons = details.map(d => d && d.reason).filter(Boolean);
  const dienst = (details.find(d => d && d.metadata && d.metadata.service) || {}).metadata;
  const text = String(err.message || '');
  if (status === 429 || reasons.includes('RATE_LIMIT_EXCEEDED') || /quota/i.test(text)) {
    return new ProfilFehler('wartet_auf_freigabe', 'Kontingent 0: Google hat das Projekt noch nicht freigegeben');
  }
  if (reasons.includes('SERVICE_DISABLED') || /has not been used|is disabled|accessNotConfigured/i.test(text)) {
    return new ProfilFehler('api_nicht_aktiviert', 'API im Cloud-Projekt nicht aktiviert', { dienst: dienst && dienst.service || null });
  }
  if (status === 401) return new ProfilFehler('neu_verbinden', 'Anmeldung abgelaufen');
  if (status === 403) return new ProfilFehler('kein_zugriff', text.slice(0, 200));
  return new ProfilFehler('fehler', 'HTTP ' + status + (text ? ': ' + text.slice(0, 160) : ''));
}

async function api(url) {
  const token = await zugriffstoken();
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw einordnen(res.status, d);
  return d;
}

/* --- Standort finden ------------------------------------------------------- */
async function standortFinden() {
  const placeId = process.env.GOOGLE_PLACE_ID || DEFAULT_PLACE_ID;
  const konten = await api('https://mybusinessaccountmanagement.googleapis.com/v1/accounts?pageSize=20');
  let ersatz = null;
  for (const k of (konten.accounts || [])) {
    const orte = await api('https://mybusinessbusinessinformation.googleapis.com/v1/' + k.name
      + '/locations?readMask=name,title,metadata&pageSize=100');
    for (const o of (orte.locations || [])) {
      const ziel = { konto: k.name, ort: o.name, titel: o.title || '' };
      if (o.metadata && o.metadata.placeId === placeId) return ziel;
      if (!ersatz && /grill.?n.?chill/i.test(o.title || '')) ersatz = ziel;
    }
  }
  if (ersatz) return ersatz;
  throw new ProfilFehler('kein_standort', 'Dieses Google-Konto verwaltet das Profil von Grill\'n Chill nicht');
}

/* --- Rezensionen ----------------------------------------------------------- */
// „(Translated by Google) … (Original) …“ → nur das Original
function originalText(c) {
  const s = String(c || '');
  const m = s.match(/\(Original\)\s*([\s\S]*)$/);
  return (m ? m[1] : s.replace(/^\(Translated by Google\)\s*/, '')).trim();
}

function ausProfil(r) {
  const stars = STERNE[r && r.starRating] || 0;
  const name = r && r.reviewer && !r.reviewer.isAnonymous ? r.reviewer.displayName : 'Google-Nutzer';
  return {
    id: String((r && r.reviewId) || hash((r && r.name) || Math.random())).slice(0, 80),
    name: name || 'Google-Nutzer',
    stars,
    text: originalText(r && r.comment),
    date: (r && (r.createTime || r.updateTime)) || null,
  };
}

/* --- Übersetzen (Cloud Translation v2, optional) --------------------------- */
async function uebersetze(texte, ziel) {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error('kein Schlüssel');
  // Schlüssel im Header, nicht in der URL (landet so nie in einem Log)
  const res = await fetch('https://translation.googleapis.com/language/translate/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
    body: JSON.stringify({ q: texte, target: ziel, format: 'text' }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.data || !Array.isArray(d.data.translations)) {
    throw new Error('Übersetzung ' + res.status + ' ' + ((d.error && d.error.status) || ''));
  }
  return d.data.translations.map(t => ({ text: t.translatedText, quelle: t.detectedSourceLanguage || null }));
}

// Neue Texte einmal in alle Sprachen übersetzen und je Rezension merken.
async function texteFuer(liste, ohneUebersetzung) {
  const ergebnis = new Map();
  const offen = [];
  const gemerkt = await Promise.all(liste.map(r => lies(K_TEXT + r.id)));
  liste.forEach((r, i) => {
    const t = gemerkt[i];
    if (t && t.orig === r.text && (t.fertig || ohneUebersetzung)) ergebnis.set(r.id, t);
    else offen.push(r);
  });
  if (!offen.length) return { texte: ergebnis, uebersetzung: 'nichts_neu' };
  const basis = offen.map(r => ({ orig: r.text, quelle: null, fertig: false }));
  let uebersetzung = 'aus';
  if (!ohneUebersetzung) {
    try {
      for (const lang of LANGS) {
        const out = await uebersetze(offen.map(r => r.text), lang);
        out.forEach((o, i) => {
          basis[i][lang] = o.text;
          if (o.quelle && !basis[i].quelle) basis[i].quelle = o.quelle;
        });
      }
      basis.forEach(b => {
        b.fertig = true;
        if (b.quelle && LANGS.includes(b.quelle)) b[b.quelle] = b.orig;   // Originalsprache unverändert
      });
      uebersetzung = 'ok';
    } catch (e) {
      uebersetzung = 'fehler';   // nächster Lauf versucht es wieder, bis dahin Original
    }
  }
  offen.forEach((r, i) => ergebnis.set(r.id, basis[i]));
  await Promise.all(offen.map((r, i) => schreib(K_TEXT + r.id, basis[i])));
  return { texte: ergebnis, uebersetzung };
}

/**
 * Holt die neuesten Rezensionen und legt sie in profil:neueste ab.
 * Wirft nie; gibt { freigabe, anzahl, total, rating } zurück.
 */
async function aktualisiereProfil(opts) {
  opts = opts || {};
  if (!eingerichtet()) return { freigabe: 'nicht_eingerichtet' };
  const verbindung = await lies(K_VERBINDUNG);
  if (!verbindung) return { freigabe: 'nicht_verbunden' };
  const alt = await leseStatus();
  const jetzt = Date.now();
  try {
    let standort = alt.standort && alt.standort.ort ? alt.standort : null;
    if (!standort) standort = await standortFinden();
    const d = await api('https://mybusiness.googleapis.com/v4/' + standort.konto + '/' + standort.ort
      + '/reviews?pageSize=' + ANZAHL + '&orderBy=' + encodeURIComponent('updateTime desc'));
    const alle = (d.reviews || []).map(ausProfil);
    const mitText = alle.filter(r => r.text);
    const { texte, uebersetzung } = await texteFuer(mitText, opts.ohneUebersetzung);
    const reviews = mitText.map(r => {
      const t = texte.get(r.id) || { orig: r.text };
      const je = {};
      for (const l of LANGS) je[l] = t[l] || t.orig;
      return { id: r.id, name: r.name, stars: r.stars, date: r.date, quelle: t.quelle || null, texte: je };
    });
    const daten = {
      at: jetzt,
      total: typeof d.totalReviewCount === 'number' ? d.totalReviewCount : null,
      rating: typeof d.averageRating === 'number' ? Math.round(d.averageRating * 10) / 10 : null,
      reviews,
    };
    await schreib(K_NEUESTE, daten);
    const neuerStatus = await schreibeStatus({
      standort, freigabe: 'ok', letzterVersuch: jetzt, letzterErfolg: jetzt, letzterFehler: null,
      anzahl: daten.total, rating: daten.rating, geholt: alle.length, uebersetzung,
      neuesteVom: alle.length ? alle.map(r => r.date).filter(Boolean).sort().pop() : null,
    });
    return { freigabe: 'ok', anzahl: alle.length, total: daten.total, rating: daten.rating, vorher: alt.freigabe, status: neuerStatus };
  } catch (e) {
    const art = e instanceof ProfilFehler ? e.art : 'fehler';
    await schreibeStatus({
      freigabe: art, letzterVersuch: jetzt, letzterFehler: String(e.message || e).slice(0, 240),
      fehlerExtra: e.extra || null, ...(art === 'kein_standort' ? { standort: null } : {}),
    });
    return { freigabe: art, vorher: alt.freigabe, fehler: String(e.message || e) };
  }
}

/** Für lib/google-bewertungen.js: zuletzt geholte Profil-Rezensionen. */
async function leseNeueste() {
  const d = await lies(K_NEUESTE);
  return d && Array.isArray(d.reviews) ? d : null;
}

/** Für das Admin-Tool: nur Zustände und Zahlen, nie Tokens. */
async function uebersicht() {
  const s = await leseStatus();
  const v = await lies(K_VERBINDUNG);
  let freigabe = s.freigabe || null;
  if (!eingerichtet()) freigabe = 'nicht_eingerichtet';
  else if (!v) freigabe = 'nicht_verbunden';
  return {
    eingerichtet: eingerichtet(),
    verbunden: !!v,
    konto: v ? (v.konto || null) : null,
    verbundenAm: v ? v.at : null,
    standort: s.standort ? (s.standort.titel || 'gefunden') : null,
    freigabe,
    letzterVersuch: s.letzterVersuch || null,
    letzterErfolg: s.letzterErfolg || null,
    letzterFehler: freigabe === 'ok' ? null : (s.letzterFehler || null),
    dienst: s.fehlerExtra && s.fehlerExtra.dienst ? s.fehlerExtra.dienst : null,
    anzahl: s.anzahl != null ? s.anzahl : null,
    rating: s.rating != null ? s.rating : null,
    neuesteVom: s.neuesteVom || null,
    uebersetzung: s.uebersetzung || null,
    rueckrufUrl: rueckrufUrl(),
  };
}

module.exports = {
  LANGS, eingerichtet, rueckrufUrl, startUrl, stateEinloesen, verbinden, trennen,
  aktualisiereProfil, leseNeueste, uebersicht, leseStatus, schreibeStatus, originalText, ausProfil,
};
