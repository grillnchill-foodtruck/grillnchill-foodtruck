#!/usr/bin/env node
/**
 * werkzeug/dienstplan-test.js
 * Dienstplan: Team-Login je Person (Zeiterfassung 4a). Nur Admins sehen und setzen die Zuordnung, ein Login gehört
 * zu höchstens einer Person, und nur Zugänge aus dem Store team sind erlaubt.
 *   node werkzeug/dienstplan-test.js
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
console.error = () => {};

const zf = require(F + '/lib/zweifaktor.js');
const team = require(F + '/team.js');
const dienstplan = require(F + '/dienstplan.js');

let n = 0, fehler = 0;
const ok = (name, b, info) => { n++; if (!b) fehler++; console.log((b ? '✅ ' : '❌ ') + name + (b || info === undefined ? '' : '   → ' + JSON.stringify(info))); };
let ip = 1;
const call = async (h, body) => {
  const r = await h.handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '10.3.0.' + (ip++ % 250) }, body: JSON.stringify(body) });
  let d = {}; try { d = JSON.parse(r.body); } catch (e) {}
  return { s: r.statusCode, d };
};
const code = (geheim) => zf.hotp(zf.base32lesen(geheim), zf.schrittVon(Date.now()));
async function sitzung(pw) {
  let r = await call(team, { action: 'anmelden', password: pw });
  r = await call(team, { action: 'anmelden', password: pw, einrichtung: r.d.einrichtung, code: code(r.d.geheim) });
  return r.d.token;
}

(async () => {
  const kubi = await sitzung('kubi-test-passwort');
  await call(team, { action: 'add', password: kubi, name: 'Ali Test', staffPassword: 'ali-sesam-truck-42' });
  await call(team, { action: 'add', password: kubi, name: 'Bea Test', staffPassword: 'bea-sesam-truck-42' });
  const ali = await sitzung('ali-sesam-truck-42');
  const woche = '2027-01-04';

  let r = await call(dienstplan, { password: kubi, action: 'personal', personal: [{ name: 'Ali', farbe: '#E85A24', login: 'ali-test' }, { name: 'Bea', farbe: '#6DBE45' }] });
  ok('Admin speichert Personal mit Team-Login', r.s === 200 && r.d.personal[0].login === 'ali-test' && !('login' in r.d.personal[1]));
  r = await call(dienstplan, { password: kubi, action: 'lesen', woche });
  ok('Admin liest Personal mit Login und die Liste der Zugänge', r.d.personal[0].login === 'ali-test'
    && JSON.stringify(r.d.logins) === JSON.stringify([{ login: 'ali-test', name: 'Ali Test' }, { login: 'bea-test', name: 'Bea Test' }]), r.d.logins);
  r = await call(dienstplan, { password: ali, action: 'lesen', woche });
  ok('Mitarbeiter sieht den Plan ohne Logins und ohne Zugangsliste', r.s === 200 && r.d.personal.every((p) => !('login' in p)) && !('logins' in r.d));
  const id = (await call(dienstplan, { password: kubi, action: 'lesen', woche })).d.personal[0].id;
  r = await call(dienstplan, { password: kubi, action: 'personal', personal: [{ id, name: 'Ali', login: 'ali-test' }, { name: 'Bea', login: 'ali-test' }] });
  ok('Ein Login gehört zu höchstens einer Person (400)', r.s === 400 && r.d.error === 'login_doppelt' && !/[–—]/.test(r.d.hint));
  r = await call(dienstplan, { password: kubi, action: 'personal', personal: [{ id, name: 'Ali', login: 'gibt-es-nicht' }] });
  ok('Nur vorhandene Team-Zugänge (400)', r.s === 400 && r.d.error === 'login_unbekannt');
  r = await call(dienstplan, { password: kubi, action: 'lesen', woche });
  ok('Nach den Fehlern bleibt die alte Zuordnung', r.d.personal[0].login === 'ali-test' && r.d.personal[0].id === id);
  // Verbindung zu zeit.js: dort gilt login === slug(Name des Zugangs), also ohne das Präfix u:
  const gespeichert = (await dienstplan.handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '10.3.9.9' }, body: JSON.stringify({ password: kubi, action: 'lesen', woche }) }));
  const pl = JSON.parse(gespeichert.body).personal;
  ok('Gespeichertes login ist slug(Zugangsname) und zeit.js findet die Person', zf.slug('Ali Test') === 'ali-test' && (pl.find((p) => p.login === zf.slug('Ali Test')) || {}).name === 'Ali');
  ok('Mitarbeiter darf das Personal nicht ändern (403)', (await call(dienstplan, { password: ali, action: 'personal', personal: [] })).s === 403);

  console.log('\n' + (fehler ? '❌ ' + fehler + ' von ' + n + ' Prüfungen fehlgeschlagen' : '✅ Alle ' + n + ' Prüfungen grün'));
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.log('Absturz:', e && e.stack); process.exit(1); });
