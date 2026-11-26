#!/usr/bin/env node
/**
 * werkzeug/office-meldung-test.js
 * Versand ans GNC Office: Signatur wie im Office (Prüfvektor), 5er-Pakete, Fehler, Geheimnis aus den Blobs.
 *   node werkzeug/office-meldung-test.js
 */
const path = require('path');
const Module = require('module');
const crypto = require('crypto');
const DATEN = new Map();
const store = (name) => ({
  async get(k, o) { const v = DATEN.get(name + '|' + k); return v === undefined ? null : (o && o.type === 'json' ? JSON.parse(v) : v); },
  async setJSON(k, v) { DATEN.set(name + '|' + k, JSON.stringify(v)); return { modified: true }; },
  async delete(k) { DATEN.delete(name + '|' + k); },
  async list({ prefix } = {}) { return { blobs: [...DATEN.keys()].filter((k) => k.startsWith(name + '|' + (prefix || ''))).map((k) => ({ key: k.slice(name.length + 1) })) }; },
});
const orig = Module._load;
Module._load = function (r, ...a) { if (r === '@netlify/blobs') return { getStore: (o) => store(typeof o === 'string' ? o : o.name) }; return orig.call(this, r, ...a); };
delete process.env.NETLIFY_BLOBS_SITE_ID;
delete process.env.OFFICE_EINGANG_SECRET;
process.env.OFFICE_URL = 'https://office.test';

const F = path.join(__dirname, '..', 'netlify', 'functions');
const M = require(F + '/lib/office-meldung.js');
const { geheimnisHolen } = require(F + '/lib/geheimnisse.js');
const G = 'office-eingang-testgeheimnis-0123456789';

let n = 0, fehler = 0;
const ok = (name, b, info) => { n++; if (!b) fehler++; console.log((b ? '✅ ' : '❌ ') + name + (b || info === undefined ? '' : '   → ' + JSON.stringify(info))); };
const meldung = (i) => ({ schluessel: 'tag:2027-01-' + String(i).padStart(2, '0') + ':online', art: 'tag', daten: { datum: '2027-01-' + String(i).padStart(2, '0'), posten: [] } });

