/**
 * lieblingstag.js
 * ----------------------------------------------------------------------------
 * Kunde schaltet die Erinnerung zum Lieblingstag ein oder aus (lib/lieblingstag.js).
 *
 *   POST { action: 'status', email, token }
 *   POST { action: 'an',  email, token, lang, subscription?, ios? }
 *        subscription = Web-Push-Abo dieses Browsers; ios = true in der iOS-App,
 *        dann vergibt der Server ein persönliches FCM-Thema, das die App abonniert.
 *   POST { action: 'aus', email, token }   → liefert das alte Thema zum Abbestellen
 *
 * Nur mit gültigem Konto-Token. Gespeichert wird im Kundendatensatz
 * (rec.lieblingstag), dazu ein Verzeichnis-Eintrag im Store "lieblingstag".
 * ----------------------------------------------------------------------------
 */
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { tokenGueltig } = require('./lib/kunden-token');
const { schutz, saeubern } = require('./lib/bremse');
const { fuerKonto } = require('./lib/lieblingstag');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, data) => ({ statusCode, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(data) });
function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
const normEmail = (e) => String(e || '').trim().toLowerCase().slice(0, 120);
const SPRACHEN = ['de', 'en', 'tr', 'it', 'es', 'pt', 'fr', 'nl'];
const MAX_WEB = 3;

/* Web-Push-Abo prüfen: nur https-Endpunkt und die zwei Schlüssel, sonst nichts übernehmen. */
function aboSauber(sub) {
  if (!sub || typeof sub !== 'object') return null;
  const endpoint = typeof sub.endpoint === 'string' ? sub.endpoint : '';
  const k = sub.keys || {};
  if (!/^https:\/\/[^\s]{10,600}$/.test(endpoint)) return null;
  if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || k.p256dh.length > 200 || k.auth.length > 100) return null;
  return { endpoint, keys: { p256dh: k.p256dh, auth: k.auth } };
}

exports.handler = async (event) => {
  const halt = await schutz(event, { name: 'lieblingstag', max: 40, maxKB: 8 });
  if (halt) return halt;
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input = {};
  try { input = saeubern(JSON.parse(event.body || '{}'), { maxText: 1000 }); } catch (e) { return json(400, { error: 'invalid_json' }); }
  const action = String(input.action || '');
  const email = normEmail(input.email);
  if (!email || !['status', 'an', 'aus'].includes(action)) return json(400, { error: 'bad_request' });

  const kunden = store('customers');
  const key = 'c:' + sha(email);
  try {
    const rec = await kunden.get(key, { type: 'json' });
    if (!rec || !tokenGueltig(rec, input.token)) return json(401, { error: 'unauthorized' });

    if (action === 'status') return json(200, { ok: true, lieblingstag: fuerKonto(rec) });

    if (action === 'aus') {
      const alt = rec.lieblingstag && rec.lieblingstag.thema;
      delete rec.lieblingstag;
      await kunden.setJSON(key, rec);
      try { await store('lieblingstag').delete(key); } catch (e) {}
      return json(200, { ok: true, thema: alt || null, lieblingstag: fuerKonto(rec) });
    }

    // an
    const lt = rec.lieblingstag && typeof rec.lieblingstag === 'object' ? rec.lieblingstag : {};
    const neu = aboSauber(input.subscription);
    let web = Array.isArray(lt.web) ? lt.web.filter((w) => w && w.endpoint) : [];
    if (neu) web = [neu, ...web.filter((w) => w.endpoint !== neu.endpoint)].slice(0, MAX_WEB);
    let thema = typeof lt.thema === 'string' ? lt.thema : '';
    if (input.ios === true && !thema) thema = 'lt_' + crypto.randomBytes(12).toString('hex');
    if (!web.length && !thema) return json(400, { error: 'kein_geraet' });
    rec.lieblingstag = {
      an: true,
      lang: SPRACHEN.includes(input.lang) ? input.lang : (SPRACHEN.includes(lt.lang) ? lt.lang : 'de'),
      seit: lt.seit || new Date().toISOString(),
      web,
      ...(thema ? { thema } : {}),
      ...(lt.zuletzt ? { zuletzt: lt.zuletzt } : {}),
    };
    await kunden.setJSON(key, rec);
    await store('lieblingstag').setJSON(key, { seit: rec.lieblingstag.seit });
    return json(200, { ok: true, thema: input.ios === true ? thema : null, lieblingstag: fuerKonto(rec) });
  } catch (e) {
    console.error('lieblingstag:', e.message);
    return json(500, { error: 'speichern_fehlgeschlagen' });
  }
};
