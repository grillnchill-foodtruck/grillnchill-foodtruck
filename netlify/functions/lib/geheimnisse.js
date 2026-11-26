'use strict';
/**
 * lib/geheimnisse.js
 * Gemeinsame Geheimnisse mit dem GNC Office liegen in den Netlify Blobs (Store geheimnisse), nicht als
 * Umgebungsvariable: Im Lambda-Modus dürfen alle Umgebungsvariablen zusammen nur 4 KB groß sein, und die
 * Seite liegt knapp darunter. Eine gleichnamige Umgebungsvariable geht vor (lokale Tests).
 */
const { getStore } = require('@netlify/blobs');

async function geheimnisHolen(schluessel, umgebungsName) {
  if (umgebungsName && process.env[umgebungsName]) return process.env[umgebungsName];
  try {
    const o = { name: 'geheimnisse', consistency: 'strong' };
    if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) { o.siteID = process.env.NETLIFY_BLOBS_SITE_ID; o.token = process.env.NETLIFY_BLOBS_TOKEN; }
    return String((await getStore(o).get(schluessel)) || '').trim();
  } catch (e) {
    console.error('geheimnisse: nicht lesbar', schluessel, e && e.message);
    return '';
  }
}

module.exports = { geheimnisHolen };
