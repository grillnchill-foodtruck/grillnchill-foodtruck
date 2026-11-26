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
let listeWirft = null;           // Store, dessen list() wirft
const getWirft = new Set();      // 'store|key', deren get() wirft
let blobVerzoegerung = 0;        // ms je Blob-Aufruf (Messung: eine Welle paralleler Aufrufe dauert so lange)
const GLEICHZEITIG = new Map();  // Store -> höchste Zahl gleichzeitiger get-Aufrufe
const laufend = new Map();
let schreibenJetzt = 0, schreibenMax = 0;   // gleichzeitige setJSON auf gesendet:-Vermerke
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const store = (name) => ({
  async get(k, o) {
    GELESEN.set(name, (GELESEN.get(name) || 0) + 1); GELESEN_KEYS.add(name + '|' + k);
    laufend.set(name, (laufend.get(name) || 0) + 1);
    GLEICHZEITIG.set(name, Math.max(GLEICHZEITIG.get(name) || 0, laufend.get(name)));
    try {
      if (blobVerzoegerung) await warte(blobVerzoegerung);
      if (getWirft.has(name + '|' + k)) throw new Error('Blob nicht lesbar');
      const v = DATEN.get(name + '|' + k); return v === undefined ? null : (o && o.type === 'json' ? JSON.parse(v) : v);
    } finally { laufend.set(name, laufend.get(name) - 1); }
  },
  async setJSON(k, v, o) {
    if (name === 'office-lauf' && k.startsWith('gesendet:')) {
      schreibenJetzt++; schreibenMax = Math.max(schreibenMax, schreibenJetzt);
      await new Promise((r) => setImmediate(r));
      schreibenJetzt--;
    }
    const key = name + '|' + k; if (o && o.onlyIfNew && DATEN.has(key)) return { modified: false }; DATEN.set(key, JSON.stringify(v)); return { modified: true };
  },
  async delete(k) { DATEN.delete(name + '|' + k); },
  async list({ prefix } = {}) {
    if (blobVerzoegerung) await warte(blobVerzoegerung);
    if (listeWirft === name) throw new Error('Blob-Store nicht erreichbar');
    return { blobs: [...DATEN.keys()].filter((k) => k.startsWith(name + '|' + (prefix || ''))).map((k) => ({ key: k.slice(name.length + 1) })) };
  },
});
const orig = Module._load;
Module._load = function (r, ...a) { if (r === '@netlify/blobs') return { getStore: (o) => store(typeof o === 'string' ? o : o.name) }; return orig.call(this, r, ...a); };
const G = 'office-eingang-testgeheimnis-0123456789';
Object.assign(process.env, { OFFICE_EINGANG_SECRET: G, OFFICE_URL: 'https://office.test', TELEGRAM_BOT_TOKEN: 'tg', TELEGRAM_CHAT_ID: '1' });
delete process.env.NETLIFY_BLOBS_SITE_ID;

const setze = (s, k, v) => DATEN.set(s + '|' + k, JSON.stringify(v));
const schluessel = (praefix) => [...DATEN.keys()].filter((k) => k.startsWith('office-lauf|' + praefix)).map((k) => k.slice(12));
const lies = (s, k) => { const v = DATEN.get(s + '|' + k); return v === undefined ? null : JSON.parse(v); };

