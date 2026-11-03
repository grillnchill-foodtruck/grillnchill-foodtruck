#!/usr/bin/env node
/**
 * werkzeug/lieblingstag-test.js
 * ----------------------------------------------------------------------------
 * Prüft die Erinnerung zum Lieblingstag gegen die echten Handler, mit einem
 * Blob-Speicher im Arbeitsspeicher:
 *
 *   node werkzeug/lieblingstag-test.js
 *
 * Erkennung aus den letzten Bestellungen, Uhrzeit der Erinnerung, einmal pro
 * Woche, Feiertag, Pause, schon bestellt, Versand an Browser und iOS-Thema,
 * abgelaufene Abos, An/Aus nur mit gültigem Konto-Token.
 * ----------------------------------------------------------------------------
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
const originalLoad = Module._load;
Module._load = function (anfrage, ...rest) {
  if (anfrage === '@netlify/blobs') return { getStore: (o) => store(typeof o === 'string' ? o : o.name) };
  return originalLoad.call(this, anfrage, ...rest);
};
global.fetch = async () => ({ ok: true, json: async () => ({}) });

const L = require(path.join(F, 'lib', 'lieblingstag'));
const handler = require(path.join(F, 'lieblingstag')).handler;
const { lauf } = require(path.join(F, 'lieblingstag-erinnerung'));

let n = 0, fehler = 0;
const ok = (titel, b, info) => { n++; console.log((b ? '✅ ' : '❌ ') + titel + (b || info === undefined ? '' : '\n   ' + JSON.stringify(info))); if (!b) fehler++; };

/* Berliner Wanduhrzeit → Date (bis 24.10.2026 Sommerzeit UTC+2, danach MEZ UTC+1). */
const berlin = (ymd, hhmm) => new Date(ymd + 'T' + hhmm + ':00' + (ymd < '2026-10-25' ? '+02:00' : '+01:00'));
// Freitag, 6. November 2026, und davor die Freitage 30.10., 23.10.; ein Dienstag dazwischen
const ORDERS = [
  { at: berlin('2026-10-30', '12:05').toISOString() },
  { at: berlin('2026-10-27', '18:40').toISOString() },
  { at: berlin('2026-10-23', '11:55').toISOString() },
];

