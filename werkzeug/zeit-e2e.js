#!/usr/bin/env node
/**
 * werkzeug/zeit-e2e.js
 * Ende-zu-Ende gegen ein lokales GNC Office: koppeln, stempeln, Pause, Ende mit Gutschrift, Rückgängig, gleicher
 * Schlüssel, Konflikt aus der Warteschlange, Woche am Handy, fremde Person, entkoppeltes iPad, Signatur, Office weg.
 * Die Functions laufen hier im Prozess (Blob-Speicher im Arbeitsspeicher), zeit.js schickt echte, signierte
 * Anfragen an das Office.
 *
 *   Office (gnc-office-zeit): rm -rf .wrangler-state && npm run db:lokal && npm run dev        (Port 8791)
 *   OFFICE_ZEIT_SECRET="$(sed -n 's/^OFFICE_ZEIT_SECRET=//p' "<Office-Worktree>/.dev.vars")" node werkzeug/zeit-e2e.js
 * Legt je Lauf neue Personen an (e2e-<Zufall>), lässt sich also wiederholen. Nie gegen ein Live-Office richten:
 * die Adresse ist auf localhost beschränkt.
 */
const Module = require('module');
const path = require('path');
const crypto = require('crypto');

if (!process.env.OFFICE_ZEIT_SECRET) { console.log('OFFICE_ZEIT_SECRET fehlt (siehe Kopf dieser Datei)'); process.exit(1); }
const OFFICE = process.env.OFFICE_URL || 'http://localhost:8791';
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(OFFICE)) { console.log('OFFICE_URL muss ein lokales Office sein (localhost)'); process.exit(1); }
const GEHEIMNIS = process.env.OFFICE_ZEIT_SECRET;
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
Object.assign(process.env, { ADMIN_PASSWORD: 'kubi-e2e', ZWEI_FAKTOR: 'aus', OFFICE_URL: OFFICE });
delete process.env.NETLIFY_BLOBS_SITE_ID;
console.error = () => {};

const team = require(F + '/team.js');
const geraetFn = require(F + '/team-device.js');
const zeit = require(F + '/zeit.js');
const D = require(F + '/lib/zeit-dienst.js');
const { signieren } = require(F + '/lib/office-meldung.js');

let n = 0, fehler = 0;
const ok = (name, b, info) => { n++; if (!b) fehler++; console.log((b ? 'OK     ' : 'FEHLER ') + name + (b || info === undefined ? '' : '   -> ' + JSON.stringify(info))); };
const call = async (h, body) => {
  const r = await h.handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '127.0.0.1' }, body: JSON.stringify(body) });
  let d = {}; try { d = JSON.parse(r.body); } catch (e) {}
  return { s: r.statusCode, d };
};
const vor = (min) => new Date(Date.now() - min * 60000).toISOString();
const uuid = () => crypto.randomUUID();

