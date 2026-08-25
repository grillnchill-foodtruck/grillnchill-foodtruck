/**
 * geheim-upload.js
 * ----------------------------------------------------------------------------
 * Einmaliges Hinterlegen grosser Geheimnisse im Blobs-Store "geheim".
 *
 * Hintergrund: AWS begrenzt Umgebungsvariablen je Function auf 4 KB GESAMT.
 * Mit Firebase-, Google-Wallet- und Apple-Schluesseln zusammen platzte das
 * Limit beim Deploy - grosse Schluessel liegen deshalb in Netlify Blobs
 * (dort gibt es kein solches Limit), kleine Kennungen bleiben Env.
 *
 *   POST { password, name, wert }
 *     name ∈ ERLAUBT (Whitelist), wert = PEM-Text
 *
 * Nur mit dem Admin-Passwort (Inhaber), mit Anmeldebremse. Es gibt bewusst
 * KEINEN Lese-Endpunkt - was hier reingeht, kommt nur serverintern wieder raus.
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');

const ERLAUBT = ['apple-pass-key', 'apple-apns-key'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify(data),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }

  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;
  const admin = process.env.ADMIN_PASSWORD || '';
  const ok = !!admin && String(input.password || '') === admin;
  await meldeErgebnis(event, ok);
  if (!ok) return json(401, { error: 'unauthorized' });

  const name = String(input.name || '');
  if (!ERLAUBT.includes(name)) return json(400, { error: 'unknown_name', erlaubt: ERLAUBT });
  const wert = String(input.wert || '');
  if (!wert.includes('PRIVATE KEY') || wert.length > 10000) {
    return json(400, { error: 'bad_value', hint: 'Erwartet wird ein PEM-Schluessel.' });
  }

  const opts = { name: 'geheim', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  await getStore(opts).set(name, wert);
  return json(200, { ok: true, name, bytes: wert.length });
};
