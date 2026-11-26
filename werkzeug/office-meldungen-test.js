#!/usr/bin/env node
/**
 * werkzeug/office-meldungen-test.js
 * Nächtlicher Lauf fürs GNC Office: sammeln, bauen, senden, merken, Telegram.
 *   node werkzeug/office-meldungen-test.js
 */
const path = require('path');
const Module = require('module');
const crypto = require('crypto');
const DATEN = new Map();
const store = (name) => ({
  async get(k, o) { const v = DATEN.get(name + '|' + k); return v === undefined ? null : (o && o.type === 'json' ? JSON.parse(v) : v); },
  async setJSON(k, v, o) { const key = name + '|' + k; if (o && o.onlyIfNew && DATEN.has(key)) return { modified: false }; DATEN.set(key, JSON.stringify(v)); return { modified: true }; },
  async delete(k) { DATEN.delete(name + '|' + k); },
  async list({ prefix } = {}) { return { blobs: [...DATEN.keys()].filter((k) => k.startsWith(name + '|' + (prefix || ''))).map((k) => ({ key: k.slice(name.length + 1) })) }; },
});
const orig = Module._load;
Module._load = function (r, ...a) { if (r === '@netlify/blobs') return { getStore: (o) => store(typeof o === 'string' ? o : o.name) }; return orig.call(this, r, ...a); };
const G = 'office-eingang-testgeheimnis-0123456789';
Object.assign(process.env, { OFFICE_EINGANG_SECRET: G, OFFICE_URL: 'https://office.test', TELEGRAM_BOT_TOKEN: 'tg', TELEGRAM_CHAT_ID: '1' });
delete process.env.NETLIFY_BLOBS_SITE_ID;

const setze = (s, k, v) => DATEN.set(s + '|' + k, JSON.stringify(v));
const lies = (s, k) => { const v = DATEN.get(s + '|' + k); return v === undefined ? null : JSON.parse(v); };

// Office-Ersatz: prüft die Signatur und merkt sich Fassungen wie das echte Office
const OFFICE = new Map();
const ANFRAGEN = [];
const TELEGRAM = [];
let officeKaputt = false;
let sicherung = '2027-01-07';   // Tag der neuesten Nachtsicherung im Office-Ersatz, 'fehlt' lässt das Feld weg
global.fetch = async (url, opt = {}) => {
  if (url.startsWith('https://office.test/api/eingang')) {
    if (officeKaputt) throw new Error('getaddrinfo ENOTFOUND office.test');
    const sig = crypto.createHmac('sha256', G).update(opt.headers['x-gnc-zeit'] + '.' + opt.body).digest('base64url');
    if (sig !== opt.headers['x-gnc-signatur']) return new Response(JSON.stringify({ fehler: 'signatur' }), { status: 401 });
    const d = JSON.parse(opt.body);
    ANFRAGEN.push(d.meldungen.map((m) => m.schluessel));
    const ergebnisse = d.meldungen.map((m) => {
      const h = JSON.stringify(m.daten);
      if (!OFFICE.has(m.schluessel)) { OFFICE.set(m.schluessel, h); return { schluessel: m.schluessel, status: 'gebucht' }; }
      return { schluessel: m.schluessel, status: OFFICE.get(m.schluessel) === h ? 'doppelt' : 'abweichend' };
    });
    const antwort = { ok: true, ergebnisse, offen: ergebnisse.filter((e) => e.status === 'abweichend').length };
    if (sicherung !== 'fehlt') antwort.sicherung = sicherung;
    return new Response(JSON.stringify(antwort), { status: 200 });
  }
  if (url.startsWith('https://api.telegram.org/')) { TELEGRAM.push(JSON.parse(opt.body).text); return new Response('{"ok":true}', { status: 200 }); }
  throw new Error('unerwartet: ' + url);
};

const F = path.join(__dirname, '..', 'netlify', 'functions');
const { lauf } = require(F + '/office-meldungen.js');

