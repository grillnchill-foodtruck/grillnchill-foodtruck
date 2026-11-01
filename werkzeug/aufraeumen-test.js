#!/usr/bin/env node
/**
 * werkzeug/aufraeumen-test.js
 * ----------------------------------------------------------------------------
 * Prüft lib/aufraeumen.js mit einem Blob-Speicher im Arbeitsspeicher:
 *
 *   node werkzeug/aufraeumen-test.js
 *
 * Abgelaufenes wird gelöscht, Frisches und Einträge ohne Datum bleiben.
 * ----------------------------------------------------------------------------
 */
const path = require('path');
const { aufraeumen } = require(path.join(__dirname, '..', 'netlify', 'functions', 'lib', 'aufraeumen'));

const daten = new Map();
const store = (name) => ({
  async get(k) { const v = daten.get(name + '|' + k); return v === undefined ? null : JSON.parse(v); },
  async setJSON(k, v) { daten.set(name + '|' + k, JSON.stringify(v)); },
  async delete(k) { daten.delete(name + '|' + k); },
  async list({ prefix } = {}) {
    return { blobs: [...daten.keys()].filter((k) => k.startsWith(name + '|' + (prefix || ''))).map((k) => ({ key: k.slice(name.length + 1) })) };
  },
});
const setze = (name, k, v) => daten.set(name + '|' + k, JSON.stringify(v));
const da = (name, k) => daten.has(name + '|' + k);

let n = 0, fehler = 0;
const ok = (titel, b) => { n++; console.log((b ? '✅ ' : '❌ ') + titel); if (!b) fehler++; };

const JETZT = Date.parse('2026-11-02T03:00:00Z');
const vor = (tage) => new Date(JETZT - tage * 86400000).toISOString();
const tag = (tage) => new Date(JETZT - tage * 86400000).toISOString().slice(0, 10);

setze('geo', '_takt', { at: vor(900) });
setze('geo', 'a1', { lat: 1, lng: 2, at: vor(400) });
setze('geo', 'a2', { lat: 1, lng: 2, at: vor(10) });
setze('geo', 'a3', { lat: 1, lng: 2 });
setze('feedback', 'f:GNC-1', { stars: 2, at: vor(800) });
setze('feedback', 'f:GNC-2', { stars: 5, at: vor(100) });
setze('abholnr', 't:' + tag(40), { n: 9 });
setze('abholnr', 't:' + tag(2), { n: 3 });
setze('fahrt', 'pos:GNC-3', { lat: 1, lng: 2, at: new Date(JETZT - 7 * 3600000).toISOString() });
setze('fahrt', 'pos:GNC-4', { lat: 1, lng: 2, at: JETZT - 9 * 3600000 });
setze('fahrt', 'pos:GNC-5', { lat: 1, lng: 2, at: new Date(JETZT - 600000).toISOString() });
setze('bremse', tag(5) + '/kasse/abc', { n: 1 });
setze('bremse', tag(1) + '/kasse/abc', { n: 1 });
setze('bremse', 'alarm/kasse', { at: vor(1) });
setze('firmen', 'antrag:x1', { status: 'abgelehnt', entschiedenAt: vor(200) });
setze('firmen', 'antrag:x2', { status: 'abgelehnt', entschiedenAt: vor(20) });
setze('firmen', 'antrag:x3', { status: 'angenommen', entschiedenAt: vor(400) });
setze('firmen', 'firma:f1', { name: 'Test GmbH' });

(async () => {
  const r = await aufraeumen(store, { jetzt: JETZT, budgetMs: 5000 });
  ok('Geo: alt gelöscht, frisch und ohne Datum bleiben, Takt bleibt', !da('geo', 'a1') && da('geo', 'a2') && da('geo', 'a3') && da('geo', '_takt'));
  ok('Feedback: nach 730 Tagen gelöscht, jüngeres bleibt', !da('feedback', 'f:GNC-1') && da('feedback', 'f:GNC-2'));
  ok('Abholnummern: alter Tageszähler weg, jüngerer bleibt', !da('abholnr', 't:' + tag(40)) && da('abholnr', 't:' + tag(2)));
  ok('Fahrt: Positionen über 6 Stunden weg (ISO und Zahl), frische bleibt', !da('fahrt', 'pos:GNC-3') && !da('fahrt', 'pos:GNC-4') && da('fahrt', 'pos:GNC-5'));
  ok('Bremse: alter Tag weg, gestern und Alarm-Merker bleiben', !da('bremse', tag(5) + '/kasse/abc') && da('bremse', tag(1) + '/kasse/abc') && da('bremse', 'alarm/kasse'));
  ok('Firmen: nur alte abgelehnte Anträge weg, Firmen bleiben', !da('firmen', 'antrag:x1') && da('firmen', 'antrag:x2') && da('firmen', 'antrag:x3') && da('firmen', 'firma:f1'));
  ok('Zählung stimmt', r.geo === 1 && r.feedback === 1 && r.abholnr === 1 && r.fahrt === 2 && r.bremse === 1 && r.firmen === 1 && !r.abgebrochen);
  const r2 = await aufraeumen(store, { jetzt: JETZT, budgetMs: 5000 });
  ok('Zweiter Lauf löscht nichts mehr', Object.keys(r2).every((k) => k === 'abgebrochen' || r2[k] === 0));
  console.log('\n' + (n - fehler) + ' von ' + n + (fehler ? ' – ' + fehler + ' FEHLER' : ' grün'));
  process.exit(fehler ? 1 : 0);
})();