(async () => {
  const z = crypto.randomBytes(3).toString('hex');
  const ali = 'e2e-a' + z, bea = 'e2e-b' + z, cem = 'e2e-c' + z;
  const heute = D.berlinTag(Date.now());
  await call(team, { action: 'add', password: 'kubi-e2e', name: 'Ali E2E', staffPassword: 'ali-e2e-passwort-42' });
  await store('dienstplan').setJSON('personal', [
    { id: ali, name: 'Ali E2E', farbe: '#E85A24', login: 'ali-e2e' },
    { id: bea, name: 'Bea E2E', farbe: '#6DBE45' },
    { id: cem, name: 'Cem E2E', farbe: '#2B6CB0' },
  ]);
  await store('dienstplan').setJSON('w:' + D.montagVon(heute), { schichten: { [heute]: [{ pid: bea, von: '00:00', bis: '23:59' }] } });
  const kubi = (await call(team, { action: 'anmelden', password: 'kubi-e2e' })).d.token;
  const aliSitzung = (await call(team, { action: 'anmelden', password: 'ali-e2e-passwort-42' })).d.token;
  ok('Anmeldungen am Team', !!kubi && !!aliSitzung);

  // iPad koppeln wie im Cockpit: Code erzeugen und sofort einlösen
  const code = (await call(geraetFn, { action: 'create', password: kubi, zweck: 'stempeluhr', name: 'iPad E2E' })).d.code;
  const red = await call(geraetFn, { action: 'redeem', code, device: 'iPad E2E' });
  const uhr = red.d.token;
  ok('iPad als Stempeluhr gekoppelt', !!uhr && red.d.zweck === 'stempeluhr', red.d);
  const ipad = (aktion, x = {}) => call(zeit, { stempeluhr: uhr, aktion, ...x });

  let r = await ipad('stand');
  const p = (id) => r.d.personen.find((x) => x.id === id);
  ok('Stand: alle frei, Bea mit Schicht zuerst', r.s === 200 && r.d.personen[0].id === bea && p(bea).stand.zustand === 'frei' && p(ali).stand.zustand === 'frei', r.d);
  r = await ipad('stempeln', { person_id: bea, art: 'beginn', schluessel: uuid(), zeit: vor(240) });
  ok('Beginn vor 4 Stunden (aus der Warteschlange): im Dienst', r.s === 200 && r.d.stand.zustand === 'im_dienst', r.d);
  r = await ipad('stempeln', { person_id: bea, art: 'pause_beginn', schluessel: uuid(), zeit: vor(120) });
  ok('Pause', r.d.stand && r.d.stand.zustand === 'pause', r.d);
  r = await ipad('stempeln', { person_id: bea, art: 'pause_ende', schluessel: uuid(), zeit: vor(90) });
  ok('Pause Ende', r.d.stand && r.d.stand.zustand === 'im_dienst', r.d);
  const ende = { person_id: bea, art: 'ende', schluessel: uuid(), zeit: vor(0) };
  r = await ipad('stempeln', ende);
  ok('Ende: 210 Min gearbeitet, +5 Gutschrift', r.s === 200 && r.d.arbeitszeit_min === 210 && r.d.gutschrift_min === 5, r.d);
  ok('Gleicher Schlüssel noch einmal: gleiches Ergebnis', (await ipad('stempeln', ende)).d.arbeitszeit_min === 210);
  r = await ipad('stempeln', { ...ende, art: 'beginn' });
  ok('Gleicher Schlüssel mit anderer Art: 409 schluessel_anders', r.s === 409 && r.d.fehler === 'schluessel_anders', r.d);
  r = await ipad('zuruecknehmen', { person_id: bea, schluessel: uuid(), bezug_schluessel: ende.schluessel, zeit: vor(0) });
  ok('Rückgängig: wieder im Dienst', r.s === 200 && r.d.stand.zustand === 'im_dienst', r.d);
  r = await ipad('stempeln', { person_id: bea, art: 'beginn', schluessel: uuid(), zeit: vor(0) });
  ok('Beginn passt nicht (online): 409 zustand, nichts gespeichert', r.s === 409 && r.d.fehler === 'zustand', r.d);
  r = await ipad('stempeln', { person_id: bea, art: 'ende', schluessel: uuid(), zeit: vor(0) });
  ok('Ende wieder gestempelt', r.s === 200 && r.d.stand.zustand === 'frei', r.d);
  r = await ipad('stempeln', { person_id: bea, art: 'pause_ende', schluessel: uuid(), zeit: vor(30) });
  ok('Unpassender Stempel aus der Warteschlange (30 Min alt): Konflikt, gespeichert', r.s === 200 && r.d.konflikt === true, r.d);
  r = await ipad('stand');
  ok('Konflikt ändert den Stand nicht: Bea frei', p(bea).stand.zustand === 'frei', r.d);

  const handy = (aktion, x = {}) => call(zeit, { password: aliSitzung, aktion, ...x });
  r = await handy('stempeln', { person_id: ali, art: 'beginn', schluessel: uuid(), zeit: vor(60) });
  ok('Handy: Ali stempelt sich ein', r.s === 200 && r.d.stand.zustand === 'im_dienst', r.d);
  r = await handy('stempeln', { person_id: ali, art: 'ende', schluessel: uuid(), zeit: vor(0) });
  ok('Handy: Ali stempelt sich aus', r.s === 200 && r.d.stand.zustand === 'frei', r.d);
  r = await handy('woche', { montag: D.montagVon(heute) });
  ok('Handy: eigene Woche mit 60 Min und Gutschrift', r.s === 200 && r.d.summe.arbeitszeit_min === 60 && r.d.summe.gutschrift_min === 5, r.d.summe || r.d);
  ok('Handy: fremde Person 403', (await handy('stempeln', { person_id: bea, art: 'beginn', schluessel: uuid(), zeit: vor(0) })).s === 403);
  ok('Handy: fremde Woche 403', (await handy('woche', { montag: D.montagVon(heute), person_id: bea })).s === 403);
  ok('iPad: Woche nur am Handy (403)', (await ipad('woche', { montag: D.montagVon(heute) })).s === 403);

  // Office lehnt eine falsche Signatur ab (direkt am Office, ohne Spur)
  const koerper = JSON.stringify({ v: 1, aktion: 'stand', heute, personen: [{ id: bea, name: 'Bea E2E' }] });
  const falsch = signieren(koerper, 'falsches-geheimnis-falsches-geheimnis-0000');
  const fr = await fetch(OFFICE + '/api/zeit', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gnc-zeit': falsch.zeit, 'x-gnc-signatur': falsch.signatur }, body: koerper });
  ok('Office: falsche Signatur 401', fr.status === 401, fr.status);
  const gut = signieren(koerper, GEHEIMNIS);
  const gr = await fetch(OFFICE + '/api/zeit', { method: 'POST', headers: { 'content-type': 'application/json', 'x-gnc-zeit': gut.zeit, 'x-gnc-signatur': gut.signatur }, body: koerper });
  ok('Office: richtige Signatur 200', gr.status === 200, gr.status);

  // Shop mit falschem Geheimnis: 503, das iPad behält den Stempel
  process.env.OFFICE_ZEIT_SECRET = 'falsches-geheimnis-falsches-geheimnis-0000';
  r = await ipad('stempeln', { person_id: cem, art: 'beginn', schluessel: uuid(), zeit: vor(0) });
  ok('Shop mit falschem Geheimnis: 503 office_weg', r.s === 503 && r.d.fehler === 'office_weg', r.d);
  process.env.OFFICE_ZEIT_SECRET = GEHEIMNIS;

  process.env.OFFICE_URL = 'http://localhost:9';
  r = await ipad('stempeln', { person_id: cem, art: 'beginn', schluessel: uuid(), zeit: vor(0) });
  ok('Office weg: 503 office_weg, das iPad behält den Stempel', r.s === 503 && r.d.fehler === 'office_weg', r.d);
  process.env.OFFICE_URL = OFFICE;

  // iPad entkoppeln: danach 401
  const liste = await call(geraetFn, { action: 'list', password: kubi });
  const dev = (liste.d.devices || []).find((x) => x.zweck === 'stempeluhr');
  const rv = await call(geraetFn, { action: 'revoke', password: kubi, id: dev && dev.id });
  ok('iPad entkoppelt', rv.s === 200, rv.d);
  r = await ipad('stand');
  ok('Entkoppeltes iPad: 401', r.s === 401 && r.d.fehler === 'unauthorized', r.d);

  console.log('\n' + (fehler ? fehler + ' von ' + n + ' Prüfungen fehlgeschlagen' : 'Alle ' + n + ' Prüfungen grün'));
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.log('Absturz:', e && e.stack); process.exit(1); });