let n = 0, fehler = 0;
const ok = (name, b, info) => { n++; if (!b) fehler++; console.log((b ? '✅ ' : '❌ ') + name + (b || info === undefined ? '' : '   → ' + JSON.stringify(info))); };

// Testdaten: eine SumUp-Bestellung am 03.01., eine Sammelrechnung vom 02.01., bezahlt am 04.01.
const ms = Date.parse('2027-01-03T11:00:00.000Z');
setze('orders', 'o:GNC-' + ms, { status: 'completed', quelle: 'online', completedAt: '2027-01-03T11:00:00.000Z',
  order: { reference: 'GNC-' + ms, payment: 'sumup', items: [{ qty: 1, vatSplit: { 7: 8, 19: 0 } }], subtotal: 8, discount: 0, dealDiscount: 0, loyaltyDiscount: 0, deliveryFee: 0, tip: 0, total: 8 } });
setze('orders', 'o:GNC-1600000000000', { status: 'completed', quelle: 'online', completedAt: '2020-09-13T12:26:40.000Z', order: { payment: 'sumup', total: 99 } });
setze('invoices', 'counter:2027', { n: 1 });
setze('invoices', 'inv:GNC-2027-0001', { invoiceNo: 'GNC-2027-0001', mode: 'sammel', createdAt: '2027-01-02T08:00:00.000Z', company: 'Muster GmbH', vat: [{ satz: 7, brutto: 107 }] });
setze('firmen', 'rechnung:f1:2026-12', { invoiceNo: 'GNC-2027-0001', status: 'bezahlt', bezahltAm: '2027-01-04T09:00:00.000Z' });