// Office-Ersatz wie functions/_lib/eingang.js: Jede Fassung bleibt gespeichert. Dieselbe Fassung noch einmal ergibt
// 'doppelt' mit ihrem Zustand, eine neue Fassung neben einer gültigen 'abweichend'. Eine an der Prüfung gescheiterte
// Fassung (Fehler ungueltig_…) ersetzt die nächste. offen zählt alle Fassungen mit Fehler oder Abweichung.
const OFFICE = new Map();   // Schlüssel -> [{ inhalt, status, fehler }]
const ANFRAGEN = [];        // je Anfrage die Schlüssel
const KOERPER = [];         // je Anfrage die Meldungen
const TELEGRAM = [];
let officeKaputt = false;
let telegramKaputt = false;
let verzoegerung = 0;          // Antwortzeit des Office-Ersatzes in ms
let ausfallNachPaketen = null; // nach so vielen Paketen antwortet das Office mit 500
let pakete = 0;
const fehlerSchluessel = new Map();   // Meldungsschlüssel -> Fehlertext oder (daten) => Fehlertext | null
let sicherung = '2027-01-07';   // Tag der neuesten Nachtsicherung im Office-Ersatz, 'fehlt' lässt das Feld weg
const ersetzbar = (f) => ['fehler', 'erledigt'].includes(f.status) && /^ungueltig/.test(f.fehler || '');
function annehmen(m) {
  const inhalt = JSON.stringify(m.daten);
  const fassungen = OFFICE.get(m.schluessel) || [];
  OFFICE.set(m.schluessel, fassungen);
  const gleich = fassungen.find((f) => f.inhalt === inhalt);
  if (gleich) return { schluessel: m.schluessel, status: 'doppelt', zustand: gleich.status };
  if (fassungen.some((f) => !ersetzbar(f))) { fassungen.push({ inhalt, status: 'abweichend', fehler: null }); return { schluessel: m.schluessel, status: 'abweichend' }; }
  for (const f of fassungen) if (f.status === 'fehler') f.status = 'erledigt';
  const regel = fehlerSchluessel.get(m.schluessel);
  const fehler = (typeof regel === 'function' ? regel(m.daten) : regel) || null;
  fassungen.push({ inhalt, status: fehler ? 'fehler' : 'gebucht', fehler });
  return fehler ? { schluessel: m.schluessel, status: 'fehler', fehler } : { schluessel: m.schluessel, status: 'gebucht' };
}
// Kubi erledigt im Office alles Offene zu einem Schlüssel
const erledigen = (schluessel) => { for (const f of OFFICE.get(schluessel) || []) if (['fehler', 'abweichend'].includes(f.status)) f.status = 'erledigt'; };
// Das Office hat schon eine andere, gebuchte Fassung
const vorbelegen = (schluessel) => OFFICE.set(schluessel, [{ inhalt: '"ältere Fassung"', status: 'gebucht', fehler: null }]);
const offenImOffice = () => [...OFFICE.values()].flat().filter((f) => ['fehler', 'abweichend'].includes(f.status)).length;
global.fetch = async (url, opt = {}) => {
  if (url.startsWith('https://office.test/api/eingang')) {
    if (officeKaputt) throw new Error('getaddrinfo ENOTFOUND office.test');
    if (verzoegerung) await warte(verzoegerung);
    if (ausfallNachPaketen !== null && pakete++ >= ausfallNachPaketen) return new Response('{}', { status: 500 });
    const sig = crypto.createHmac('sha256', G).update(opt.headers['x-gnc-zeit'] + '.' + opt.body).digest('base64url');
    if (sig !== opt.headers['x-gnc-signatur']) return new Response(JSON.stringify({ fehler: 'signatur' }), { status: 401 });
    const d = JSON.parse(opt.body);
    if (!d || d.v !== 1 || !Array.isArray(d.meldungen) || d.meldungen.length > 5) return new Response(JSON.stringify({ fehler: 'format' }), { status: 400 });
    ANFRAGEN.push(d.meldungen.map((m) => m.schluessel));
    KOERPER.push(d.meldungen);
    const ergebnisse = d.meldungen.map(annehmen);
    const antwort = { ergebnisse, offen: offenImOffice() };
    if (sicherung !== 'fehlt') antwort.sicherung = sicherung;
    return new Response(JSON.stringify(antwort), { status: 200 });
  }
  if (url.startsWith('https://api.telegram.org/')) {
    if (telegramKaputt) return new Response('{"ok":false}', { status: 502 });
    TELEGRAM.push(JSON.parse(opt.body).text); return new Response('{"ok":true}', { status: 200 });
  }
  throw new Error('unerwartet: ' + url);
};

// Log-Zeilen des Laufs abfangen, alles andere durchreichen
const LOGS = [];
const logOrig = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('{"lauf":"office-meldungen"')) LOGS.push(JSON.parse(a[0])); else logOrig(...a); };

