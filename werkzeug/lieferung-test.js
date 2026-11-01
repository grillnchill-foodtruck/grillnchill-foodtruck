#!/usr/bin/env node
/**
 * werkzeug/lieferung-test.js
 * ----------------------------------------------------------------------------
 * Paket lieferung: Fahrer-Ansicht, Live-Standort, Liefer-Heatmap, Geokodierung.
 *
 *   node werkzeug/lieferung-test.js
 *
 * Echte Handler, Blob-Speicher im Arbeitsspeicher, fetch abgefangen (es geht
 * keine Anfrage an Nominatim, keine Mail, kein Push nach außen).
 * Abgedeckt: Tourreihenfolge, gleiche Richtung, Ankunftsvorschlag,
 * Geokodierung mit Zwischenspeicher, Drossel 1/s, Positionen nur mit gültigem
 * Statuslink, Löschen nach Zustellung, Heatmap-Zellen ab 3, nur Inhaber.
 * ----------------------------------------------------------------------------
 */

const Module = require('module');
const path = require('path');

const F = path.join(__dirname, '..', 'netlify', 'functions');
const daten = new Map();
const store = (name) => ({
  async get(k, o) { const v = daten.get(name + '|' + k); return v === undefined ? null : (o && o.type === 'json' ? JSON.parse(v) : v); },
  async setJSON(k, v) { daten.set(name + '|' + k, JSON.stringify(v)); },
  async set(k, v) { daten.set(name + '|' + k, String(v)); },
  async delete(k) { daten.delete(name + '|' + k); },
  async list({ prefix } = {}) { return { blobs: [...daten.keys()].filter((k) => k.startsWith(name + '|' + (prefix || ''))).map((k) => ({ key: k.slice(name.length + 1) })) }; },
});
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) { if (r === '@netlify/blobs') return '@netlify/blobs'; return orig.call(this, r, ...a); };
require.cache['@netlify/blobs'] = { id: '@netlify/blobs', exports: { getStore: (o) => store(typeof o === 'string' ? o : o.name) }, loaded: true };

process.env.ADMIN_PASSWORD = 'kubi-test-passwort';
delete process.env.ZWEI_FAKTOR;
Object.assign(process.env, { STATUS_UPDATE_SECRET: 'test-status-geheim', BREVO_API_KEY: 'test-nicht-echt', BREVO_SENDER_EMAIL: 'test@example.com' });
delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; delete process.env.TELEGRAM_BOT_TOKEN;

/* fetch: Nominatim-Stub, alles andere 503 (keine Mail, kein Push nach außen) */
const anfragen = [];
let nominatim = () => [];
global.fetch = async (url, opt) => {
  const u = String(url);
  if (u.startsWith('https://nominatim.openstreetmap.org/')) {
    anfragen.push({ url: u, opt, t: uhr.t });
    const r = nominatim(new URL(u));
    if (r === 'netz') throw new Error('netz weg');
    return { ok: true, status: 200, json: async () => r };
  }
  return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
};
console.warn = () => {};
console.error = () => {};

/* Virtuelle Uhr für die Drossel */
const uhr = { t: Date.parse('2026-11-02T11:00:00Z') };
const geo = require(F + '/lib/geokodierung.js');
geo._test({ jetzt: () => uhr.t, schlafen: async (ms) => { uhr.t += ms; } });

const L = require(F + '/lib/lieferung.js');
const sitzung = require(F + '/lib/admin-sitzung.js');
const { hashen } = require(F + '/lib/team-passwort.js');
const fahrer = require(F + '/fahrer.js');
const live = require(F + '/lieferung-live.js');
const status = require(F + '/order-status.js');
const heatmap = require(F + '/liefer-heatmap.js');

