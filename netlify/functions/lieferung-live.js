/**
 * lieferung-live.js
 * ----------------------------------------------------------------------------
 * Live-Karte auf der Kunden-Statusseite (status.html), solange die Lieferung
 * unterwegs ist.
 *
 *   GET ?ref=GNC-…&k=<Statusschlüssel>
 *     → { aktiv: false, state }                       nicht (mehr) unterwegs
 *     → { aktiv: true, ankunft, start, pos, ziel, truck, stand }
 *         pos   { lat, lng, at } Kubis letzter Standort, nur wenn jünger als
 *               3 Minuten, sonst null (dann zeigt die Seite nur die Ankunftszeit)
 *         ziel  { lat, lng } Lieferadresse aus dem Geo-Zwischenspeicher, sonst null
 *
 * Absicherung wie die Statusseite (order-status.js GET): nur mit dem
 * Statusschlüssel genau dieser Bestellung (sha256(ref|STATUS_UPDATE_SECRET)).
 * Diese Function fragt nie selbst bei Nominatim an und schreibt nichts.
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');
const { schutz } = require('./lib/bremse');
const { ausCache } = require('./lib/geokodierung');
const L = require('./lib/lieferung');

const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(data),
});

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

exports.handler = async (event) => {
  // Grundschutz: die Seite fragt alle 15 s, im Mobilfunk teilen sich viele eine IP
  const halt = await schutz(event, { name: 'lieferung-live', max: 300, maxKB: 4 });
  if (halt) return halt;
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' };
  if (event.httpMethod !== 'GET') return json(405, { error: 'method_not_allowed' });

  const q = event.queryStringParameters || {};
  const ref = String(q.ref || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
  if (!/^GNC-/.test(ref)) return json(400, { error: 'bad_ref' });
  if (!L.statusKeyStimmt(ref, q.k)) return json(403, { error: 'forbidden' });

  try {
    const rec = await store('orders').get('o:' + ref, { type: 'json' });
    if (!rec || rec.kind === 'giftcard' || (rec.order || {}).mode !== 'delivery') return json(404, { error: 'not_found' });
    const state = rec.fstate || 'confirmed';
    if (state !== 'on_the_way') return json(200, { aktiv: false, state });

    const jetzt = Date.now();
    let pos = null;
    try {
      const p = await L.fahrtStore().get(L.posKey(ref), { type: 'json' });
      const at = p ? Date.parse(p.at || '') || 0 : 0;
      if (p && typeof p.lat === 'number' && jetzt - at <= L.POS_FRISCH_MS) pos = { lat: p.lat, lng: p.lng, at: p.at };
    } catch (e) {}

    let ziel = null;
    try {
      const c = await ausCache(rec.order.deliveryAddress, store('geo'));
      if (c.status === 'treffer') ziel = { lat: c.wert.lat, lng: c.wert.lng };
    } catch (e) {}

    const f = rec.fahrt || {};
    return json(200, {
      aktiv: true,
      state,
      ankunft: f.ankunft || null,
      start: f.start || (rec.fstateAt && rec.fstateAt.on_the_way) || null,
      pos,
      ziel,
      truck: { lat: L.TRUCK.lat, lng: L.TRUCK.lng },
      stand: new Date(jetzt).toISOString(),
    });
  } catch (e) {
    console.error('lieferung-live:', e && e.message);
    return json(500, { error: 'failed' });
  }
};
