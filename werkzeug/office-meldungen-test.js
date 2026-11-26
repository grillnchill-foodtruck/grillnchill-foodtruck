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
const GELESEN = new Map();   // Store -> Zahl der get-Aufrufe
const GELESEN_KEYS = new Set();   // 'store|key' aller get-Aufrufe
let listeWirft = false;
const store = (name) => ({
  async get(k, o) { GELESEN.set(name, (GELESEN.get(name) || 0) + 1); GELESEN_KEYS.add(name + '|' + k); const v = DATEN.get(name + '|' + k); return v === undefined ? null : (o && o.type === 'json' ? JSON.parse(v) : v); },
  async setJSON(k, v, o) { const key = name + '|' + k; if (o && o.onlyIfNew && DATEN.has(key)) return { modified: false }; DATEN.set(key, JSON.stringify(v)); return { modified: true }; },
  async delete(k) { DATEN.delete(name + '|' + k); },
  async list({ prefix } = {}) { if (listeWirft && name === 'orders') throw new Error('Blob-Store nicht erreichbar'); return { blobs: [...DATEN.keys()].filter((k) => k.startsWith(name + '|' + (prefix || ''))).map((k) => ({ key: k.slice(name.length + 1) })) }; },
});
const orig = Module._load;
Module._load = function (r, ...a) { if (r === '@netlify/blobs') return { getStore: (o) => store(typeof o === 'string' ? o : o.name) }; return orig.call(this, r, ...a); };
const G = 'office-eingang-testgeheimnis-0123456789';
Object.assign(process.env, { OFFICE_EINGANG_SECRET: G, OFFICE_URL: 'https://office.test', TELEGRAM_BOT_TOKEN: 'tg', TELEGRAM_CHAT_ID: '1' });
delete process.env.NETLIFY_BLOBS_SITE_ID;

const setze = (s, k, v) => DATEN.set(s + '|' + k, JSON.stringify(v));
const schluessel = (praefix) => [...DATEN.keys()].filter((k) => k.startsWith('office-lauf|' + praefix)).map((k) => k.slice(12));
const lies = (s, k) => { const v = DATEN.get(s + '|' + k); return v === undefined ? null : JSON.parse(v); };

