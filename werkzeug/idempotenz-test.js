/**
 * werkzeug/idempotenz-test.js – prüft lib/idempotenz.js ohne Netlify
 *   node werkzeug/idempotenz-test.js
 * Ersetzt @netlify/blobs durch einen Speicher im Arbeitsspeicher.
 */
const path = require('path');
const daten = new Map();
const blobsPfad = require.resolve('@netlify/blobs', { paths: [path.join(__dirname, '..', 'netlify', 'functions')] });
require.cache[blobsPfad] = {
  id: blobsPfad, filename: blobsPfad, loaded: true,
  exports: {
    getStore: () => ({
      get: async (k) => (daten.has(k) ? JSON.parse(daten.get(k)) : null),
      setJSON: async (k, v) => { daten.set(k, JSON.stringify(v)); },
      delete: async (k) => { daten.delete(k); },
      list: async () => ({ blobs: [...daten.keys()].map((key) => ({ key })) }),
    }),
  },
};
const { mitIdempotenz, idempotenzAufraeumen } = require('../netlify/functions/lib/idempotenz');

let fehler = 0, n = 0;
const ok = (name, b) => { n++; console.log((b ? '✅ ' : '❌ ') + name); if (!b) fehler++; };

(async () => {
  let aufrufe = 0;
  const handler = async (event) => {
    aufrufe++;
    const b = JSON.parse(event.body || '{}');
    if (b.kaputt) return { statusCode: 502, body: '{"error":"x"}' };
    if (b.warte) await new Promise((r) => setTimeout(r, 50));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ checkoutId: 'c' + aufrufe }) };
  };
  const h = mitIdempotenz(handler, { bereich: 'test' });
  const anfrage = (key, body) => ({ httpMethod: 'POST', headers: key ? { 'idempotency-key': key } : {}, body: JSON.stringify(body) });
  const KEY = 'a1b2c3d4-e5f6-4711-8000-000000000001';

  const r1 = await h(anfrage(KEY, { betrag: 20 }));
  const r2 = await h(anfrage(KEY, { betrag: 20 }));
  ok('erste Anfrage läuft', aufrufe === 1 && JSON.parse(r1.body).checkoutId === 'c1');
  ok('zweite Anfrage bekommt dieselbe Antwort', r2.body === r1.body && r2.headers['Idempotent-Replayed'] === 'true' && aufrufe === 1);

  const r3 = await h(anfrage(KEY, { betrag: 99 }));
  ok('gleicher Schlüssel, anderer Inhalt → 422', r3.statusCode === 422 && aufrufe === 1);

  const ohne1 = await h(anfrage('', { betrag: 20 })), ohne2 = await h(anfrage('', { betrag: 20 }));
  ok('ohne Schlüssel läuft jede Anfrage', aufrufe === 3 && ohne1.body !== ohne2.body);

  const KEY2 = 'a1b2c3d4-e5f6-4711-8000-000000000002';
  const p1 = h(anfrage(KEY2, { warte: true }));
  await new Promise((r) => setTimeout(r, 5));
  const p2 = await h(anfrage(KEY2, { warte: true }));
  const e1 = await p1;
  ok('parallele Anfrage → 409 mit Retry-After', p2.statusCode === 409 && p2.headers['Retry-After'] === '1' && e1.statusCode === 200);

  const KEY3 = 'a1b2c3d4-e5f6-4711-8000-000000000003';
  const k1 = await h(anfrage(KEY3, { kaputt: true }));
  const vor = aufrufe;
  await h(anfrage(KEY3, { kaputt: true }));
  ok('5xx wird nicht gemerkt, zweiter Versuch läuft echt', k1.statusCode === 502 && aufrufe === vor + 1);

  const hf = mitIdempotenz(handler, { bereich: 'fp', fingerabdruck: (body) => { const o = JSON.parse(body); delete o.turnstileToken; return JSON.stringify(o); } });
  const KEY4 = 'a1b2c3d4-e5f6-4711-8000-000000000004';
  const f1 = await hf(anfrage(KEY4, { anfrage: 'x', turnstileToken: 'eins' }));
  const f2 = await hf(anfrage(KEY4, { anfrage: 'x', turnstileToken: 'zwei' }));
  ok('Fingerabdruck ohne Turnstile-Token: neuer Versuch = Wiederholung', f2.body === f1.body && f2.headers['Idempotent-Replayed'] === 'true');

  const kurz = await h(anfrage('zu-kurz', { betrag: 1 }));
  ok('ungültiger Schlüssel → 400', kurz.statusCode === 400);

  const get = await h({ httpMethod: 'GET', headers: { 'idempotency-key': KEY }, body: '' });
  ok('GET läuft unverändert durch', get.statusCode === 200);

  for (const [k, v] of daten) { const e = JSON.parse(v); e.t = Date.now() - 25 * 3600 * 1000; daten.set(k, JSON.stringify(e)); }
  const weg = await idempotenzAufraeumen();
  ok('Aufräumen löscht Einträge älter als 24 h', weg > 0 && daten.size === 0);

  console.log(`\n${n - fehler} von ${n} grün`);
  process.exit(fehler ? 1 : 0);
})();
