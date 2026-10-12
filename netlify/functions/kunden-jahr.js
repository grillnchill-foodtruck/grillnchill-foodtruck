/**
 * kunden-jahr.js
 * ----------------------------------------------------------------------------
 * "Dein Burger-Jahr": Jahresrueckblick und Abzeichen fuer das eigene Konto.
 *
 *   POST { email, token, year?, preview? }
 *   -> { ok, year,
 *        window: { open, from: 'YYYY-12-01', to: 'YYYY+1-01-15' },
 *        review: jahresRueckblick(...),
 *        badges: [ { id, key, scope, icon, title_de, desc_de, need, have,
 *                    earned, earnedAt?, year? }, ... ] }
 *
 * Anmeldung wie wallet-pass.js: E-Mail + gueltiges Konto-Token, geprueft
 * ueber lib/kunden-token.js.
 *
 * Das Rueckblick-Fenster ist vom 1. Dezember bis 15. Januar offen (Berlin).
 * Ohne year gilt: im Fenster das Jahr des Fensters (Januar -> Vorjahr),
 * sonst das laufende Jahr. preview: true oeffnet das Fenster zum Testen;
 * das ist unbedenklich, es sind ohnehin nur die eigenen Daten.
 * Die Abzeichen werden immer mitgeliefert, auch bei geschlossenem Fenster.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { tokenGueltig } = require('./lib/kunden-token');
const { badges, jahresRueckblick, berlinTeile } = require('./lib/abzeichen');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  body: JSON.stringify(data),
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

/** Fenster fuer ein Jahr und ob es heute (Berlin) offen ist. */
function fenster(jahr, heute) {
  const from = jahr + '-12-01';
  const to = (jahr + 1) + '-01-15';
  return { open: heute >= from && heute <= to, from, to };
}

/** Standardjahr: im Fenster das Jahr des Fensters, sonst das laufende. */
function standardJahr(jetzt) {
  if (jetzt.month === 1 && jetzt.day <= 15) return jetzt.year - 1;
  return jetzt.year;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }

  // Konto-Auth wie in wallet-pass.js
  const email = String(input.email || '').trim().toLowerCase().slice(0, 120);
  const token = String(input.token || '').slice(0, 80);
  if (!email || !token) return json(401, { error: 'unauthorized' });
  let rec;
  try {
    rec = await store().get('c:' + sha(email), { type: 'json' });
  } catch (e) {
    return json(500, { error: 'read_failed' });
  }
  if (!tokenGueltig(rec, token)) return json(401, { error: 'unauthorized' });

  const jetzt = berlinTeile(new Date());
  let jahr = standardJahr(jetzt);
  const wunsch = parseInt(input.year, 10);
  if (isFinite(wunsch) && wunsch >= 2024 && wunsch <= jetzt.year) jahr = wunsch;

  const preview = input.preview === true;
  const w = fenster(jahr, jetzt.ymd);
  if (preview) w.open = true;

  try {
    return json(200, {
      ok: true,
      year: jahr,
      window: w,
      preview,
      review: jahresRueckblick(rec.stats, jahr),
      badges: badges(rec.stats, jahr, rec.badgesAt),
    });
  } catch (e) {
    console.error('kunden-jahr:', e && e.message);
    return json(500, { error: 'stats_failed' });
  }
};

// Fuer Tests
exports._intern = { fenster, standardJahr };
