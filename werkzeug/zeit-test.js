#!/usr/bin/env node
/**
 * werkzeug/zeit-test.js
 * Zeiterfassung 4a im Shop: Versand ans Office (lib/office-zeit.js, Prüfvektor wie im Office-Test), Dienstplan-Helfer
 * (lib/zeit-dienst.js) und die Function zeit.js mit Stempeluhr und Team-Sitzung. Das Office spielt ein abgefangenes
 * fetch, das jede Anfrage auf ihre Signatur prüft.
 *   node werkzeug/zeit-test.js
 */
const Module = require('module');
const path = require('path');
const crypto = require('crypto');

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
process.env.OFFICE_URL = 'https://office.test';
const G = 'office-zeit-testgeheimnis-0123456789-abcdef';
process.env.OFFICE_ZEIT_SECRET = G;
delete process.env.ZWEI_FAKTOR;
delete process.env.NETLIFY_BLOBS_SITE_ID;
console.error = () => {};
console.warn = () => {};

// Office im Test: prüft die Signatur, merkt sich jede Anfrage und antwortet mit antwort(daten)
const anfragen = [];
let antwort = (d) => ({ status: 200, body: { ok: true, ...(d.aktion === 'stand' ? { personen: d.personen.map((p) => ({ id: p.id, zustand: 'frei' })) } : { stempel: { art: d.art } }) } });
global.fetch = async (url, o) => {
  const sigOk = crypto.createHmac('sha256', G).update(o.headers['x-gnc-zeit'] + '.' + o.body).digest('base64url') === o.headers['x-gnc-signatur'];
  const d = JSON.parse(o.body);
  anfragen.push({ url, d, sigOk });
  const a = antwort(d);
  if (a.wirft) throw new Error('getaddrinfo ENOTFOUND office.test');
  return { ok: a.status < 400, status: a.status, json: async () => a.body };
};

const zf = require(F + '/lib/zweifaktor.js');
const team = require(F + '/team.js');
const geraetFn = require(F + '/team-device.js');
const zeit = require(F + '/zeit.js');
const OZ = require(F + '/lib/office-zeit.js');
const D = require(F + '/lib/zeit-dienst.js');
const { signieren } = require(F + '/lib/office-meldung.js');

let n = 0, fehler = 0;
const ok = (name, b, info) => { n++; if (!b) fehler++; console.log((b ? '✅ ' : '❌ ') + name + (b || info === undefined ? '' : '   → ' + JSON.stringify(info))); };
let ip = 1;
const call = async (h, body, eigeneIp) => {
  const r = await h.handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': eigeneIp || ('10.2.0.' + (ip++ % 250)) }, body: JSON.stringify(body) });
  let d = {}; try { d = JSON.parse(r.body); } catch (e) {}
  return { s: r.statusCode, d };
};
const code = (geheim, d = 0) => zf.hotp(zf.base32lesen(geheim), zf.schrittVon(Date.now()) + d);
async function sitzung(pw) {
  let r = await call(team, { action: 'anmelden', password: pw });
  r = await call(team, { action: 'anmelden', password: pw, einrichtung: r.d.einrichtung, code: code(r.d.geheim) });
  return r.d.token;
}
const uuid = () => crypto.randomUUID();
const jetzt = () => new Date().toISOString();