(async () => {
  /* ---- Erkennung ---- */
  const jetzt = berlin('2026-11-06', '11:20');
  const fav = L.erkennen(ORDERS, jetzt);
  ok('Lieblingstag Freitag erkannt', fav && fav.wd === 5, fav);
  ok('Übliche Zeit 12:00 (Median, auf 5 Min.)', fav && L.zeitText(fav.minute) === '12:00', fav);
  ok('Erinnerung 11:15 (40 Min. vorher, auf die Viertelstunde)', fav && L.zeitText(fav.erinnerung) === '11:15', fav);
  ok('Ein Treffer reicht nicht', L.erkennen([ORDERS[0]], jetzt) === null);
  ok('Alte Bestellungen (über 10 Wochen) zählen nicht', L.erkennen(ORDERS, berlin('2027-02-01', '11:00')) === null);
  ok('Sonntag wird nie Lieblingstag', L.erkennen([{ at: berlin('2026-11-01', '12:00').toISOString() }, { at: berlin('2026-10-25', '12:00').toISOString() }], jetzt) === null);
  const frueh = L.erkennen([{ at: berlin('2026-10-30', '09:10').toISOString() }, { at: berlin('2026-10-23', '09:20').toISOString() }], jetzt);
  ok('Nie vor 9 Uhr erinnern', frueh && L.zeitText(frueh.erinnerung) === '09:00', frueh);
  ok('Feiertage NRW: Allerheiligen, Karfreitag 2027, normaler Tag', L.istFeiertag('2026-11-01') && L.istFeiertag('2027-03-26') && !L.istFeiertag('2026-11-06'));

  /* ---- faellig ---- */
  const rec = { orders: ORDERS, lieblingstag: { an: true, lang: 'de', web: [{ endpoint: 'https://push.example/a', keys: { p256dh: 'x', auth: 'y' } }] } };
  ok('Fällig am Freitag um 11:20', L.faellig(rec, jetzt).ja === true, L.faellig(rec, jetzt));
  ok('Nicht um 11:35 (anderes Viertelstunden-Fenster)', L.faellig(rec, berlin('2026-11-06', '11:35')).grund === 'nicht_jetzt');
  ok('Nicht am Donnerstag', L.faellig(rec, berlin('2026-11-05', '11:20')).grund === 'anderer_tag');
  ok('Nicht wenn aus', L.faellig({ ...rec, lieblingstag: { ...rec.lieblingstag, an: false } }, jetzt).grund === 'aus');
  ok('Nicht ohne Gerät', L.faellig({ ...rec, lieblingstag: { an: true, web: [] } }, jetzt).grund === 'kein_geraet');
  ok('Höchstens einmal pro Woche', L.faellig({ ...rec, lieblingstag: { ...rec.lieblingstag, zuletzt: berlin('2026-11-03', '11:00').toISOString() } }, jetzt).grund === 'diese_woche');
  const heuteBestellt = { ...rec, orders: [{ at: berlin('2026-11-06', '10:50').toISOString() }, ...ORDERS] };
  ok('Nicht wenn heute schon bestellt', L.faellig(heuteBestellt, jetzt).grund === 'schon_bestellt');
  ok('Nicht wenn heute pausiert', L.faellig(rec, jetzt, { paused: true, dayKey: '2026-11-06' }).grund === 'pausiert');
  ok('Pause von gestern zählt nicht', L.faellig(rec, jetzt, { paused: true, dayKey: '2026-11-05' }).ja === true);
  const feiertagRec = { orders: [{ at: berlin('2026-10-25', '12:00').toISOString() }, { at: berlin('2026-10-18', '12:00').toISOString() }].map((o) => o), lieblingstag: rec.lieblingstag };
  // Sonntage sind ohnehin zu; Feiertag an einem Werktag: Fronleichnam 2027 ist Donnerstag, 27.05.
  const doRec = { orders: [{ at: new Date('2027-05-20T12:00:00+02:00').toISOString() }, { at: new Date('2027-05-13T12:00:00+02:00').toISOString() }], lieblingstag: rec.lieblingstag };
  ok('Nicht an Feiertagen (Fronleichnam 2027)', L.faellig(doRec, new Date('2027-05-27T11:20:00+02:00')).grund === 'geschlossen', L.faellig(doRec, new Date('2027-05-27T11:20:00+02:00')));
  void feiertagRec;

  /* ---- Texte ---- */
  const de = L.nachricht('de', fav);
  ok('Text Deutsch nennt Freitags und 12:00, ohne Ausrufezeichen', /Freitags/.test(de.body) && /12:00/.test(de.body) && !/[!–—]/.test(de.title + de.body), de);
  ok('Text Türkisch und Englisch vorhanden, Link zum Nochmal-Bestellen', /Cuma/.test(L.nachricht('tr', fav).body) && /Fridays/.test(L.nachricht('en', fav).body) && de.url === '/?reorder=1');

  /* ---- Endpunkt an/aus ---- */
  const email = 'gast@example.com';
  const key = 'c:' + crypto.createHash('sha256').update(email).digest('hex');
  const token = crypto.randomBytes(24).toString('hex');
  daten.set('customers|' + key, JSON.stringify({ email, orders: ORDERS, tokens: { [token]: new Date(Date.now() + 86400000).toISOString() } }));
  const rufe = (body) => handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '203.0.113.' + (1 + (n % 200)) }, body: JSON.stringify(body) });
  let r = await rufe({ action: 'an', email, token: 'falsch', subscription: { endpoint: 'https://push.example/b', keys: { p256dh: 'p', auth: 'a' } } });
  ok('Falscher Token: 401', r.statusCode === 401, r.statusCode);
  r = await rufe({ action: 'an', email, token, lang: 'tr', subscription: { endpoint: 'https://push.example/b', keys: { p256dh: 'p', auth: 'a' } } });
  let d = JSON.parse(r.body);
  ok('Einschalten im Browser: 200, Wochentag im Ergebnis', r.statusCode === 200 && d.lieblingstag.an && d.lieblingstag.wd === 5, d);
  ok('Verzeichnis-Eintrag angelegt', daten.has('lieblingstag|' + key));
  r = await rufe({ action: 'an', email, token, ios: true });
  d = JSON.parse(r.body);
  ok('Einschalten in der iOS-App vergibt ein zufälliges Thema', r.statusCode === 200 && /^lt_[0-9a-f]{24}$/.test(d.thema || ''), d);
  const thema = d.thema;
  r = await rufe({ action: 'an', email, token, subscription: { endpoint: 'javascript:alert(1)', keys: { p256dh: 'p', auth: 'a' } } });
  const gespeichert = JSON.parse(daten.get('customers|' + key)).lieblingstag;
  ok('Ungültiges Abo wird nicht übernommen, Thema bleibt', gespeichert.web.length === 1 && gespeichert.thema === thema && gespeichert.lang === 'tr', gespeichert);
  r = await rufe({ action: 'an', email, token: token + 'x' });
  ok('Leeres Einschalten ohne Gerät eines fremden Tokens: 401', r.statusCode === 401);

  /* ---- Versand ---- */
  const gesendet = [];
  const webpush = { async sendNotification(sub, payload) { gesendet.push(['web', sub.endpoint, JSON.parse(payload)]); if (sub.endpoint.endsWith('/weg')) { const e = new Error('gone'); e.statusCode = 410; throw e; } } };
  const sendeAnThema = async (t, titel, text) => { gesendet.push(['ios', t, titel, text]); return { ok: true }; };
  // zweites, abgelaufenes Abo dazu
  const rec2 = JSON.parse(daten.get('customers|' + key));
  rec2.lieblingstag.web.push({ endpoint: 'https://push.example/weg', keys: { p256dh: 'p', auth: 'a' } });
  daten.set('customers|' + key, JSON.stringify(rec2));
  let e = await lauf({ holeStore: store, webpush, sendeAnThema, jetzt });
  ok('Lauf schickt an Browser und iOS-Thema', e.gesendet === 1 && e.web === 1 && e.ios === 1, e);
  ok('Abgelaufenes Abo entfernt', e.entfernt === 1 && JSON.parse(daten.get('customers|' + key)).lieblingstag.web.length === 1, e);
  ok('Nachricht auf Türkisch (gewählte Sprache)', gesendet.some((g) => g[0] === 'ios' && /Cuma/.test(g[3])), gesendet);
  gesendet.length = 0;
  e = await lauf({ holeStore: store, webpush, sendeAnThema, jetzt: new Date(jetzt.getTime() + 5 * 60000) });
  ok('Zweiter Lauf im selben Fenster schickt nichts', gesendet.length === 0 && e.gesendet === 0, e);
  daten.set('shop-status|status', JSON.stringify({ paused: true, dayKey: '2026-11-13' }));
  const rec3 = JSON.parse(daten.get('customers|' + key)); rec3.lieblingstag.zuletzt = null; daten.set('customers|' + key, JSON.stringify(rec3));
  e = await lauf({ holeStore: store, webpush, sendeAnThema, jetzt: berlin('2026-11-13', '11:20') });
  ok('Bei Pause am Tag selbst nichts', e.gesendet === 0, e);

  /* ---- Ausschalten ---- */
  r = await rufe({ action: 'aus', email, token });
  d = JSON.parse(r.body);
  ok('Ausschalten liefert das alte Thema zum Abbestellen', r.statusCode === 200 && d.thema === thema && d.lieblingstag.an === false, d);
  ok('Verknüpfung und Verzeichnis gelöscht', !JSON.parse(daten.get('customers|' + key)).lieblingstag && !daten.has('lieblingstag|' + key));
  daten.set('lieblingstag|c:geloescht', JSON.stringify({ seit: 'x' }));
  e = await lauf({ holeStore: store, webpush, sendeAnThema, jetzt });
  ok('Verzeichnis-Eintrag eines gelöschten Kontos wird aufgeräumt', !daten.has('lieblingstag|c:geloescht'), e);

  console.log('\n' + (n - fehler) + ' von ' + n + (fehler ? ' – ' + fehler + ' FEHLER' : ' grün'));
  process.exit(fehler ? 1 : 0);
})();