(async () => {
  let r = await lauf({ jetzt: new Date('2027-01-06T00:30:00.000Z') });   // 01:30 Uhr Berlin
  ok('Erste Nacht: alles gesendet und gebucht', r.status === 'fertig' && r.fehler === null, r);
  ok('… Reihenfolge: Rechnung, Zahlung, Tag', JSON.stringify(ANFRAGEN[0]) === JSON.stringify(['rechnung:GNC-2027-0001', 'zahlung:GNC-2027-0001', 'tag:2027-01-03:online']), ANFRAGEN[0]);
  ok('… alte Bestellung außerhalb des Fensters nicht gelesen', !ANFRAGEN[0].some((s) => s.includes('2020')));
  ok('… Lauf als fertig vermerkt, Rechnung als gesendet, Tag nicht', !!lies('office-lauf', 'fertig:2027-01-06') && !!lies('office-lauf', 'gesendet:rechnung:GNC-2027-0001')
    && !lies('office-lauf', 'gesendet:tag:2027-01-03:online'));
  ok('… keine Telegram-Nachricht, wenn alles stimmt', TELEGRAM.length === 0, TELEGRAM);

  r = await lauf({ jetzt: new Date('2027-01-06T01:30:00.000Z') });
  ok('Zweiter Lauf derselben Nacht macht nichts', r.status === 'schon_fertig' && ANFRAGEN.length === 1, r);

  r = await lauf({ jetzt: new Date('2027-01-06T23:10:00.000Z') });   // 00:10 Uhr Berlin
  ok('Vor 01:00 Uhr Berlin passiert nichts', r.status === 'zu_frueh', r);

  r = await lauf({ jetzt: new Date('2027-01-07T00:30:00.000Z') });
  ok('Nächste Nacht: nur die Tagesmeldung noch einmal (Abgleich), sie ist doppelt', JSON.stringify(ANFRAGEN[1]) === JSON.stringify(['tag:2027-01-03:online']) && r.ergebnisse[0].status === 'doppelt', { a: ANFRAGEN[1], r });

  // Am Truck wird nachträglich ein Gutschein für den 03.01. eingetragen: die Tagesmeldung weicht ab
  setze('vouchers', 'c:GNCTRUCK1', { code: 'GNCTRUCK1', giftcard: true, value: 25, redeemedVia: 'truck', manualRedeemedAt: '2027-01-03T15:00:00.000Z', truckBestellwert: 30 });
  r = await lauf({ jetzt: new Date('2027-01-08T00:30:00.000Z') });
  ok('Abweichung landet als Telegram bei Kubi', r.ergebnisse.some((e) => e.status === 'abweichend') && TELEGRAM.length === 1 && /03\.01\.2027/.test(TELEGRAM[0]) && /weicht ab/i.test(TELEGRAM[0]), TELEGRAM);

  OFFICE.delete('tag:2027-01-03:online');   // Kubi hat im Office die neue Fassung übernommen

  officeKaputt = true;
  for (const stunde of ['00:20', '01:20', '02:20']) r = await lauf({ jetzt: new Date(`2027-01-09T${stunde}:00.000Z`) });
  ok('Office nicht erreichbar: kein fertig, eine Nachricht nach dem dritten Versuch', r.status === 'fehler' && !lies('office-lauf', 'fertig:2027-01-09')
    && TELEGRAM.length === 2 && /nicht erreichbar/.test(TELEGRAM[1]), { r, TELEGRAM });
  r = await lauf({ jetzt: new Date('2027-01-09T03:20:00.000Z') });
  ok('… vierter Versuch schickt keine weitere Nachricht', TELEGRAM.length === 2);
  officeKaputt = false;
  r = await lauf({ jetzt: new Date('2027-01-09T04:20:00.000Z') });
  ok('… sobald das Office wieder da ist, läuft die Nacht durch', r.status === 'fertig' && !!lies('office-lauf', 'fertig:2027-01-09'), r);
  ok('… aktuelle Nachtsicherung: keine zusätzliche Nachricht', TELEGRAM.length === 2, TELEGRAM);

  // Hinweis ohne Tag (kaputtes Datum): genau einmal an Kubi
  const ms2 = Date.parse('2027-01-04T11:00:00.000Z');
  setze('orders', 'o:GNC-' + ms2, { status: 'completed', quelle: 'online', completedAt: 'kaputt', order: { reference: 'GNC-' + ms2, payment: 'sumup', total: 8 } });
  sicherung = '2027-01-09';
  r = await lauf({ jetzt: new Date('2027-01-10T00:30:00.000Z') });
  ok('Hinweis ohne Tag geht einmal raus', TELEGRAM.length === 3 && /unlesbar/.test(TELEGRAM[2]) && Object.keys(Object.fromEntries(DATEN)).some((k) => k.startsWith('office-lauf|hinweis:')), TELEGRAM);
  r = await lauf({ jetzt: new Date('2027-01-11T00:30:00.000Z') });
  ok('… und in der nächsten Nacht nicht noch einmal', r.status === 'fertig' && TELEGRAM.length === 3, TELEGRAM);

  // Nachtsicherung im Office zu alt oder nie gelaufen
  sicherung = '2027-01-05';
  r = await lauf({ jetzt: new Date('2027-01-12T00:30:00.000Z') });
  ok('Alte Nachtsicherung: genau eine Nachricht mit Datum', TELEGRAM.length === 4 && /Nachtsicherung im Office ist vom 05\.01\.2027/.test(TELEGRAM[3]) && /Pasquale/.test(TELEGRAM[3]), TELEGRAM);
  sicherung = null;
  r = await lauf({ jetzt: new Date('2027-01-13T00:30:00.000Z') });
  ok('Noch nie gesichert: eigener Satz', TELEGRAM.length === 5 && /noch keine Nachtsicherung/.test(TELEGRAM[4]), TELEGRAM);
  sicherung = 'fehlt';
  r = await lauf({ jetzt: new Date('2027-01-14T00:30:00.000Z') });
  ok('Antwort ohne Feld sicherung: nichts gemeldet', r.status === 'fertig' && TELEGRAM.length === 5, TELEGRAM);

  console.log('\n' + (fehler ? '❌ ' + fehler + ' von ' + n + ' Prüfungen fehlgeschlagen' : '✅ Alle ' + n + ' Prüfungen grün'));
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.log('Absturz:', e && e.stack); process.exit(1); });
