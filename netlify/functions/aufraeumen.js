/**
 * aufraeumen.js
 * ----------------------------------------------------------------------------
 * Nächtlicher Lauf (netlify.toml, täglich 02:40 UTC): löscht abgelaufene
 * Einträge nach den Fristen in lib/aufraeumen.js. Nur ein Log, keine
 * Nachricht an Kubi: Es gibt nichts zu tun.
 * ----------------------------------------------------------------------------
 */
const { getStore } = require('@netlify/blobs');
const { aufraeumen } = require('./lib/aufraeumen');

function holeStore(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

exports.handler = async () => {
  try {
    const r = await aufraeumen(holeStore, { budgetMs: 22000 });
    console.log('aufraeumen:', JSON.stringify(r));
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    console.error('aufraeumen:', e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false }) };
  }
};