(async () => {
  // Prüfvektor, im Office-Format mit WebCrypto erzeugt
  ok('Signatur wie im Office', M.signieren('{"v":1,"meldungen":[]}', G, 1800000000).signatur === 'kC94dq0qnhQWKaDycp91NbDv5dcryWaBtfq87LhhpsQ');

  const anfragen = [];
  const holen = async (url, opt) => {
    const d = JSON.parse(opt.body);
    anfragen.push({ url, d, kopf: opt.headers });
    return new Response(JSON.stringify({ ok: true, ergebnisse: d.meldungen.map((m) => ({ schluessel: m.schluessel, status: 'gebucht' })), offen: anfragen.length }), { status: 200 });
  };
  const alle = Array.from({ length: 23 }, (_, i) => meldung(i + 1));
  let r = await M.senden(alle, { holen, geheimnis: G });
  ok('23 Meldungen gehen in fünf Paketen zu 5, 5, 5, 5 und 3', anfragen.map((a) => a.d.meldungen.length).join(',') === '5,5,5,5,3', anfragen.map((a) => a.d.meldungen.length));
  ok('… an /api/eingang mit v 1, in der gegebenen Reihenfolge', anfragen.every((a) => a.url === 'https://office.test/api/eingang' && a.d.v === 1)
    && anfragen.flatMap((a) => a.d.meldungen.map((m) => m.schluessel)).join() === alle.map((m) => m.schluessel).join());
  const a0 = anfragen[0];
  const erwartet = crypto.createHmac('sha256', G).update(a0.kopf['x-gnc-zeit'] + '.' + JSON.stringify(a0.d)).digest('base64url');
  ok('… jede Anfrage signiert über Zeit und Körper', a0.kopf['x-gnc-signatur'] === erwartet && /^\d{10}$/.test(a0.kopf['x-gnc-zeit']));
  ok('… alle Ergebnisse, offen aus der letzten Antwort, kein Fehler', r.ergebnisse.length === 23 && r.offen === 5 && r.fehler === null, r.fehler);

  let zaehler = 0;
  r = await M.senden(alle, { geheimnis: G, holen: async (url, opt) => { if (++zaehler === 2) throw new Error('getaddrinfo ENOTFOUND office.test'); return holen(url, opt); } });
  ok('Netzfehler im zweiten Paket: Ergebnisse des ersten bleiben, Fehler benannt', r.ergebnisse.length === 5 && /^netz: /.test(r.fehler), r);
  r = await M.senden(alle, { geheimnis: G, holen: async () => new Response(JSON.stringify({ ok: false, fehler: 'signatur' }), { status: 401 }) });
  ok('Office lehnt ab: office_401 signatur', r.fehler === 'office_401 signatur' && r.ergebnisse.length === 0, r);
  r = await M.senden(alle, { geheimnis: G, holen: async () => new Response('null', { status: 200 }) });
  ok('Antwort null (Status 200): kein Absturz, Fehler office_200', r.fehler === 'office_200' && r.ergebnisse.length === 0, r);
  r = await M.senden(alle, { geheimnis: G, holen: async () => new Response('null', { status: 502 }) });
  ok('Antwort null (Status 502): kein Absturz, Fehler office_502', r.fehler === 'office_502', r);
  r = await M.senden(alle, { geheimnis: G, holen: async () => new Response('kein json', { status: 500 }) });
  ok('Antwort ohne JSON: office_500', r.fehler === 'office_500', r);
  zaehler = 0;
  r = await M.senden(alle, { geheimnis: G, holen: async (url, opt) => {
    const d = JSON.parse(opt.body);
    const erg = d.meldungen.map((m) => ({ schluessel: m.schluessel, status: 'gebucht' }));
    return new Response(JSON.stringify({ ok: true, ergebnisse: ++zaehler === 2 ? erg.slice(1) : erg, offen: 0 }), { status: 200 });
  } });
  ok('Zu wenige Ergebnisse im zweiten Paket: antwort_unvollstaendig, nur das erste Paket zählt', r.fehler === 'antwort_unvollstaendig' && r.ergebnisse.length === 5 && zaehler === 2, r);
  zaehler = 0;
  r = await M.senden(alle, { geheimnis: G, frist: 30, holen: async (url, opt) => { zaehler++; await new Promise((res) => setTimeout(res, 60)); return holen(url, opt); } });
  ok('Frist abgelaufen: keine weiteren Pakete, Fehler frist', r.fehler === 'frist' && zaehler === 1 && r.ergebnisse.length === 5, { zaehler, r });
  zaehler = 0;
  r = await M.senden(alle, { geheimnis: G, frist: 0, holen: async () => { zaehler++; return new Response('{}'); } });
  ok('Frist 0: gar nichts gesendet', r.fehler === 'frist' && zaehler === 0 && r.ergebnisse.length === 0, r);
  r = await M.senden(alle, { geheimnis: G, holen });
  ok('Standardfrist (20 s) reicht für den Normalfall', r.fehler === null && r.ergebnisse.length === 23);

  zaehler = 0;
  r = await M.senden(alle, { geheimnis: 'kurz', holen: async () => { zaehler++; return new Response('{}'); } });
  ok('Zu kurzes Geheimnis: nichts gesendet', r.fehler === 'nicht_eingerichtet' && zaehler === 0, r);
  r = await M.senden([], { geheimnis: G, holen: async () => { throw new Error('nicht aufrufen'); } });
  ok('Keine Meldungen: keine Anfrage', r.fehler === null && r.ergebnisse.length === 0);

  r = await M.senden(alle.slice(0, 7), { geheimnis: G, holen: async (url, opt) => { const d = JSON.parse(opt.body); return new Response(JSON.stringify({ ok: true, ergebnisse: d.meldungen.map((m) => ({ schluessel: m.schluessel, status: 'gebucht' })), offen: 0, sicherung: '2027-01-02' }), { status: 200 }); } });
  ok('sicherung aus der letzten Antwort', r.sicherung === '2027-01-02' && r.fehler === null, r);
  r = await M.senden(alle.slice(0, 2), { geheimnis: G, holen });
  ok('sicherung fehlt in der Antwort: undefined', r.sicherung === undefined && r.fehler === null, r);

  DATEN.set('geheimnisse|office-eingang-secret', '  ' + G + '\n');
  ok('Geheimnis aus dem Blob-Store, ohne Leerzeichen', (await geheimnisHolen('office-eingang-secret', 'OFFICE_EINGANG_SECRET')) === G);
  process.env.OFFICE_EINGANG_SECRET = 'aus-der-umgebung-0123456789-0123456789';
  ok('Umgebungsvariable geht vor', (await geheimnisHolen('office-eingang-secret', 'OFFICE_EINGANG_SECRET')) === 'aus-der-umgebung-0123456789-0123456789');
  ok('Fehlendes Geheimnis ergibt leeren Text', (await geheimnisHolen('gibt-es-nicht', 'GIBT_ES_NICHT')) === '');

  console.log('\n' + (fehler ? '❌ ' + fehler + ' von ' + n + ' Prüfungen fehlgeschlagen' : '✅ Alle ' + n + ' Prüfungen grün'));
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.log('Absturz:', e && e.stack); process.exit(1); });