let fehler = 0, n = 0;
const ok = (name, b, info) => { n++; console.log((b ? '✅ ' : '❌ ') + name + (b || info === undefined ? '' : '\n   ' + JSON.stringify(info))); if (!b) fehler++; };
let ipN = 1;
const ip = () => '10.77.0.' + (ipN++ % 250);
const post = async (h, body, eigeneIp) => {
  const r = await h.handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': eigeneIp || ip() }, body: JSON.stringify(body) });
  let d = {}; try { d = JSON.parse(r.body); } catch (e) {}
  return { s: r.statusCode, d, body: r.body };
};
const get = async (h, q) => {
  const r = await h.handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': ip() }, queryStringParameters: q });
  let d = {}; try { d = JSON.parse(r.body); } catch (e) {}
  return { s: r.statusCode, d };
};
const treffer = (lat, lng, extra) => [{ lat: String(lat), lon: String(lng), address: Object.assign({ postcode: '33649', suburb: 'Brackwede' }, extra || {}) }];

(async () => {
  const T = L.TRUCK;
  /* ---- Tour ------------------------------------------------------------- */
  const P = {
    nah: { ref: 'GNC-1', lat: T.lat + 0.005, lng: T.lng },            // ~0,6 km Nord
    mitte: { ref: 'GNC-2', lat: T.lat + 0.02, lng: T.lng + 0.005 },     // ~2,3 km Nord
    fern: { ref: 'GNC-3', lat: T.lat + 0.04, lng: T.lng + 0.01 },       // ~4,5 km Nord
    sued: { ref: 'GNC-4', lat: T.lat - 0.012, lng: T.lng },             // ~1,3 km Süd
    ohne: { ref: 'GNC-5' },
  };
  const t1 = L.tour(T, [P.fern, P.ohne, P.sued, P.mitte, P.nah]);
  // Nach Entfernung zum Truck sortiert wäre es 1,4,2,3. Von "nah" aus liegt
  // aber "mitte" näher als "sued", also geht die Tour erst nach Norden weiter.
  ok('Tour: ab dem Truck jeweils zur nächsten Adresse', t1.map((x) => x.ref).join(',') === 'GNC-1,GNC-2,GNC-3,GNC-4,GNC-5', t1.map((x) => x.ref));
  ok('Tour: Adresse ohne Koordinaten kommt ans Ende, ohne Entfernung', t1[4].abKm === null && t1[0].abKm === 0.6);
  ok('Tour: leere Liste bleibt leer', L.tour(T, []).length === 0);

  const b1 = L.buendel(T, [P.mitte, P.fern, P.sued]);
  ok('Bündel: zwei Lieferungen Richtung Norden lohnen sich als eine Fahrt', b1.length === 1 && b1[0].a === 'GNC-2' && b1[0].b === 'GNC-3' && b1[0].sparKm > 3 && /Nord/.test(b1[0].richtung), b1);
  ok('Bündel: entgegengesetzte Richtungen nicht', L.buendel(T, [P.mitte, P.sued]).length === 0);

  ok('Ankunft: direkt am Truck -> 10 Min.', L.ankunftVorschlag(0.2).wahl === 10);
  ok('Ankunft: 4 km -> 13 Min. -> Wahl 15', L.ankunftVorschlag(4).minuten === 13 && L.ankunftVorschlag(4).wahl === 15);
  ok('Ankunft: 7 km -> 20 Min.', L.ankunftVorschlag(7).wahl === 20);
  ok('Ankunft: 20 km -> höchstens 30', L.ankunftVorschlag(20).wahl === 30);

  /* ---- Geokodierung ------------------------------------------------------ */
  nominatim = (u) => (u.searchParams.get('street') || '').toLowerCase().includes('nirgendwo') ? [] : treffer(52.0101, 8.5222);
  const a1 = { street: 'Gütersloher Straße 122', zip: '33649', city: 'Bielefeld' };
  const g1 = await geo.geokodiere(a1);
  const q1 = anfragen[0] && new URL(anfragen[0].url);
  ok('Geokodierung: Treffer mit Koordinaten, PLZ, Stadtteil', g1 && g1.lat === 52.0101 && g1.lng === 8.5222 && g1.plz === '33649' && g1.stadtteil === 'Brackwede' && g1.ausCache === false, g1);
  ok('Geokodierung: eigener User-Agent', anfragen[0] && anfragen[0].opt.headers['User-Agent'] === 'GrillnChill/1.0 (info@grillnchill-foodtruck.de)');
  ok('Geokodierung: auf Deutschland und Bielefeld eingegrenzt', q1 && q1.searchParams.get('countrycodes') === 'de' && q1.searchParams.get('bounded') === '1' && /^8\.25,52\.15,8\.75,51\.84$/.test(q1.searchParams.get('viewbox')));
  ok('Geokodierung: übertragen werden nur Straße, PLZ, Ort', q1 && !/name|phone|email|GNC/i.test(q1.search));
  const vorher = anfragen.length;
  const g2 = await geo.geokodiere({ street: ' gütersloher str. 122 ', zip: '33649', city: 'BIELEFELD' });
  ok('Geokodierung: gleiche Adresse anders geschrieben kommt aus dem Speicher', g2 && g2.ausCache === true && anfragen.length === vorher);
  ok('Geokodierung: Speicher-Schlüssel ist sha256 der vereinheitlichten Adresse', daten.has('geo|' + geo.schluessel(a1)) && /^[a-f0-9]{64}$/.test(geo.schluessel(a1)) && geo.vereinheitlichen(a1) === 'gütersloher strasse 122|33649|bielefeld');
  const g3 = await geo.geokodiere({ street: 'Nirgendwo 1', zip: '33602', city: 'Bielefeld' });
  const vorher2 = anfragen.length;
  await geo.geokodiere({ street: 'Nirgendwo 1', zip: '33602', city: 'Bielefeld' });
  ok('Geokodierung: nicht gefunden -> null, wird gemerkt, keine zweite Anfrage', g3 === null && anfragen.length === vorher2);
  nominatim = () => 'netz';
  const a4 = { street: 'Netzweg 4', zip: '33602', city: 'Bielefeld' };
  const g4 = await geo.geokodiere(a4);
  ok('Geokodierung: Netzfehler -> null, nichts gespeichert', g4 === null && !daten.has('geo|' + geo.schluessel(a4)));
  nominatim = () => treffer(48.137, 11.575);   // München
  ok('Geokodierung: Treffer außerhalb der Gegend gilt als nicht gefunden', (await geo.geokodiere({ street: 'Marienplatz 1', zip: '80331', city: 'München' })) === null);
  nominatim = () => ({ kaputt: true });
  ok('Geokodierung: kaputte Antwort -> null', (await geo.geokodiere({ street: 'Kaputtweg 9', zip: '33602', city: 'Bielefeld' })) === null);

  /* ---- Drossel ------------------------------------------------------------ */
  nominatim = () => treffer(52.02, 8.53);
  const ab = anfragen.length;
  for (let i = 0; i < 3; i++) await geo.geokodiere({ street: 'Taktweg ' + (10 + i), zip: '33602', city: 'Bielefeld' });
  await Promise.all([1, 2, 3].map((i) => geo.geokodiere({ street: 'Parallelweg ' + i, zip: '33602', city: 'Bielefeld' })));
  const zeiten = anfragen.slice(ab).map((x) => x.t);
  const abstaende = zeiten.slice(1).map((t, i) => t - zeiten[i]);
  ok('Drossel: 6 Anfragen, je mindestens 1 Sekunde Abstand (auch parallel)', zeiten.length === 6 && abstaende.every((d) => d >= 1000), abstaende);
  daten.set('geo|_takt', JSON.stringify({ at: uhr.t + 10000 }));   // andere Instanz fragt gerade viel
  const vor3 = anfragen.length;
  const g5 = await geo.geokodiere({ street: 'Wartweg 1', zip: '33602', city: 'Bielefeld' });
  ok('Drossel: andere Instanz belegt den Takt -> nicht anstehen, null', g5 === null && anfragen.length === vor3);
  daten.set('geo|_takt', JSON.stringify({ at: 0 }));

  /* ---- Bestellungen anlegen ------------------------------------------------ */
  const jetzt = Date.now();
  const best = (ms, o, extra) => {
    const ref = 'GNC-' + ms;
    daten.set('orders|o:' + ref, JSON.stringify(Object.assign({
      status: 'completed', createdAt: new Date(ms).toISOString(), completedAt: new Date(ms).toISOString(), fstate: 'preparing',
      order: Object.assign({ reference: ref, mode: 'delivery', name: 'Test Gast', phone: '0151 000', email: 'gast@example.com', payment: 'cash', total: 23.5,
        items: [{ name: 'Classic', qty: 2 }, { name: 'Pommes', qty: 1 }] }, o),
    }, extra || {})));
    return ref;
  };
  // Koordinaten vorab im Speicher, damit die Liste ohne Nominatim auskommt
  const adr = (street, lat, lng, plz, teil) => {
    const a = { street, zip: plz || '33649', city: 'Bielefeld' };
    daten.set('geo|' + geo.schluessel(a), JSON.stringify({ lat, lng, plz: plz || '33649', stadtteil: teil || 'Brackwede', at: new Date().toISOString() }));
    return a;
  };
  const rNah = best(jetzt - 30 * 60000, { deliveryAddress: adr('Nahweg 1', T.lat + 0.005, T.lng) });
  const rFern = best(jetzt - 25 * 60000, { deliveryAddress: adr('Fernweg 3', T.lat + 0.04, T.lng + 0.01), payment: 'sumup' }, { abholnr: 7 });
  const rMitte = best(jetzt - 20 * 60000, { deliveryAddress: adr('Mittelweg 2', T.lat + 0.02, T.lng + 0.005), note: 'Klingel defekt' });
  const rAbh = best(jetzt - 15 * 60000, { mode: 'pickup' });
  const rFertig = best(jetzt - 10 * 60000, { deliveryAddress: adr('Fertigweg 5', T.lat - 0.01, T.lng) }, { fstate: 'delivered' });
  const rAlt = best(jetzt - 3 * 86400000, { deliveryAddress: adr('Altweg 6', T.lat - 0.01, T.lng) });

  /* ---- Anmeldung ---------------------------------------------------------- */
  const kubi = await sitzung.erstelle('kubi-test-passwort', { role: 'superadmin', name: 'Kubi' }, { zweiFaktor: true });
  daten.set('team|u:mia-test', JSON.stringify({ name: 'Mia Test', role: 'staff', pwHash: await hashen('mia-sesam-glut-77') }));
  const mia = await sitzung.erstelle('mia-sesam-glut-77', { role: 'staff', name: 'Mia Test' }, { zweiFaktor: true });

  ok('Fahrer-Liste ohne Anmeldung -> 401', (await post(fahrer, { action: 'liste' })).s === 401);
  ok('Fahrer-Liste mit reinem Passwort (ohne Code) -> 401', (await post(fahrer, { action: 'liste', password: 'kubi-test-passwort' })).s === 401);
  let r = await post(fahrer, { action: 'liste', password: kubi.token });
  const refs = (r.d.lieferungen || []).map((x) => x.ref);
  ok('Fahrer-Liste: nur offene Lieferungen von heute (keine Abholung, nichts Zugestelltes, nichts von Vortagen)', r.s === 200 && refs.length === 3 && !refs.includes(rAbh) && !refs.includes(rFertig) && !refs.includes(rAlt), refs);
  ok('Fahrer-Liste: Tourvorschlag ab dem Truck (nah, mitte, fern)', refs.join(',') === [rNah, rMitte, rFern].join(','), refs);
  const zFern = r.d.lieferungen.find((x) => x.ref === rFern), zNah = r.d.lieferungen.find((x) => x.ref === rNah);
  ok('Fahrer-Liste: Abholnummer falls vorhanden, sonst null', zFern.abholnr === 7 && zNah.abholnr === null);
  ok('Fahrer-Liste: Artikel, Zahlung, Notiz, Entfernung, Vorschlag', zNah.artikel === 3 && zNah.zahlung === 'bar' && zFern.zahlung === 'online'
    && r.d.lieferungen.find((x) => x.ref === rMitte).notiz === 'Klingel defekt' && zFern.km > 4 && zFern.vorschlag.wahl === 15 && zNah.vorschlag.wahl === 10);
  ok('Fahrer-Liste: Hinweis auf gemeinsame Fahrt (mitte + fern)', (r.d.buendel || []).some((b) => b.a === rMitte && b.b === rFern), r.d.buendel);

  /* ---- Losfahren über den vorhandenen Weg ---------------------------------- */
  r = await post(status, { action: 'set', password: kubi.token, reference: rFern, state: 'on_the_way', ankunftMin: 15 });
  let rec = JSON.parse(daten.get('orders|o:' + rFern));
  const eta = Date.parse(rec.fahrt && rec.fahrt.ankunft) - Date.now();
  ok('Losfahren: order-status setzt on_the_way und rec.fahrt mit Ankunftszeit', r.s === 200 && rec.fstate === 'on_the_way' && rec.fahrt.minuten === 15 && eta > 14 * 60000 && eta <= 15 * 60000);
  r = await post(fahrer, { action: 'liste', password: kubi.token });
  ok('Fahrer-Liste: unterwegs steht oben, mit Ankunft', r.d.lieferungen[0].ref === rFern && r.d.lieferungen[0].gruppe === 'unterwegs' && !!r.d.lieferungen[0].fahrt.ankunft);

  /* ---- Position teilen ------------------------------------------------------ */
  ok('Position ohne Anmeldung -> 401', (await post(fahrer, { action: 'position', refs: [rFern], lat: 52.0, lng: 8.5 })).s === 401);
  ok('Position außerhalb Deutschlands -> 400', (await post(fahrer, { action: 'position', password: kubi.token, refs: [rFern], lat: 40.4, lng: -3.7 })).s === 400);
  r = await post(fahrer, { action: 'position', password: kubi.token, refs: [rFern, rNah], lat: 51.99, lng: 8.49, acc: 12 });
  ok('Position: nur für die Fahrt, die unterwegs ist, gespeichert', r.s === 200 && r.d.gespeichert.length === 1 && r.d.gespeichert[0] === rFern && daten.has('fahrt|pos:' + rFern) && !daten.has('fahrt|pos:' + rNah));
  ok('Position: Bestelldatensatz bleibt unverändert', daten.get('orders|o:' + rFern) === JSON.stringify(rec));

  /* ---- Kunden-Statusseite: nur mit gültigem Statuslink ----------------------- */
  const kF = L.statusKey(rFern);
  ok('Live: ohne Schlüssel -> 403', (await get(live, { ref: rFern })).s === 403);
  ok('Live: falscher Schlüssel -> 403', (await get(live, { ref: rFern, k: 'a'.repeat(20) })).s === 403);
  ok('Live: Schlüssel einer anderen Bestellung -> 403', (await get(live, { ref: rFern, k: L.statusKey(rNah) })).s === 403);
  r = await get(live, { ref: rFern, k: kF });
  ok('Live: gültiger Statuslink -> Position, Ziel, Ankunft', r.s === 200 && r.d.aktiv === true && r.d.pos && r.d.pos.lat === 51.99 && r.d.ziel && r.d.ziel.lat === Math.round((T.lat + 0.04) * 1e5) / 1e5 && !!r.d.ankunft, r.d);
  ok('Live: Antwort ohne Name, Telefon, Adresse', !/Test Gast|0151|Fernweg|gast@/.test(JSON.stringify(r.d)));
  r = await get(live, { ref: rNah, k: L.statusKey(rNah) });
  ok('Live: Bestellung noch nicht unterwegs -> aktiv false', r.s === 200 && r.d.aktiv === false);
  const posAlt = JSON.parse(daten.get('fahrt|pos:' + rFern));
  daten.set('fahrt|pos:' + rFern, JSON.stringify({ ...posAlt, at: new Date(Date.now() - 4 * 60000).toISOString() }));
  r = await get(live, { ref: rFern, k: kF });
  ok('Live: Position älter als 3 Minuten -> kein Punkt, nur Ankunftszeit', r.d.aktiv === true && r.d.pos === null && !!r.d.ankunft);
  daten.set('fahrt|pos:' + rFern, JSON.stringify(posAlt));

  /* ---- Stopp und Zustellung -------------------------------------------------- */
  r = await post(fahrer, { action: 'stopp', password: kubi.token, refs: [rFern] });
  ok('Stopp: gespeicherte Position gelöscht', r.s === 200 && !daten.has('fahrt|pos:' + rFern));
  await post(fahrer, { action: 'position', password: kubi.token, refs: [rFern], lat: 51.995, lng: 8.495 });
  ok('Nach Stopp wieder teilen geht', daten.has('fahrt|pos:' + rFern));
  r = await post(status, { action: 'set', password: kubi.token, reference: rFern, state: 'delivered' });
  rec = JSON.parse(daten.get('orders|o:' + rFern));
  ok('Zugestellt: Positionen dieser Fahrt gelöscht, Fahrt beendet', r.s === 200 && !daten.has('fahrt|pos:' + rFern) && !!rec.fahrt.ende && rec.fstate === 'delivered');
  r = await get(live, { ref: rFern, k: kF });
  ok('Zugestellt: Statusseite bekommt keine Position mehr', r.s === 200 && r.d.aktiv === false && !('pos' in r.d));
  r = await post(fahrer, { action: 'position', password: kubi.token, refs: [rFern], lat: 51.99, lng: 8.49 });
  ok('Zugestellt: neue Position wird nicht mehr gespeichert', r.d.gespeichert.length === 0 && !daten.has('fahrt|pos:' + rFern));
  // Zustellung über den Mail-Link (Status-Secret) räumt genauso auf
  await post(status, { action: 'set', password: kubi.token, reference: rMitte, state: 'on_the_way' });
  await post(fahrer, { action: 'position', password: kubi.token, refs: [rMitte], lat: 51.99, lng: 8.49 });
  await post(status, { action: 'set', secret: 'test-status-geheim', reference: rMitte, state: 'delivered' });
  ok('Zugestellt per Mail-Link: Positionen ebenfalls gelöscht', !daten.has('fahrt|pos:' + rMitte));
  daten.set('fahrt|pos:GNC-1700000000000', JSON.stringify({ lat: 52, lng: 8.5, at: new Date(Date.now() - 7 * 3600000).toISOString() }));
  await post(fahrer, { action: 'liste', password: kubi.token });
  ok('Vergessene Positionen älter als 6 Stunden werden weggeräumt', !daten.has('fahrt|pos:GNC-1700000000000'));

  /* ---- Heatmap-Zellen ------------------------------------------------------- */
  const { dLat, dLng } = L.raster();
  const zelle = (i, j, k) => ({ lat: (Math.floor(T.lat / dLat) + i + 0.3 + k * 0.1) * dLat, lng: (Math.floor(T.lng / dLng) + j + 0.4) * dLng });
  const pk = [
    { ...zelle(2, 2, 0), h: 'a' }, { ...zelle(2, 2, 1), h: 'b' },                                   // 2 Bestellungen
    { ...zelle(5, 5, 0), h: 'c' }, { ...zelle(5, 5, 1), h: 'd' }, { ...zelle(5, 5, 2), h: 'c' },      // 3, zwei Adressen
    { ...zelle(8, 1, 0), h: 'e' }, { ...zelle(8, 1, 1), h: 'e' }, { ...zelle(8, 1, 2), h: 'e' },      // 3, eine Adresse
  ];
  const hz = L.heatZellen(pk);
  ok('Heatmap: Zelle mit 2 Bestellungen ausgeblendet, mit 3 sichtbar', hz.zellen.length === 1 && hz.zellen[0].n === 3 && hz.ausgeblendet === 2, hz);
  ok('Heatmap: Zelle mit 3 Bestellungen von nur einer Adresse ausgeblendet', !hz.zellen.some((z) => Math.abs(z.lat - zelle(8, 1, 1).lat) < dLat));
  const mitteSoll = (Math.floor(zelle(5, 5, 0).lat / dLat) + 0.5) * dLat;
  ok('Heatmap: Zelle zeigt die Rastermitte, keine Adresse', Math.abs(hz.zellen[0].lat - mitteSoll) < 1e-5 && pk.every((p) => p.lat !== hz.zellen[0].lat));
  ok('Heatmap: Raster etwa 250 m', Math.abs(dLat * 111320 - 250) < 1 && Math.abs(dLng * 111320 * Math.cos(T.lat * Math.PI / 180) - 250) < 1);
  const gb = L.gebiete([{ plz: '33647', stadtteil: 'Brackwede' }, { plz: '33647', stadtteil: 'Brackwede' }, { plz: '33647', stadtteil: 'Quelle' }, { plz: '33602', stadtteil: 'Mitte' }, { plz: '33602' }]);
  ok('Heatmap: Gebietsliste ab 3, mit häufigstem Stadtteil', gb.length === 1 && gb[0].plz === '33647' && gb[0].stadtteil === 'Brackwede' && gb[0].n === 3, gb);

  /* ---- Heatmap-Function -------------------------------------------------------- */
  // 3 Lieferungen an zwei Adressen in derselben Zelle, eine einzelne woanders,
  // dazu 7 Adressen ohne Koordinaten (Portionen von höchstens 5)
  for (const k of [...daten.keys()].filter((x) => x.startsWith('orders|'))) daten.delete(k);
  const hz1 = adr('Heatweg 1', 52.01001, 8.52001, '33602', 'Mitte');
  const hz2 = adr('Heatweg 3', 52.01005, 8.52004, '33602', 'Mitte');
  best(jetzt - 5 * 86400000, { deliveryAddress: hz1 }, { fstate: 'delivered' });
  best(jetzt - 4 * 86400000, { deliveryAddress: hz2 }, { fstate: 'delivered' });
  best(jetzt - 3 * 86400000, { deliveryAddress: hz1 }, { fstate: 'delivered' });
  best(jetzt - 2 * 86400000, { deliveryAddress: adr('Einzelweg 9', 51.95, 8.40, '33659', 'Sennestadt') }, { fstate: 'delivered' });
  best(jetzt - 40 * 86400000, { deliveryAddress: hz1 }, { fstate: 'delivered' });
  for (let i = 0; i < 7; i++) best(jetzt - (6 + i) * 3600000, { deliveryAddress: { street: 'Neuweg ' + (i + 1), zip: '33602', city: 'Bielefeld' } }, { fstate: 'delivered' });
  nominatim = () => treffer(52.03, 8.55, { postcode: '33602', suburb: 'Mitte' });
  ok('Heatmap: Mitarbeiter -> 403', (await post(heatmap, { password: mia.token, tage: 30 })).s === 403);
  ok('Heatmap: ohne Anmeldung -> 401', (await post(heatmap, { tage: 30 })).s === 401);
  const vorH = anfragen.length;
  r = await post(heatmap, { password: kubi.token, tage: 30 });
  ok('Heatmap: Inhaber -> 200, 11 Lieferungen in 30 Tagen, erste Portion höchstens 5 neu verortet', r.s === 200 && r.d.lieferungen === 11 && anfragen.length - vorH <= 5 && r.d.offen === 7 - (anfragen.length - vorH), { d: r.d, neu: anfragen.length - vorH });
  ok('Heatmap: Antwort enthält keine Adresse und keine echte Koordinate', !/Heatweg|Neuweg|Einzelweg|52\.01001|8\.52001|Test Gast/.test(r.body));
  ok('Heatmap: Zelle mit 3 Bestellungen sichtbar, Einzeladresse nicht', r.d.zellen.length >= 1 && r.d.zellen.every((z) => z.n >= 3) && !r.d.zellen.some((z) => Math.abs(z.lat - 51.95) < 0.003));
  let runden = 0;
  while (r.d.offen > 0 && runden < 5) { r = await post(heatmap, { password: kubi.token, tage: 30 }); runden++; }
  ok('Heatmap: nach weiteren Aufrufen alles verortet', r.d.offen === 0 && r.d.verortet === 11 && runden <= 2, { runden, d: r.d });
  ok('Heatmap: Gebietsliste nennt 33602 mit Anzahl', r.d.gebiete.some((g) => g.plz === '33602' && g.n >= 3) && !r.d.gebiete.some((g) => g.plz === '33659'));
  r = await post(heatmap, { password: kubi.token, tage: 90 });
  ok('Heatmap: 90 Tage nimmt die ältere Lieferung mit', r.s === 200 && r.d.lieferungen === 12 && r.d.archivTage === 90);

  console.log('\n' + (n - fehler) + ' von ' + n + (fehler ? ' - ' + fehler + ' FEHLER' : ' grün'));
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.log('Abbruch:', e); process.exit(1); });