const F = path.join(__dirname, '..', 'netlify', 'functions');
const { lauf, nachricht } = require(F + '/office-meldungen.js');

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
  ok('… Lauf als fertig vermerkt, Rechnung und Tag als gesendet (für leer gewordene Tage)', !!lies('office-lauf', 'fertig:2027-01-06') && !!lies('office-lauf', 'gesendet:2027-01-06:rechnung:GNC-2027-0001')
    && !!lies('office-lauf', 'gesendet:2027-01-06:tag:2027-01-03:online'));
  ok('… gesendet-Vermerke parallel geschrieben', schreibenMax >= 3, schreibenMax);
  ok('… keine Telegram-Nachricht, wenn alles stimmt', TELEGRAM.length === 0, TELEGRAM);
  const log0 = LOGS[0] || {};
  ok('… eine Log-Zeile mit Messwerten', LOGS.length === 1 && log0.status === 'fertig' && Number.isFinite(log0.sammeln_ms) && Number.isFinite(log0.senden_ms)
    && log0.lesezugriffe > 0 && log0.meldungen === 3 && log0.pakete === 1 && log0.lesefehler === 0, LOGS);
  ok('… ohne Kundendaten', !/Muster|GmbH/.test(JSON.stringify(LOGS)), LOGS);

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

  erledigen('tag:2027-01-03:online');   // Kubi hat die neue Fassung im Office geprüft und erledigt

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
  vorbelegen('tag:2027-01-20:online');   // das Office hat schon eine andere Fassung: weicht ab
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
  ok('… die Abweichung kommt schon im Fehlerlauf zu Kubi (das Office hat die Fassung gespeichert), kein fertig', TELEGRAM.length === tg0 + 1 && /Weicht ab/.test(TELEGRAM[tg0])
    && /20\.01\.2027/.test(TELEGRAM[tg0]) && !lies('office-lauf', 'fertig:2027-02-02'), TELEGRAM.slice(tg0));
  ok('… vermerkt als abweichung-gemeldet', schluessel('abweichung-gemeldet:2027-02-02:tag:2027-01-20:online:').length === 1, schluessel('abweichung-gemeldet:'));
  ok('… der Versuch ist gezählt', (lies('office-lauf', 'versuch:2027-02-02') || {}).n === 1);
  r = await lauf({ jetzt: new Date('2027-02-02T01:30:00.000Z') });
  ok('Nächster Lauf fertig: das Office antwortet doppelt mit Zustand abweichend, keine zweite Nachricht dazu', r.status === 'fertig'
    && r.ergebnisse.some((e) => e.schluessel === 'tag:2027-01-20:online' && e.status === 'doppelt' && e.zustand === 'abweichend')
    && TELEGRAM.length === tg0 + 2 && !/Weicht ab/.test(TELEGRAM[tg0 + 1]), TELEGRAM.slice(tg0));
  ok('Hinweis mit Tag = bis geht raus, Hinweis mit Tag ≠ bis nicht', TELEGRAM[tg0 + 1].includes(refOhneKorbBis) && !TELEGRAM[tg0 + 1].includes(refOhneKorb25) && !TELEGRAM[tg0 + 1].includes('GNC-2027-0003'), TELEGRAM[tg0 + 1]);
  ok('Rechnung ohne Kunde ergibt einen Hinweis (nicht gemeldet)', /Rechnung GNC-2027-0002: ohne Kundenname/.test(TELEGRAM[tg0 + 1]) && !ANFRAGEN.flat().includes('rechnung:GNC-2027-0002'), TELEGRAM[tg0 + 1]);
  erledigen('tag:2027-01-20:online');   // Kubi hat die Fassung geprüft

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
    && schluessel('fehler-gemeldet:2027-02-03:rechnung:GNC-2027-0004:').length === 1, TELEGRAM.slice(tg1));
  fehlerSchluessel.clear();
  const a1 = ANFRAGEN.length;
  r = await lauf({ jetzt: new Date('2027-02-03T01:30:00.000Z') });
  ok('Teilfehler: nächster Lauf fertig, Rechnungen nicht noch einmal gesendet, Fehlerzeile nicht doppelt gemeldet',
    r.status === 'fertig' && !ANFRAGEN.slice(a1).flat().some((k) => k.startsWith('rechnung:')) && textMit(/GNC-2027-0004/) === 1, { r, TELEGRAM: TELEGRAM.slice(tg1) });
  erledigen('rechnung:GNC-2027-0004');

  // Abgebrochene Läufe zählen mit, Frist-Text, nur einmal melden
  const tg2 = TELEGRAM.length;
  listeWirft = 'office-lauf';   // Absturz mitten im Lauf
  for (const stunde of ['00:20', '01:20']) await lauf({ jetzt: new Date(`2027-02-04T${stunde}:00.000Z`) }).catch(() => null);
  listeWirft = null;
  ok('Abgebrochene Läufe zählen als Versuch', (lies('office-lauf', 'versuch:2027-02-04') || {}).n === 2 && TELEGRAM.length === tg2);
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
  setze('office-lauf', 'abweichung-gemeldet:2026-11-01:tag:2026-10-20:online:abc', alt); setze('office-lauf', 'abweichung-gemeldet:2027-02-20:tag:2027-02-10:online:def', neu);
  GELESEN_KEYS.clear();
  r = await lauf({ jetzt: new Date('2027-03-01T00:30:00.000Z') });
  const weg = (k) => lies('office-lauf', k) === null;
  ok('Aufräumen: alte Vermerke weg, junge bleiben (neues und altes Format)', r.status === 'fertig' && weg('gesendet:rechnung:LEGACY-ALT') && !weg('gesendet:rechnung:LEGACY-NEU') && weg('hinweis:legacyhash')
    && weg('gesendet:2026-11-01:rechnung:ALT') && !weg('gesendet:2027-02-20:rechnung:NEU') && weg('hinweis:2026-11-01:h1') && !weg('hinweis:2027-02-20:h2')
    && weg('fehler-gemeldet:2026-11-01:rechnung:ALT') && weg('sicherung:2026-11-01')
    && weg('abweichung-gemeldet:2026-11-01:tag:2026-10-20:online:abc') && !weg('abweichung-gemeldet:2027-02-20:tag:2027-02-10:online:def'));
  ok('… Schlüssel mit Datum werden dafür nicht gelesen', ![...GELESEN_KEYS].some((k) => /^office-lauf\|(gesendet|hinweis|fehler-gemeldet|abweichung-gemeldet):\d{4}-/.test(k)), [...GELESEN_KEYS].filter((k) => k.startsWith('office-lauf')));

  // ===== Schluss-Review =====
  sicherung = '2027-12-31';   // aktuelle Nachtsicherung: keine Nachricht dazu
  const nacht = (tag, stunde = '00:20') => lauf({ jetzt: new Date(`${tag}T${stunde}:00.000Z`) });
  const neueTexte = (ab) => TELEGRAM.slice(ab).join('\n---\n');

  // 1. Stiller Ausfall: Drei Läufe brechen ab (zum Beispiel Netlify nach 30 Sekunden). Der vierte meldet das sofort beim Start.
  let tg = TELEGRAM.length;
  listeWirft = 'office-lauf';
  for (const stunde of ['00:20', '01:20', '02:20']) await nacht('2027-03-02', stunde).catch(() => null);
  ok('Abbruch: drei abgebrochene Läufe, noch keine Nachricht', (lies('office-lauf', 'versuch:2027-03-02') || {}).n === 3 && TELEGRAM.length === tg, TELEGRAM.slice(tg));
  await nacht('2027-03-02', '03:20').catch(() => null);
  ok('… der vierte Lauf meldet beim Start "3-mal abgebrochen", auch wenn er selbst wieder abbricht', TELEGRAM.length === tg + 1
    && /Die Office-Meldungen sind heute Nacht 3-mal abgebrochen\. Der Shop versucht es stündlich weiter\./.test(TELEGRAM[tg]) && (lies('office-lauf', 'versuch:2027-03-02') || {}).gemeldet === true, TELEGRAM.slice(tg));
  await nacht('2027-03-02', '04:20').catch(() => null);
  ok('… und nur einmal', TELEGRAM.length === tg + 1);
  listeWirft = null;
  r = await nacht('2027-03-02', '05:20');
  ok('… danach läuft die Nacht durch', r.status === 'fertig' && TELEGRAM.length === tg + 1, { r, t: TELEGRAM.slice(tg) });

  // 2. Geheimnis fehlt: Lauf endet sofort, ohne Shop-Daten zu lesen
  tg = TELEGRAM.length;
  let a = ANFRAGEN.length;
  const geheim = process.env.OFFICE_EINGANG_SECRET;
  delete process.env.OFFICE_EINGANG_SECRET;
  GELESEN.clear();
  LOGS.length = 0;
  for (const stunde of ['00:20', '01:20', '02:20']) r = await nacht('2027-03-03', stunde);
  ok('Geheimnis fehlt: nicht_eingerichtet, keine Anfrage ans Office', r.status === 'fehler' && r.fehler === 'nicht_eingerichtet' && ANFRAGEN.length === a, r);
  ok('… keine Bestellung, kein Gutschein, keine Rechnung gelesen', !['orders', 'vouchers', 'invoices', 'firmen', 'office-ereignisse'].some((x) => GELESEN.has(x)), Object.fromEntries(GELESEN));
  ok('… nach dem dritten Versuch: "Das gemeinsame Geheimnis fehlt im Shop."', TELEGRAM.length === tg + 1 && /3-mal gescheitert/.test(TELEGRAM[tg]) && /Das gemeinsame Geheimnis fehlt im Shop\./.test(TELEGRAM[tg]), TELEGRAM.slice(tg));
  ok('… Log-Zeile mit Status und Grund', LOGS.length === 3 && LOGS[2].status === 'fehler' && LOGS[2].fehler === 'nicht_eingerichtet' && LOGS[2].lesezugriffe === 0 && LOGS[2].pakete === 0, LOGS);
  process.env.OFFICE_EINGANG_SECRET = geheim;
  r = await nacht('2027-03-03', '03:20');
  ok('… mit Geheimnis läuft die Nacht durch', r.status === 'fertig', r);

  // 4. Lesefehler bei Bestellungen: fail-closed, nichts gesendet, zählt als Versuch
  const ref303 = bestellung('2027-03-03T11:00:00.000Z');
  getWirft.add('orders|o:' + ref303);
  tg = TELEGRAM.length; a = ANFRAGEN.length;
  for (const stunde of ['00:20', '01:20', '02:20']) r = await nacht('2027-03-04', stunde);
  ok('Lesefehler: Lauf endet mit lesefehler und sendet nichts', r.status === 'fehler' && r.fehler === 'lesefehler' && r.lesefehler === 1 && ANFRAGEN.length === a && !lies('office-lauf', 'fertig:2027-03-04'), r);
  ok('… nach dem dritten Versuch bei Kubi', TELEGRAM.length === tg + 1 && /einen Datensatz nicht lesen/.test(TELEGRAM[tg]), TELEGRAM.slice(tg));
  getWirft.clear();
  r = await nacht('2027-03-04', '03:20');
  ok('… wieder lesbar: die Bestellung geht raus', r.status === 'fertig' && ANFRAGEN.slice(a).flat().includes('tag:2027-03-03:online'), ANFRAGEN.slice(a));

  // 3. Abweichung, deren Nachricht nicht durchging: Beim nächsten Senden antwortet das Office doppelt (Zustand abweichend), dann einmal melden
  setze('vouchers', 'c:GNCP3B77', { code: 'GNCP3B77', giftcard: true, value: 10, redeemedVia: 'truck', manualRedeemedAt: '2027-03-03T15:00:00.000Z', truckBestellwert: 12 });
  tg = TELEGRAM.length;
  telegramKaputt = true;
  r = await nacht('2027-03-05');
  telegramKaputt = false;
  ok('Abweichung, Telegram fällt aus: nichts vermerkt', r.status === 'fertig' && r.ergebnisse.some((e) => e.status === 'abweichend') && schluessel('abweichung-gemeldet:2027-03-05:').length === 0, r.ergebnisse);
  r = await nacht('2027-03-06');
  ok('… nächste Nacht: doppelt mit Zustand abweichend wird gemeldet', TELEGRAM.length === tg + 1 && /Weicht ab/.test(TELEGRAM[tg]) && /03\.03\.2027/.test(TELEGRAM[tg])
    && r.ergebnisse.some((e) => e.status === 'doppelt' && e.zustand === 'abweichend'), { t: TELEGRAM.slice(tg), e: r.ergebnisse });
  r = await nacht('2027-03-07');
  ok('… und danach nicht noch einmal', textMit(/Weicht ab.*03\.03\.2027/) === 1 && /wartet noch auf deinen Blick/.test(TELEGRAM[TELEGRAM.length - 1]), TELEGRAM.slice(tg));
  erledigen('tag:2027-03-03:online');

  // 15. Stichtag start im Store office-lauf
  tg = TELEGRAM.length; a = ANFRAGEN.length;
  DATEN.set('office-lauf|start', '2027-03-04');   // so schreibt es netlify blobs:set
  r = await nacht('2027-03-08');
  ok('Stichtag: Tage davor gehen nicht mehr raus, ein leeres Paket als Lebenszeichen', r.status === 'fertig' && ANFRAGEN.length === a + 1 && ANFRAGEN[a].length === 0, ANFRAGEN.slice(a));
  DATEN.set('office-lauf|start', 'ab Januar');
  r = await nacht('2027-03-09');
  ok('Ungültiger Stichtag: nichts gesendet, Fehler start_ungueltig', r.status === 'fehler' && r.fehler === 'start_ungueltig' && ANFRAGEN.length === a + 1, r);
  setze('office-lauf', 'start', '2027-04-01');   // auch als JSON-Text lesbar
  sicherung = '2027-03-01';
  GELESEN.clear();
  r = await nacht('2027-03-09', '01:20');
  ok('Stichtag nach dem Fenster: keine Bestellung gelesen, ein leeres Paket', r.status === 'fertig' && !GELESEN.has('orders') && ANFRAGEN.length === a + 2 && ANFRAGEN[a + 1].length === 0, { r, g: Object.fromEntries(GELESEN) });
  ok('… das Lebenszeichen bringt den Stand der Nachtsicherung', TELEGRAM.length === tg + 1 && /Nachtsicherung im Office ist vom 01\.03\.2027/.test(TELEGRAM[tg]), TELEGRAM.slice(tg));
  DATEN.delete('office-lauf|start');
  sicherung = '2027-12-31';

  // 10. Ein Tag, für den schon gemeldet wurde, hat keine Posten mehr: Tagesmeldung mit posten []
  DATEN.delete('orders|o:' + ref303);
  DATEN.delete('vouchers|c:GNCP3B77');
  tg = TELEGRAM.length; a = ANFRAGEN.length;
  r = await nacht('2027-03-11');
  const leerGesendet = KOERPER.slice(a).flat().find((m) => m.schluessel === 'tag:2027-03-03:online');
  ok('Leer gewordener Tag: Tagesmeldung mit posten [] geht raus', r.status === 'fertig' && leerGesendet && leerGesendet.art === 'tag'
    && JSON.stringify(leerGesendet.daten) === JSON.stringify({ datum: '2027-03-03', posten: [] }), KOERPER.slice(a));
  ok('… das Office legt sie als abweichend ab, Kubi bekommt eine Nachricht', TELEGRAM.length === tg + 1 && /Weicht ab/.test(TELEGRAM[tg]) && /03\.03\.2027/.test(TELEGRAM[tg]), TELEGRAM.slice(tg));
  erledigen('tag:2027-03-03:online');

  // 9. Abgelehnte Fassung (ungueltig_…) nicht als gesendet vermerken: die korrigierte Fassung kommt an
  setze('invoices', 'counter:2027', { n: 6 });
  const inv6 = { invoiceNo: 'GNC-2027-0006', mode: 'sammel', createdAt: '2027-03-11T08:00:00.000Z', company: 'Muster GmbH', vat: [{ satz: 7, brutto: 10.7 }], total: 10.7 };
  setze('invoices', 'inv:GNC-2027-0006', inv6);
  fehlerSchluessel.set('rechnung:GNC-2027-0006', (d) => (d.kunde === 'Muster GmbH' ? 'ungueltig_kunde' : null));
  tg = TELEGRAM.length;
  r = await nacht('2027-03-12');
  ok('Abgelehnte Rechnung: gemeldet, aber nicht als gesendet vermerkt', /Nicht gebucht: Rechnung GNC-2027-0006 \(ungueltig_kunde\)/.test(neueTexte(tg))
    && schluessel('gesendet:2027-03-12:rechnung:GNC-2027-0006').length === 0, neueTexte(tg));
  a = ANFRAGEN.length;
  r = await nacht('2027-03-13');
  ok('… nächste Nacht geht sie wieder raus (doppelt, Zustand fehler) und wird nicht noch einmal gemeldet', ANFRAGEN.slice(a).flat().includes('rechnung:GNC-2027-0006')
    && r.ergebnisse.some((e) => e.schluessel === 'rechnung:GNC-2027-0006' && e.status === 'doppelt' && e.zustand === 'fehler') && textMit(/GNC-2027-0006/) === 1
    && schluessel('gesendet:2027-03-13:rechnung:GNC-2027-0006').length === 0, r.ergebnisse);
  setze('invoices', 'inv:GNC-2027-0006', { ...inv6, company: 'Muster GmbH & Co. KG' });
  r = await nacht('2027-03-14');
  ok('… die korrigierte Fassung wird gebucht und vermerkt', r.ergebnisse.some((e) => e.schluessel === 'rechnung:GNC-2027-0006' && e.status === 'gebucht')
    && !!lies('office-lauf', 'gesendet:2027-03-14:rechnung:GNC-2027-0006'), r.ergebnisse);
  a = ANFRAGEN.length;
  r = await nacht('2027-03-15');
  ok('… und geht danach nicht mehr raus', r.status === 'fertig' && !ANFRAGEN.slice(a).flat().includes('rechnung:GNC-2027-0006'), ANFRAGEN.slice(a));

  // 14. Lange Telegram-Nachrichten
  let txt = nachricht(Array.from({ length: 40 }, (_, i) => 'Zeile ' + (i + 1)));
  let zeilen = txt.split('\n');
  ok('Telegram: höchstens 25 Zeilen, dann "und N weitere, Details im Office"', zeilen.length === 28 && zeilen[25] === 'Zeile 25' && zeilen[26] === 'und 15 weitere, Details im Office', zeilen);
  txt = nachricht(['x'.repeat(10) + '&'.repeat(2000), ...Array.from({ length: 20 }, () => '<'.repeat(700))]);
  ok('… nie mitten in einer HTML-Entität geschnitten, unter 4000 Zeichen', txt.length < 4000 && !/&(?!amp;|lt;|gt;)/.test(txt) && /und \d+ weitere, Details im Office/.test(txt), txt.length);
  ok('… kurze Nachricht unverändert', nachricht(['A & B']) === '<b>GNC Office</b>\nA &amp; B\nhttps://office.grillnchill-foodtruck.de/#/shop');

  // ===== sammeln einzeln =====
  const { sammeln, keyZeit } = require(F + '/lib/office-sammeln.js');
  const { baueMeldungen } = require(F + '/lib/office-tag.js');
  const zahlBestellung = (iso, extra = {}, keyMs) => {
    const ref = 'GNC-' + (keyMs || Date.parse(iso));
    setze('orders', 'o:' + ref, { status: 'completed', quelle: 'online', completedAt: iso,
      order: { reference: ref, payment: 'sumup', items: [{ qty: 1, vatSplit: { 7: 8, 19: 0 } }], subtotal: 8, discount: 0, dealDiscount: 0, loyaltyDiscount: 0, deliveryFee: 0, tip: 0, total: 8 }, ...extra });
    return ref;
  };
  // 5. Erstattungen: Ereignisse und Bestellungen mit status refunded vereinigt, je Referenz einmal
  const refA = zahlBestellung('2027-06-03T10:00:00.000Z', { status: 'refunded', refundedAt: '2027-06-05T10:00:00.000Z' });   // ohne Ereignis
  const refB = zahlBestellung('2027-06-04T10:00:00.000Z', { status: 'refunded', refundedAt: '2027-06-06T10:00:00.000Z' });   // mit Ereignis
  setze('office-ereignisse', 'erstattung:2027-06-06:' + refB, { reference: refB, refundedAt: '2027-06-06T10:00:00.000Z' });
  const refC = zahlBestellung('2027-05-01T10:00:00.000Z', { status: 'refunded', refundedAt: '2027-06-07T10:00:00.000Z' });   // vor dem Lesebereich, nur über das Ereignis
  setze('office-ereignisse', 'erstattung:2027-06-07:' + refC, { reference: refC, refundedAt: '2027-06-07T10:00:00.000Z' });
  setze('office-ereignisse', 'erstattung:2027-06-08:GNC-1811111111111', { reference: 'GNC-1811111111111' });   // Bestellung fehlt
  // 8. Uhr des Kunden-Geräts geht vor: Zeitstempel im Schlüssel liegt Jahre in der Zukunft
  const refE = zahlBestellung('2027-06-08T10:00:00.000Z', {}, Date.parse('2031-01-01T00:00:00.000Z'));
  let d = await sammeln('2027-06-01', '2027-06-14');
  const je = (ref) => d.erstattungen.filter((e) => e && e.rec && (e.rec.order || {}).reference === ref);
  ok('Erstattung nur als Status in der Bestellung, ohne Ereignis: genau einmal', je(refA).length === 1 && je(refA)[0].tag === '2027-06-05', d.erstattungen.map((e) => [e.tag, e.referenz]));
  ok('… mit Ereignis und Status: genau einmal', je(refB).length === 1 && je(refB)[0].tag === '2027-06-06');
  ok('… Bestellung vor dem Lesebereich: über das Ereignis nachgelesen', je(refC).length === 1);
  let b = baueMeldungen({ von: '2027-06-01', bis: '2027-06-14', ...d });
  const posten = (tag) => ((b.meldungen.find((m) => m.schluessel === `tag:${tag}:online`) || {}).daten || {}).posten || [];
  ok('… in der Tagesmeldung genau eine Erstattung', JSON.stringify(posten('2027-06-05')) === JSON.stringify([{ typ: 'erstattung', zahlart: 'sumup', satz: 7, brutto_cent: 800 }]), posten('2027-06-05'));
  ok('… Ereignis ohne Bestellung: Hinweis mit Nummer', b.hinweise.some((h) => /GNC-1811111111111.*nicht gefunden/.test(h.text)), b.hinweise);
  ok('Bestellung mit Zeitstempel in der Zukunft (Uhr des Geräts) wird trotzdem gelesen', d.bestellungen.some((x) => (x.order || {}).reference === refE)
    && posten('2027-06-08').some((p) => p.typ === 'umsatz'), posten('2027-06-08'));
  ok('Lesezugriffe und Lesefehler stehen im Ergebnis', d.lesezugriffe > 0 && d.lesefehler === 0, { l: d.lesezugriffe, f: d.lesefehler });

  // 4. Fail-closed: Bestellungen, Ereignisse, Gutscheine; tolerant: Rechnungen und Zahlungen
  getWirft.add('orders|o:' + refA);
  ok('Lesefehler einer Bestellung wird gezählt', (await sammeln('2027-06-01', '2027-06-14')).lesefehler === 1);
  getWirft.clear();
  listeWirft = 'vouchers';
  ok('Liste der Gutscheine nicht lesbar: zählt als Lesefehler', (await sammeln('2027-06-01', '2027-06-14')).lesefehler === 1);
  listeWirft = 'office-ereignisse';
  ok('Liste der Erstattungs-Ereignisse nicht lesbar: zählt als Lesefehler', (await sammeln('2027-06-01', '2027-06-14')).lesefehler === 1);
  listeWirft = null;
  getWirft.add('orders|o:GNC-1811111111111');   // das Nachlesen zum Ereignis scheitert
  ok('Nachlesen einer Bestellung zum Ereignis scheitert: Lesefehler', (await sammeln('2027-06-01', '2027-06-14')).lesefehler === 1);
  getWirft.clear();
  getWirft.add('invoices|counter:2027');
  ok('Rechnungen bleiben tolerant', (await sammeln('2027-06-01', '2027-06-14')).lesefehler === 0);
  getWirft.clear();

  // 6. Sammelrechnung: Zahlung, total und Posten gleich
  const inv90 = { invoiceNo: 'GNC-2027-0090', mode: 'sammel', invoiceDay: '2027-05-31', company: 'Firma X', vat: [{ satz: 7, brutto: 10.7 }, { satz: 19, brutto: 23.81 }], total: 34.5 };
  setze('invoices', 'inv:GNC-2027-0090', inv90);
  setze('firmen', 'rechnung:fx:2027-05', { invoiceNo: 'GNC-2027-0090', status: 'bezahlt', bezahltAm: '2027-06-09T09:00:00.000Z' });
  d = await sammeln('2027-06-01', '2027-06-14');
  const z90 = d.firmenZahlungen.find((z) => z.nummer === 'GNC-2027-0090');
  b = baueMeldungen({ von: '2027-05-01', bis: '2027-06-14', ...d, rechnungen: [inv90] });
  const r90 = b.meldungen.find((m) => m.schluessel === 'rechnung:GNC-2027-0090');
  ok('Sammelrechnung: Posten, total und Zahlung gleich', z90 && z90.betrag_cent === 3450 && r90 && r90.daten.posten.reduce((s2, p) => s2 + p.brutto_cent, 0) === 3450, { z90, r90 });

  // 12. Rückwärtssuche: Einzelrechnungen nur mit invoiceDate (TT.MM.JJJJ) beenden die Suche
  setze('invoices', 'counter:2029', { n: 60 });
  for (let k = 1; k <= 60; k++) setze('invoices', 'inv:GNC-2029-' + String(k).padStart(4, '0'), { invoiceNo: 'GNC-2029-' + String(k).padStart(4, '0'), invoiceDate: '05.01.2029', company: 'Einzel', vat: [{ satz: 19, brutto: 10 }] });
  GELESEN.clear();
  d = await sammeln('2029-03-01', '2029-03-14');
  ok('Rückwärtssuche endet an Rechnungen mit nur invoiceDate', GELESEN.get('invoices') === 1 + 25 && d.rechnungen.length === 0, Object.fromEntries(GELESEN));

  // ===== Sammeln unter Last: Dauer und Lesezugriffe =====
  const VON = '2027-04-01', BIS = '2027-04-14';
  const ab = Date.parse(VON + 'T00:00:00Z') - 10 * 86400000;
  for (let i = 0; i < 2000; i++) {   // 2000 Bestellungen über 70 Tage
    const t = Date.parse('2027-02-20T00:00:00Z') + Math.floor(i * 70 * 86400000 / 2000);
    setze('orders', 'o:GNC-' + t, { status: 'completed', quelle: 'online', completedAt: new Date(t).toISOString(), order: { reference: 'GNC-' + t, payment: 'sumup', total: 8, items: [{ qty: 1, vatSplit: { 7: 8, 19: 0 } }], subtotal: 8 } });
  }
  // Gelesen wird ab 10 Tage vor dem Fenster, ohne Obergrenze (Schlüssel ohne Zeitstempel immer)
  const imFenster = [...DATEN.keys()].filter((k) => k.startsWith('orders|o:')).filter((k) => { const t = keyZeit(k.slice(7)); return t == null || t >= ab; }).length;
  for (let i = 0; i < 300; i++) setze('vouchers', 'c:V' + i, { code: 'V' + i, giftcard: true, value: 25, redeemedVia: i < 10 ? 'truck' : null,
    ...(i < 10 ? { manualRedeemedAt: i < 3 ? 'kaputt' : '2027-04-05T10:00:00.000Z' } : {}) });
  setze('invoices', 'counter:2027', { n: 200 });
  for (let k = 1; k <= 200; k++) setze('invoices', 'inv:GNC-2027-' + String(k).padStart(4, '0'), { invoiceNo: 'GNC-2027-' + String(k).padStart(4, '0'), mode: 'sammel', company: 'Firma ' + k,
    createdAt: k === 100 ? 'kaputt' : '2027-04-' + String(1 + (k % 14)).padStart(2, '0') + 'T08:00:00.000Z', vat: [{ satz: 7, brutto: 107 }] });
  for (let i = 0; i < 50; i++) setze('firmen', `rechnung:f${i}:${i < 40 ? '2027-03' : '2028-01'}`, { invoiceNo: 'GNC-2027-0001', status: 'bezahlt', bezahltAm: i === 0 ? 'kaputt' : '2027-04-07T09:00:00.000Z' });
  GELESEN.clear();
  let t0 = Date.now();
  const daten = await sammeln(VON, BIS);
  const dauer = Date.now() - t0;
  const gelesen = Object.fromEntries(GELESEN);
  const summe = [...GELESEN.values()].reduce((x, y) => x + y, 0);
  console.log(`   sammeln: ${dauer} ms, ${summe} Lesezugriffe`, JSON.stringify(gelesen));
  ok('Last: sammeln wirft bei kaputten Datumswerten nicht und braucht unter 5 Sekunden', dauer < 5000 && daten.bestellungen.length === imFenster && daten.lesefehler === 0, { dauer, n: daten.bestellungen.length, imFenster });
  ok('Last: Bestellungen erst ab 10 Tagen vor dem Fenster gelesen', gelesen.orders === imFenster && imFenster < 2000, { gelesen: gelesen.orders, imFenster });
  ok('Last: Rechnungen im Fenster (200 plus Zähler, die bezahlte Rechnung ist schon gelesen), Firmen nur Monate bis zum Fensterende', gelesen.invoices === 1 + 200 && gelesen.firmen === 41, gelesen);
  ok('Last: unlesbare Daten bleiben als Eintrag mit Tag null erhalten', daten.truck.filter((x) => x.tag === null).length === 3 && daten.firmenZahlungen.some((x) => x.tag === null));
  const gebaut = baueMeldungen({ von: VON, bis: BIS, ...daten });
  ok('Last: daraus entstehen Hinweise zu unlesbaren Daten, keine Ausnahme', gebaut.hinweise.some((h) => h.tag === null && /unlesbar/.test(h.text)), gebaut.hinweise.slice(0, 3));
  ok('Last: drei kaputte Truck-Gutscheine, drei verschiedene Hinweise mit Endung', gebaut.hinweise.filter((h) => /^Gutschein mit Endung V[012] am Truck/.test(h.text)).length === 3, gebaut.hinweise.filter((h) => /Truck/.test(h.text)));

  // ===== Messung mit Verzögerung: 100 ms je Blob-Aufruf, eine Welle paralleler Aufrufe dauert also 100 ms =====
  // 2.100 Bestellungen, 350 Gutscheine, 200 Rechnungen, 50 Firmen-Rechnungsvermerke. Fenster 01.09.–14.09.2027.
  for (const k of [...DATEN.keys()]) if (/^(orders|vouchers|invoices|firmen|office-ereignisse)\|/.test(k)) DATEN.delete(k);
  const MV = '2027-09-01', MB = '2027-09-14';
  const messDaten = (anfang, tage) => {
    for (const k of [...DATEN.keys()]) if (k.startsWith('orders|')) DATEN.delete(k);
    const a0 = Date.parse(anfang + 'T08:00:00Z');
    for (let i = 0; i < 2100; i++) {
      const t = a0 + Math.floor(i * tage * 86400000 / 2100);
      setze('orders', 'o:GNC-' + t, { status: 'completed', quelle: 'online', completedAt: new Date(t).toISOString(), order: { reference: 'GNC-' + t, payment: 'sumup', total: 8, items: [{ qty: 1, vatSplit: { 7: 8, 19: 0 } }], subtotal: 8 } });
    }
  };
  for (let i = 0; i < 350; i++) setze('vouchers', 'c:M' + i, { code: 'M' + i, giftcard: true, value: 25, redeemedVia: i < 20 ? 'truck' : null, ...(i < 20 ? { manualRedeemedAt: '2027-09-05T10:00:00.000Z' } : {}) });
  setze('invoices', 'counter:2027', { n: 200 });
  for (let k = 1; k <= 200; k++) setze('invoices', 'inv:GNC-2027-' + String(k).padStart(4, '0'), { invoiceNo: 'GNC-2027-' + String(k).padStart(4, '0'), mode: 'sammel', company: 'Firma ' + k,
    createdAt: '2027-09-' + String(1 + (k % 14)).padStart(2, '0') + 'T08:00:00.000Z', vat: [{ satz: 7, brutto: 107 }], total: 107 });
  for (let i = 0; i < 50; i++) setze('firmen', `rechnung:f${i}:2027-08`, { invoiceNo: 'GNC-2027-' + String(i + 1).padStart(4, '0'), status: 'bezahlt', bezahltAm: '2027-09-07T09:00:00.000Z' });
  const messen = async (name) => {
    GELESEN.clear(); GLEICHZEITIG.clear();
    blobVerzoegerung = 100;
    const t1 = Date.now();
    const m = await sammeln(MV, MB);
    const ms = Date.now() - t1;
    blobVerzoegerung = 0;
    const g = Object.fromEntries(GELESEN);
    console.log(`   Messung ${name}: sammeln ${ms} ms, ${m.lesezugriffe} Lesezugriffe, gleichzeitig ${JSON.stringify(Object.fromEntries(GLEICHZEITIG))}, je Store ${JSON.stringify(g)}`);
    return { ms, m, g };
  };
  // Alltag: 2.100 Bestellungen über 90 Tage (so lange bleiben abgeschlossene im Speicher), letzte am 14.09.
  messDaten('2027-06-17', 90);
  const alltag = await messen('Alltag (2.100 über 90 Tage)');
  // Ungünstigster Fall: alle 2.100 liegen im Lesebereich (22.08.–14.09.)
  messDaten('2027-08-22', 24);
  const schlimm = await messen('ungünstig (2.100 im Lesebereich)');
  ok('Messung: Bestellungen und Gutscheine je 75 parallel', GLEICHZEITIG.get('orders') === 75 && GLEICHZEITIG.get('vouchers') === 75, Object.fromEntries(GLEICHZEITIG));
  ok('Messung: alle 2.100 Bestellungen gelesen, Firmen-Rechnungen nicht doppelt', schlimm.g.orders === 2100 && schlimm.m.bestellungen.length === 2100 && schlimm.g.invoices === 1 + 200, schlimm.g);
  ok('Messung: sammeln bleibt weit unter dem Zeitbudget (Alltag unter 5 s, ungünstig unter 8 s)', alltag.ms < 5000 && schlimm.ms < 8000, { alltag: alltag.ms, schlimm: schlimm.ms });

  console.log('\n' + (fehler ? '❌ ' + fehler + ' von ' + n + ' Prüfungen fehlgeschlagen' : '✅ Alle ' + n + ' Prüfungen grün'));
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.log('Absturz:', e && e.stack); process.exit(1); });