// Office-Ersatz: prüft die Signatur und merkt sich Fassungen wie das echte Office
const OFFICE = new Map();
const ANFRAGEN = [];
const TELEGRAM = [];
let officeKaputt = false;
let verzoegerung = 0;          // Antwortzeit des Office-Ersatzes in ms
let ausfallNachPaketen = null; // nach so vielen Paketen antwortet das Office mit 500
let pakete = 0;
const fehlerSchluessel = new Map();   // Meldungsschlüssel -> Fehlertext des Office-Ersatzes
let sicherung = '2027-01-07';   // Tag der neuesten Nachtsicherung im Office-Ersatz, 'fehlt' lässt das Feld weg
global.fetch = async (url, opt = {}) => {
  if (url.startsWith('https://office.test/api/eingang')) {
    if (officeKaputt) throw new Error('getaddrinfo ENOTFOUND office.test');
    if (verzoegerung) await new Promise((r) => setTimeout(r, verzoegerung));
    if (ausfallNachPaketen !== null && pakete++ >= ausfallNachPaketen) return new Response('{}', { status: 500 });
    const sig = crypto.createHmac('sha256', G).update(opt.headers['x-gnc-zeit'] + '.' + opt.body).digest('base64url');
    if (sig !== opt.headers['x-gnc-signatur']) return new Response(JSON.stringify({ fehler: 'signatur' }), { status: 401 });
    const d = JSON.parse(opt.body);
    ANFRAGEN.push(d.meldungen.map((m) => m.schluessel));
    const ergebnisse = d.meldungen.map((m) => {
      if (fehlerSchluessel.has(m.schluessel)) return { schluessel: m.schluessel, status: 'fehler', fehler: fehlerSchluessel.get(m.schluessel) };
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
  ok('… Lauf als fertig vermerkt, Rechnung als gesendet, Tag nicht', !!lies('office-lauf', 'fertig:2027-01-06') && !!lies('office-lauf', 'gesendet:2027-01-06:rechnung:GNC-2027-0001')
    && !lies('office-lauf', 'gesendet:2027-01-06:tag:2027-01-03:online') && !lies('office-lauf', 'gesendet:tag:2027-01-03:online'));
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

  // ===== Review-Fixes =====
  const msVon = (iso) => Date.parse(iso);
  const bestellung = (iso, extra = {}, orderExtra = {}) => {
    const ref = 'GNC-' + msVon(iso);
    setze('orders', 'o:' + ref, { status: 'completed', quelle: 'online', completedAt: iso,
      order: { reference: ref, payment: 'sumup', items: [{ qty: 1, vatSplit: { 7: 8, 19: 0 } }], subtotal: 8, discount: 0, dealDiscount: 0, loyaltyDiscount: 0, deliveryFee: 0, tip: 0, total: 8, ...orderExtra }, ...extra });
    return ref;
  };
  const textMit = (re) => TELEGRAM.filter((t) => re.test(t)).length;
  sicherung = '2027-02-01';

  // Fenster für den Lauf am 02.02.: 19.01. bis 01.02.
  for (const t of ['20', '21', '22', '23', '24', '26']) bestellung(`2027-01-${t}T11:00:00.000Z`);
  const refOhneKorb25 = bestellung('2027-01-25T11:00:00.000Z', {}, { items: undefined, subtotal: undefined });
  const refOhneKorbBis = bestellung('2027-02-01T11:00:00.000Z', {}, { items: undefined, subtotal: undefined });
  OFFICE.set('tag:2027-01-20:online', 'Fassung, die das Office schon hatte');   // weicht ab
  setze('invoices', 'counter:2027', { n: 3 });
  setze('invoices', 'inv:GNC-2027-0002', { invoiceNo: 'GNC-2027-0002', mode: 'sammel', createdAt: '2027-02-01T08:00:00.000Z', vat: [{ satz: 7, brutto: 50 }] });   // ohne Kunde, Tag = bis
  setze('invoices', 'inv:GNC-2027-0003', { invoiceNo: 'GNC-2027-0003', mode: 'sammel', createdAt: '2027-01-25T08:00:00.000Z', vat: [{ satz: 7, brutto: 50 }] });   // ohne Kunde, Tag ≠ bis

  // Paket 1 bringt "abweichend", Paket 2 scheitert an der Frist
  const tg0 = TELEGRAM.length;
  verzoegerung = 450;
  r = await lauf({ jetzt: new Date('2027-02-02T00:30:00.000Z'), budgetMs: 400 });
  verzoegerung = 0;
  ok('Frist: Paket 1 durch, Paket 2 an der Frist gescheitert', r.status === 'fehler' && r.fehler === 'frist' && r.ergebnisse.length === 5
    && r.ergebnisse.some((e) => e.status === 'abweichend'), r);
  ok('… keine Telegram-Nachricht zur Abweichung im Fehlerlauf, kein fertig', TELEGRAM.length === tg0 && !lies('office-lauf', 'fertig:2027-02-02'), TELEGRAM.slice(tg0));
  ok('… der Versuch ist gezählt', (lies('office-lauf', 'versuch:2027-02-02') || {}).n === 1);
  r = await lauf({ jetzt: new Date('2027-02-02T01:30:00.000Z') });
  ok('Nächster Lauf fertig: die Abweichung kommt genau einmal', r.status === 'fertig' && TELEGRAM.length === tg0 + 1 && /Weicht ab/.test(TELEGRAM[tg0]) && /20\.01\.2027/.test(TELEGRAM[tg0]), TELEGRAM.slice(tg0));
  ok('Hinweis mit Tag = bis geht raus, Hinweis mit Tag ≠ bis nicht', TELEGRAM[tg0].includes(refOhneKorbBis) && !TELEGRAM[tg0].includes(refOhneKorb25) && !TELEGRAM[tg0].includes('GNC-2027-0003'), TELEGRAM[tg0]);
  ok('Rechnung ohne Kunde ergibt einen Hinweis (nicht gemeldet)', /Rechnung GNC-2027-0002: ohne Kundenname/.test(TELEGRAM[tg0]) && !ANFRAGEN.flat().includes('rechnung:GNC-2027-0002'), TELEGRAM[tg0]);
  OFFICE.delete('tag:2027-01-20:online');   // Kubi hat die Fassung geprüft

  // Teilfehler über mehrere Pakete: Paket 1 gebucht und teils Fehler, Paket 2 scheitert mit 500
  setze('invoices', 'counter:2027', { n: 5 });
  for (const n of ['0004', '0005']) setze('invoices', 'inv:GNC-2027-' + n, { invoiceNo: 'GNC-2027-' + n, mode: 'sammel', createdAt: '2027-02-02T08:00:00.000Z', company: 'Muster GmbH', vat: [{ satz: 7, brutto: 107 }] });
  fehlerSchluessel.set('rechnung:GNC-2027-0004', 'kein_kunde');
  pakete = 0; ausfallNachPaketen = 1;
  const a0 = ANFRAGEN.length, tg1 = TELEGRAM.length;
  r = await lauf({ jetzt: new Date('2027-02-03T00:30:00.000Z') });
  ausfallNachPaketen = null;
  ok('Teilfehler: Lauf endet als Fehler, Paket 1 ausgewertet', r.status === 'fehler' && /office_500/.test(r.fehler) && r.ergebnisse.length === 5 && ANFRAGEN.length === a0 + 1, r);
  ok('… Paket 1 ist als gesendet vermerkt, Paket 2 nicht, kein fertig', !!lies('office-lauf', 'gesendet:2027-02-03:rechnung:GNC-2027-0004') && !!lies('office-lauf', 'gesendet:2027-02-03:rechnung:GNC-2027-0005')
    && schluessel('gesendet:2027-02-03:tag:').length === 0 && !lies('office-lauf', 'fertig:2027-02-03'));
  ok('… die Fehlerzeile wird gemeldet und gemerkt', TELEGRAM.length === tg1 + 1 && /Nicht gebucht: Rechnung GNC-2027-0004 \(kein_kunde\)/.test(TELEGRAM[tg1])
    && !!lies('office-lauf', 'fehler-gemeldet:2027-02-03:rechnung:GNC-2027-0004'), TELEGRAM.slice(tg1));
  fehlerSchluessel.clear();
  const a1 = ANFRAGEN.length;
  r = await lauf({ jetzt: new Date('2027-02-03T01:30:00.000Z') });
  ok('Teilfehler: nächster Lauf fertig, Rechnungen nicht noch einmal gesendet, Fehlerzeile nicht doppelt gemeldet',
    r.status === 'fertig' && !ANFRAGEN.slice(a1).flat().some((k) => k.startsWith('rechnung:')) && textMit(/GNC-2027-0004/) === 1, { r, TELEGRAM: TELEGRAM.slice(tg1) });

  // Abgebrochene Läufe zählen mit, Frist-Text, nur einmal melden
  const tg2 = TELEGRAM.length;
  listeWirft = true;
  for (const stunde of ['00:20', '01:20']) await lauf({ jetzt: new Date(`2027-02-04T${stunde}:00.000Z`) }).catch(() => null);
  listeWirft = false;
  ok('Abgebrochene Läufe (Absturz beim Sammeln) zählen als Versuch', (lies('office-lauf', 'versuch:2027-02-04') || {}).n === 2 && TELEGRAM.length === tg2);
  verzoegerung = 450;
  r = await lauf({ jetzt: new Date('2027-02-04T02:20:00.000Z'), budgetMs: 400 });
  ok('Dritter Versuch an der Frist: Nachricht "zu langsam", nicht "nicht erreichbar"', TELEGRAM.length === tg2 + 1 && /zu langsam geantwortet/.test(TELEGRAM[tg2]) && !/nicht erreichbar/.test(TELEGRAM[tg2]), TELEGRAM.slice(tg2));
  r = await lauf({ jetzt: new Date('2027-02-04T03:20:00.000Z'), budgetMs: 400 });
  verzoegerung = 0;
  ok('… vierter Versuch meldet nicht noch einmal', TELEGRAM.length === tg2 + 1);
  r = await lauf({ jetzt: new Date('2027-02-04T04:20:00.000Z') });
  ok('… danach läuft die Nacht durch', r.status === 'fertig');

  // Aufräumen am Monatsersten: neue Schlüssel nur über den Namen, alte Schlüssel weiter über den Inhalt
  const alt = { am: '2026-11-01T01:00:00.000Z' }, neu = { am: '2027-02-20T01:00:00.000Z' };
  setze('office-lauf', 'gesendet:rechnung:LEGACY-ALT', alt); setze('office-lauf', 'gesendet:rechnung:LEGACY-NEU', neu);
  setze('office-lauf', 'hinweis:legacyhash', alt);
  setze('office-lauf', 'gesendet:2026-11-01:rechnung:ALT', alt); setze('office-lauf', 'gesendet:2027-02-20:rechnung:NEU', neu);
  setze('office-lauf', 'hinweis:2026-11-01:h1', alt); setze('office-lauf', 'hinweis:2027-02-20:h2', neu);
  setze('office-lauf', 'fehler-gemeldet:2026-11-01:rechnung:ALT', alt); setze('office-lauf', 'sicherung:2026-11-01', alt);
  GELESEN_KEYS.clear();
  r = await lauf({ jetzt: new Date('2027-03-01T00:30:00.000Z') });
  const weg = (k) => lies('office-lauf', k) === null;
  ok('Aufräumen: alte Vermerke weg, junge bleiben (neues und altes Format)', r.status === 'fertig' && weg('gesendet:rechnung:LEGACY-ALT') && !weg('gesendet:rechnung:LEGACY-NEU') && weg('hinweis:legacyhash')
    && weg('gesendet:2026-11-01:rechnung:ALT') && !weg('gesendet:2027-02-20:rechnung:NEU') && weg('hinweis:2026-11-01:h1') && !weg('hinweis:2027-02-20:h2')
    && weg('fehler-gemeldet:2026-11-01:rechnung:ALT') && weg('sicherung:2026-11-01'));
  ok('… Schlüssel mit Datum werden dafür nicht gelesen', ![...GELESEN_KEYS].some((k) => /^office-lauf\|(gesendet|hinweis|fehler-gemeldet):\d{4}-/.test(k)), [...GELESEN_KEYS].filter((k) => k.startsWith('office-lauf')));

  // ===== Sammeln unter Last: Dauer und Lesezugriffe =====
  const { sammeln } = require(F + '/lib/office-sammeln.js');
  const { baueMeldungen } = require(F + '/lib/office-tag.js');
  const VON = '2027-04-01', BIS = '2027-04-14';
  const ab = Date.parse(VON + 'T00:00:00Z') - 10 * 86400000, bisMs = Date.parse(BIS + 'T00:00:00Z') + 2 * 86400000;
  let imFenster = 0;
  for (let i = 0; i < 2000; i++) {   // 2000 Bestellungen über 70 Tage
    const t = Date.parse('2027-02-20T00:00:00Z') + Math.floor(i * 70 * 86400000 / 2000);
    if (t >= ab && t <= bisMs) imFenster++;
    setze('orders', 'o:GNC-' + t, { status: 'completed', quelle: 'online', completedAt: new Date(t).toISOString(), order: { reference: 'GNC-' + t, payment: 'sumup', total: 8, items: [{ qty: 1, vatSplit: { 7: 8, 19: 0 } }], subtotal: 8 } });
  }
  for (let i = 0; i < 300; i++) setze('vouchers', 'c:V' + i, { code: 'V' + i, giftcard: true, value: 25, redeemedVia: i < 10 ? 'truck' : null,
    ...(i < 10 ? { manualRedeemedAt: i < 3 ? 'kaputt' : '2027-04-05T10:00:00.000Z' } : {}) });
  setze('invoices', 'counter:2027', { n: 200 });
  for (let n = 1; n <= 200; n++) setze('invoices', 'inv:GNC-2027-' + String(n).padStart(4, '0'), { invoiceNo: 'GNC-2027-' + String(n).padStart(4, '0'), mode: 'sammel', company: 'Firma ' + n,
    createdAt: n === 100 ? 'kaputt' : '2027-04-' + String(1 + (n % 14)).padStart(2, '0') + 'T08:00:00.000Z', vat: [{ satz: 7, brutto: 107 }] });
  for (let i = 0; i < 50; i++) setze('firmen', `rechnung:f${i}:${i < 40 ? '2027-03' : '2028-01'}`, { invoiceNo: 'GNC-2027-0001', status: 'bezahlt', bezahltAm: i === 0 ? 'kaputt' : '2027-04-07T09:00:00.000Z' });
  GELESEN.clear();
  const t0 = Date.now();
  const daten = await sammeln(VON, BIS);
  const dauer = Date.now() - t0;
  const gelesen = Object.fromEntries(GELESEN);
  const summe = [...GELESEN.values()].reduce((a, b) => a + b, 0);
  console.log(`   sammeln: ${dauer} ms, ${summe} Lesezugriffe`, JSON.stringify(gelesen));
  ok('Last: sammeln wirft bei kaputten Datumswerten nicht und braucht unter 5 Sekunden', dauer < 5000 && daten.bestellungen.length === imFenster, { dauer, n: daten.bestellungen.length, imFenster });
  ok('Last: Bestellungen nur im Zeitfenster gelesen', gelesen.orders === imFenster && imFenster < 2000, { gelesen: gelesen.orders, imFenster });
  ok('Last: Rechnungen im Fenster (200 plus Zähler plus 39 Zahlungen), Firmen nur Monate bis zum Fensterende', gelesen.invoices === 1 + 200 + 39 && gelesen.firmen === 41, gelesen);
  ok('Last: unlesbare Daten bleiben als Eintrag mit Tag null erhalten', daten.truck.filter((x) => x.tag === null).length === 3 && daten.firmenZahlungen.some((x) => x.tag === null));
  const gebaut = baueMeldungen({ von: VON, bis: BIS, ...daten });
  ok('Last: daraus entstehen Hinweise zu unlesbaren Daten, keine Ausnahme', gebaut.hinweise.some((h) => h.tag === null && /unlesbar/.test(h.text)), gebaut.hinweise.slice(0, 3));

  console.log('\n' + (fehler ? '❌ ' + fehler + ' von ' + n + ' Prüfungen fehlgeschlagen' : '✅ Alle ' + n + ' Prüfungen grün'));
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.log('Absturz:', e && e.stack); process.exit(1); });
