/**
 * lib/geheim.js
 * ----------------------------------------------------------------------------
 * Gemeinsamer Lader fuer grosse Geheimnisse aus dem Blobs-Store "geheim".
 *
 * AWS begrenzt Umgebungsvariablen je Function auf 4 KB GESAMT - Zertifikats-
 * und Dienstkonto-Schluessel liegen deshalb in Netlify Blobs (hochgeladen
 * einmalig ueber geheim-upload.js). Je Function-Instanz wird jeder Wert nur
 * einmal geholt und dann aus dem Cache bedient.
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');

const cache = Object.create(null);

async function holeGeheim(name) {
  if (name in cache) return cache[name];
  try {
    const opts = { name: 'geheim', consistency: 'strong' };
    if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
      opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
      opts.token = process.env.NETLIFY_BLOBS_TOKEN;
    }
    const wert = await getStore(opts).get(name);
    cache[name] = wert || null;
  } catch (e) {
    console.error('geheim:', name, e.message);
    cache[name] = null;
  }
  return cache[name];
}

module.exports = { holeGeheim };
