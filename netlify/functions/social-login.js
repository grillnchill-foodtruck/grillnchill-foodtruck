/**
 * social-login.js
 * ----------------------------------------------------------------------------
 * Anmeldung "Mit Apple" (iOS-App, nativ) und "Mit Google" (Web + Android-App).
 *
 *   POST { anbieter: 'apple'|'google', idToken, name?, localLoyalty? }
 *        → { ok, token, email }
 *
 * Der idToken wird kryptographisch geprüft (lib/id-token.js) – erst dann gilt
 * die E-Mail als bestätigt. Danach passiert exakt dasselbe wie beim
 * E-Mail-Code in account.js: Kundendatensatz unter derselben Kennung
 * (c:sha256(email)) finden oder anlegen, Anmelde-Token ausstellen.
 *
 * WICHTIG: gleiche Kennung heißt gleiches Konto. Wer sich mal per Code und
 * mal per Google mit derselben Adresse anmeldet, landet im selben Konto samt
 * Stempelkarte. Apple-Nutzer mit verborgener Adresse (…@privaterelay.…)
 * bekommen ein Konto unter dieser Weiterleitungsadresse – Mails kommen an,
 * Apple leitet weiter.
 *
 * Das Profil holt der Browser anschließend über account.js (action 'get')
 * mit dem frischen Token – so gibt es publicProfile nur an EINER Stelle.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { pruefeIdToken } = require('./lib/id-token');

const LOYALTY_GOAL = 100;   // wie account.js
const MAX_TOKENS = 5;       // wie account.js

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, body) => ({
  statusCode, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  body: JSON.stringify(body),
});

function store() {
  const opts = { name: 'customers', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
const clean = (x, n) => String(x || '').replace(/[<>]/g, '').trim().slice(0, n);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }

  const anbieter = input.anbieter === 'apple' ? 'apple'
    : input.anbieter === 'google' ? 'google' : null;
  if (!anbieter) return json(400, { error: 'bad_provider' });

  // 1) Ausweis prüfen – bei jedem Mangel 401, ohne Details nach außen
  let ausweis;
  try {
    ausweis = await pruefeIdToken(anbieter, input.idToken);
  } catch (e) {
    console.warn('social-login abgelehnt (' + anbieter + '):', e.message);
    return json(401, { error: 'invalid_token' });
  }
  // Google bestätigt Adressen ausdrücklich; Apple-Adressen sind konstruktions-
  // bedingt verifiziert, das Feld fehlt aber manchmal – deshalb nur bei Google
  // hart darauf bestehen.
  if (anbieter === 'google' && !ausweis.emailVerified) {
    return json(401, { error: 'email_not_verified' });
  }

  const email = ausweis.email.slice(0, 120);
  const key = 'c:' + sha(email);
  const s = store();

  try {
    let rec = await s.get(key, { type: 'json' });
    if (!rec) {
      rec = {
        email, name: clean(input.name, 60), phone: '', addresses: [],
        spent: 0, rewards: 0, tokens: {}, createdAt: new Date().toISOString(),
      };
    }
    rec.email = email;
    // Name aus Apple/Google nur übernehmen, wenn noch keiner gepflegt ist –
    // was der Kunde selbst eingetragen hat, wird nicht überschrieben.
    if (!rec.name && input.name) rec.name = clean(input.name, 60);
    rec.loginVia = anbieter;

    // Einmalige Übernahme der lokalen Stempelkarte – wie in account.js
    if (!rec.merged && input.localLoyalty && typeof input.localLoyalty === 'object') {
      const ls = Math.max(0, Math.min(500, parseFloat(input.localLoyalty.spent) || 0));
      const lr = Math.max(0, Math.min(10, parseInt(input.localLoyalty.rewards, 10) || 0));
      rec.spent = (rec.spent || 0) + ls;
      rec.rewards = (rec.rewards || 0) + lr;
      while (rec.spent >= LOYALTY_GOAL) { rec.rewards += 1; rec.spent -= LOYALTY_GOAL; }
      rec.merged = true;
    }

    const token = crypto.randomBytes(24).toString('hex');
    rec.tokens = rec.tokens || {};
    const toks = Object.entries(rec.tokens).sort((a, b) => new Date(a[1]) - new Date(b[1]));
    while (toks.length >= MAX_TOKENS) { delete rec.tokens[toks.shift()[0]]; }
    rec.tokens[token] = new Date().toISOString();
    await s.setJSON(key, rec);

    return json(200, { ok: true, token, email });
  } catch (e) {
    console.error('social-login:', e);
    return json(500, { error: 'server_error' });
  }
};