(async () => {
  /* ---- Versand ans Office ------------------------------------------------- */
  ok('Prüfvektor: dieselbe Signatur wie im Office-Test', signieren('{"v":1,"aktion":"stand","heute":"2027-01-05","personen":[]}', G, 1800000000).signatur === 'hr3K1AIuwBOlMZtcxC5JGRmenDNEu0PyLzKXpU-yJXM');
  let r = await OZ.anOffice({ aktion: 'stand', heute: '2027-01-05', personen: [] });
  const a0 = anfragen[anfragen.length - 1];
  ok('anOffice: POST /api/zeit mit v 1, signiert', r.status === 200 && a0.url === 'https://office.test/api/zeit' && a0.d.v === 1 && a0.sigOk);
  antwort = () => ({ wirft: true });
  ok('Office nicht erreichbar: 503 office_weg', (await OZ.anOffice({ aktion: 'stand' })).daten.fehler === 'office_weg');
  antwort = () => ({ status: 500, body: { fehler: 'server' } });
  ok('Office mit 500: 503 office_weg', (await OZ.anOffice({ aktion: 'stand' })).status === 503);
  antwort = () => ({ status: 401, body: { fehler: 'signatur' } });
  ok('Office lehnt Signatur ab: 503, das Gerät behält den Stempel', (await OZ.anOffice({ aktion: 'stand' })).status === 503);
  antwort = () => ({ status: 409, body: { ok: false, fehler: 'zustand', stand: { zustand: 'frei' } } });
  r = await OZ.anOffice({ aktion: 'stempeln' });
  ok('Office mit 409: geht unverändert weiter', r.status === 409 && r.daten.fehler === 'zustand');
  ok('Zu kurzes Geheimnis: nichts gesendet, 503', (await OZ.anOffice({ aktion: 'stand' }, { geheimnis: 'kurz', holen: async () => { throw new Error('nicht senden'); } })).status === 503);

  /* ---- Dienstplan-Helfer --------------------------------------------------- */
  const plan = { schichten: { '2027-01-05': [{ pid: 'b', von: '16:00', bis: '20:30' }, { pid: 'a', von: '11:30', bis: '15:00' }, { pid: 'a', von: '17:00', bis: '21:00' }] } };
  ok('Schicht am Tag: zwei Schichten werden eine', JSON.stringify(D.schichtAm(plan, '2027-01-05', 'a')) === '{"von":"11:30","bis":"21:00"}' && D.schichtAm(plan, '2027-01-06', 'a') === null);
  const liste = D.personenListe([{ id: 'c', name: 'Cem' }, { id: 'b', name: 'Bea' }, { id: 'a', name: 'Ali' }, { id: 'd', name: 'Ada' }], plan, '2027-01-05');
  ok('Namensliste: erst mit Schicht nach Beginn, dann die übrigen nach Namen', liste.map((p) => p.id).join() === 'a,b,d,c');
  ok('Montag und Berliner Tag', D.montagVon('2027-01-10') === '2027-01-04' && D.istMontag('2027-01-04') && !D.istMontag('2027-01-05') && D.berlinTag(Date.parse('2027-01-04T23:30:00Z')) === '2027-01-05');

  /* ---- Dienstplan, Kubi, Team, iPad --------------------------------------- */
  const heute = D.berlinTag(Date.now());
  daten.set('dienstplan|personal', JSON.stringify([{ id: 'p-ali', name: 'Ali', farbe: '#E85A24', login: 'ali-test' }, { id: 'p-bea', name: 'Bea', farbe: '#6DBE45' }]));
  daten.set('dienstplan|w:' + D.montagVon(heute), JSON.stringify({ schichten: { [heute]: [{ pid: 'p-bea', von: '11:30', bis: '20:30' }] } }));
  const kubi = await sitzung('kubi-test-passwort');
  await call(team, { action: 'add', password: kubi, name: 'Ali Test', staffPassword: 'ali-sesam-truck-42' });
  await call(team, { action: 'add', password: kubi, name: 'Bea Test', staffPassword: 'bea-sesam-truck-42' });
  const ali = await sitzung('ali-sesam-truck-42');
  const bea = await sitzung('bea-sesam-truck-42');
  r = await call(geraetFn, { action: 'create', password: kubi, zweck: 'stempeluhr', name: 'iPad Truck' });
  const uhr = (await call(geraetFn, { action: 'redeem', code: r.d.code, device: 'iPad' })).d;
  ok('Stempeluhr gekoppelt', /^[A-Za-z0-9_-]{43}$/.test(uhr.token) && uhr.zweck === 'stempeluhr');
  antwort = (d) => ({ status: 200, body: { ok: true, ...(d.aktion === 'stand' ? { personen: d.personen.map((p) => ({ id: p.id, zustand: 'frei' })) } : { stempel: { art: d.art } }) } });

  /* ---- iPad ----------------------------------------------------------------- */
  r = await call(zeit, { stempeluhr: uhr.token, aktion: 'stand' });
  let a = anfragen[anfragen.length - 1].d;
  ok('iPad: Stand für alle aus dem Dienstplan, mit Schicht zuerst', r.s === 200 && r.d.personen.map((p) => p.id).join() === 'p-bea,p-ali' && r.d.geraet === 'iPad Truck'
    && r.d.personen[0].schicht.von === '11:30' && r.d.personen[0].stand.zustand === 'frei' && a.heute === heute && a.personen.length === 2, r.d);
  const s1 = { schluessel: uuid(), zeit: jetzt() };
  r = await call(zeit, { stempeluhr: uhr.token, aktion: 'stempeln', person_id: 'p-bea', art: 'beginn', ...s1 });
  a = anfragen[anfragen.length - 1].d;
  ok('iPad stempelt für Bea: Person, Gerät, Quelle und Schicht setzt der Shop', r.s === 200 && a.aktion === 'stempeln' && a.person.name === 'Bea' && a.quelle === 'stempeluhr'
    && a.geraet === 'iPad Truck' && a.von === 'geraet:' + uhr.id && a.schicht.von === '11:30' && a.schluessel === s1.schluessel && a.zeit === s1.zeit, a);
  r = await call(zeit, { stempeluhr: uhr.token, aktion: 'zuruecknehmen', person_id: 'p-bea', schluessel: uuid(), bezug_schluessel: s1.schluessel, zeit: jetzt() });
  a = anfragen[anfragen.length - 1].d;
  ok('iPad nimmt zurück: Bezug und Herkunft gehen mit', r.s === 200 && a.aktion === 'zuruecknehmen' && a.person_id === 'p-bea' && a.bezug_schluessel === s1.schluessel && a.quelle === 'stempeluhr');
  ok('iPad: unbekannte Person 404', (await call(zeit, { stempeluhr: uhr.token, aktion: 'stempeln', person_id: 'p-x', art: 'beginn', schluessel: uuid(), zeit: jetzt() })).s === 404);
  ok('iPad: Eingaben werden geprüft', (await call(zeit, { stempeluhr: uhr.token, aktion: 'stempeln', person_id: 'p-bea', art: 'feierabend', schluessel: uuid(), zeit: jetzt() })).s === 400
    && (await call(zeit, { stempeluhr: uhr.token, aktion: 'stempeln', person_id: 'p-bea', art: 'ende', schluessel: 'x', zeit: jetzt() })).s === 400
    && (await call(zeit, { stempeluhr: uhr.token, aktion: 'stempeln', person_id: 'p-bea', art: 'ende', schluessel: uuid(), zeit: 'jetzt' })).s === 400);
  ok('iPad: keine Woche', (await call(zeit, { stempeluhr: uhr.token, aktion: 'woche', montag: D.montagVon(heute) })).d.fehler === 'nur_handy');
  antwort = () => ({ wirft: true });
  r = await call(zeit, { stempeluhr: uhr.token, aktion: 'stempeln', person_id: 'p-bea', art: 'ende', schluessel: uuid(), zeit: jetzt() });
  ok('Office weg: 503 office_weg, das iPad puffert', r.s === 503 && r.d.fehler === 'office_weg');
  antwort = (d) => ({ status: 200, body: { ok: true, ...(d.aktion === 'stand' ? { personen: d.personen.map((p) => ({ id: p.id, zustand: 'frei' })) } : { stempel: { art: d.art } }) } });

  /* ---- Handy ---------------------------------------------------------------- */
  r = await call(zeit, { password: ali, aktion: 'stand' });
  a = anfragen[anfragen.length - 1].d;
  ok('Handy: Stand nur für die eigene Person', r.s === 200 && r.d.personen.length === 1 && r.d.personen[0].id === 'p-ali' && a.personen.length === 1 && r.d.geraet === null);
  r = await call(zeit, { password: ali, aktion: 'stempeln', person_id: 'p-ali', art: 'beginn', schluessel: uuid(), zeit: jetzt() });
  a = anfragen[anfragen.length - 1].d;
  ok('Handy stempelt: Quelle handy, Gerät Handy, von t-ali-test, ohne Schicht', r.s === 200 && a.quelle === 'handy' && a.geraet === 'Handy' && a.von === 't-ali-test' && a.schicht === null);
  r = await call(zeit, { password: ali, aktion: 'woche', montag: D.montagVon(heute) });
  a = anfragen[anfragen.length - 1].d;
  ok('Handy: eigene Woche', r.s === 200 && a.aktion === 'woche' && a.person_id === 'p-ali' && a.montag === D.montagVon(heute));
  ok('Handy: Woche nur ab Montag', (await call(zeit, { password: ali, aktion: 'woche', montag: heute === D.montagVon(heute) ? D.plusTage(heute, 1) : heute })).s === 400);
  r = await call(zeit, { password: bea, aktion: 'stand' });
  ok('Handy ohne Zuordnung: 403 keine_person mit Erklärung', r.s === 403 && r.d.fehler === 'keine_person' && /Dienstplan/.test(r.d.hint) && !/[–—]/.test(r.d.hint));
  ok('Kubi (Hauptzugang) hat keine Person: 403', (await call(zeit, { password: kubi, aktion: 'stand' })).d.fehler === 'keine_person');
  /* von muss zur Office-Regel passen (t-<login> mit [a-z0-9äöüß-], höchstens 30 Zeichen) und bei Wiederholung gleich bleiben */
  const VON_OFFICE = /^(t-[a-z0-9äöüß-]{1,30}|geraet:[a-f0-9]{8})$/;
  ok('von aus dem Login: Großbuchstaben, Leerzeichen, Sonderzeichen und Länge werden zur Office-Regel', [
    D.vonLogin('Ali'), D.vonLogin('Ali Müller'), D.vonLogin('a.b@c_d'), D.vonLogin('ÄÖÜ'), D.vonLogin('x'.repeat(80)), D.vonLogin('!!!'),
  ].every((v) => VON_OFFICE.test(v)) && D.vonLogin('Ali Müller') === 't-ali-müller' && D.vonLogin('Ali Müller') === D.vonLogin('Ali Müller'), [D.vonLogin('Ali Müller'), D.vonLogin('!!!')]);
  ok('von der Stempeluhr: geraet: plus 8 Hex', VON_OFFICE.test('geraet:' + uhr.id));
  ok('Ohne Anmeldung: 401', (await call(zeit, { aktion: 'stand' })).s === 401);

  console.log('\n' + (fehler ? '❌ ' + fehler + ' von ' + n + ' Prüfungen fehlgeschlagen' : '✅ Alle ' + n + ' Prüfungen grün'));
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.log('Absturz:', e && e.stack); process.exit(1); });
