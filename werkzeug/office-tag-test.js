#!/usr/bin/env node
/**
 * werkzeug/office-tag-test.js
 * Meldungen fürs Office aus Bestellungen, Gutscheinen, Erstattungen und Rechnungen (feste Beispiele).
 *   node werkzeug/office-tag-test.js
 */
const path = require('path');
const T = require(path.join(__dirname, '..', 'netlify', 'functions', 'lib', 'office-tag.js'));

let n = 0, fehler = 0;
const ok = (name, b, info) => { n++; if (!b) fehler++; console.log((b ? '✅ ' : '❌ ') + name + (b || info === undefined ? '' : '   → ' + JSON.stringify(info))); };
const gleich = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Warenwert 21,00 € zu 7 % und 7,50 € zu 19 %, wie im Steuer-Test
const ware = () => ({ items: [{ qty: 2, vatSplit: { 7: 21, 19: 5 } }, { qty: 1, vatSplit: { 7: 0, 19: 2.5 } }], subtotal: 28.5,
  discount: 0, dealDiscount: 0, loyaltyDiscount: 0, deliveryFee: 0, tip: 0, total: 28.5 });
const rec = (o, x = {}) => ({ status: 'completed', quelle: 'online', completedAt: '2027-01-03T11:00:00.000Z', ...x, order: { payment: 'sumup', ...ware(), ...o } });

const bestellungen = [
  rec({ reference: 'GNC-1' }),
  rec({ reference: 'GNC-2', voucherCode: 'gncabcdef', discount: 10, deliveryFee: 3.5, tip: 1, total: 23 }),
  rec({ reference: 'GNC-3', payment: 'cash', abholTag: '2027-01-04', items: [{ qty: 1, vatSplit: { 7: 8, 19: 0 } }], subtotal: 8, total: 8 }),
  rec({ reference: 'GNC-4', voucherCode: 'GRILL5', discount: 5, total: 23.5 }),
  rec({ reference: 'GNC-5', isTest: true }),
  rec({ reference: 'GNC-6' }, { quelle: 'truck' }),
  rec({ reference: 'GNC-7', payment: 'firma' }),
  rec({ reference: 'GNC-8' }, { status: 'pending' }),
  rec({ reference: 'GNC-9' }, { completedAt: '2026-12-31T22:30:00.000Z' }),
  { status: 'completed', kind: 'giftcard', completedAt: '2027-01-03T09:00:00.000Z', gift: { amount: 50 } },
  { status: 'completed', kind: 'burgerpass', completedAt: '2027-01-05T09:00:00.000Z' },
];
const erstattungen = [{ tag: '2027-01-05', rec: bestellungen[0] }, { tag: '2027-01-05', rec: { status: 'refunded', kind: 'giftcard', gift: { amount: 20 } } }];
const truck = [{ tag: '2027-01-03', wert_cent: 2500, bestellwert_cent: 3000 }, { tag: '2027-01-03', wert_cent: 2500, bestellwert_cent: 2000 }];
const rechnungen = [
  { invoiceNo: 'GNC-2027-0004', art: 'catering_storno', invoiceDay: '2027-01-04', kundeName: 'Hochzeit Meier', stornoZu: 'GNC-2027-0002',
    vat: [{ satz: 7, brutto: -500 }, { satz: 19, brutto: -119 }] },
  { invoiceNo: 'GNC-2027-0003', mode: 'sammel', createdAt: '2027-01-02T08:00:00.000Z', invoiceDate: '02.01.2027', company: 'Muster GmbH', faelligAm: '2027-01-16',
    vat: [{ satz: 19, brutto: 23.8 }, { satz: 7, brutto: 107 }] },
  { invoiceNo: 'GNC-2027-0002', art: 'catering_anzahlung', invoiceDay: '2027-01-02', kundeName: 'Hochzeit Meier', bezahltAm: '2027-01-02T10:00:00.000Z',
    zahlungsweg: 'online', vat: [{ satz: 7, brutto: 500 }, { satz: 19, brutto: 119 }] },
  { invoiceNo: 'GNC-2027-0001', company: 'Einzelkunde GmbH', payment: 'sumup', vat: [{ satz: 7, brutto: 10 }] },
];
const firmenZahlungen = [{ tag: '2027-01-04', nummer: 'GNC-2026-0099', betrag_cent: 13080 }, { tag: '2026-12-30', nummer: 'GNC-2026-0098', betrag_cent: 100 }];

const { meldungen, hinweise } = T.baueMeldungen({ von: '2027-01-01', bis: '2027-01-05', bestellungen, erstattungen, geschenkCodes: new Set(['GNCABCDEF']), truck, rechnungen, firmenZahlungen });

ok('Reihenfolge: Rechnungen nach Nummer, Zahlung, Tage nach Datum', gleich(meldungen.map((m) => m.schluessel), [
  'rechnung:GNC-2027-0002', 'rechnung:GNC-2027-0003', 'rechnung:GNC-2027-0004', 'zahlung:GNC-2026-0099',
  'tag:2027-01-03:online', 'tag:2027-01-04:online', 'tag:2027-01-05:online']), meldungen.map((m) => m.schluessel));

const tag = (d) => meldungen.find((m) => m.schluessel === `tag:${d}:online`).daten;
ok('03.01.: SumUp-Umsatz, Gutschein-Einlösung, Verkauf, Truck mit verfallenem Rest', gleich(tag('2027-01-03'), { datum: '2027-01-03', posten: [
  { typ: 'gutschein_einloesung', satz: 19, brutto_cent: 263 },
  { typ: 'gutschein_einloesung', satz: 7, brutto_cent: 737 },
  { typ: 'gutschein_truck', brutto_cent: 4500 },
  { typ: 'gutschein_verfall', brutto_cent: 500 },
  { typ: 'gutschein_verkauf', zahlart: 'sumup', brutto_cent: 5000 },
  { typ: 'umsatz', zahlart: 'sumup', satz: 19, brutto_cent: 750 + 679 + 618 },
  { typ: 'umsatz', zahlart: 'sumup', satz: 7, brutto_cent: 2100 + 1621 + 1732 },
] }), tag('2027-01-03'));
ok('04.01.: Barzahlung am Abholtag, nur als vor_ort', gleich(tag('2027-01-04'), { datum: '2027-01-04', posten: [{ typ: 'vor_ort', satz: 7, brutto_cent: 800 }] }), tag('2027-01-04'));
ok('05.01.: Erstattungen am Tag der Markierung', gleich(tag('2027-01-05'), { datum: '2027-01-05', posten: [
  { typ: 'erstattung', zahlart: 'sumup', satz: 19, brutto_cent: 750 },
  { typ: 'erstattung', zahlart: 'sumup', satz: 7, brutto_cent: 2100 },
  { typ: 'gutschein_erstattung', zahlart: 'sumup', brutto_cent: 2000 },
] }), tag('2027-01-05'));

const r = (nr) => meldungen.find((m) => m.schluessel === 'rechnung:' + nr).daten;
ok('Catering-Anzahlung kommt mit Zahlung über SumUp', gleich(r('GNC-2027-0002'), { nummer: 'GNC-2027-0002', art: 'anzahlung', datum: '2027-01-02', kunde: 'Hochzeit Meier',
  posten: [{ satz: 7, brutto_cent: 50000 }, { satz: 19, brutto_cent: 11900 }], zahlung: { datum: '2027-01-02', zahlart: 'sumup' } }), r('GNC-2027-0002'));
ok('Sammelrechnung: Datum aus createdAt, fällig, Posten nach Satz sortiert', gleich(r('GNC-2027-0003'), { nummer: 'GNC-2027-0003', art: 'sammelrechnung', datum: '2027-01-02', kunde: 'Muster GmbH',
  posten: [{ satz: 7, brutto_cent: 10700 }, { satz: 19, brutto_cent: 2380 }], faellig: '2027-01-16' }), r('GNC-2027-0003'));
ok('Stornorechnung mit Bezug und negativen Beträgen', gleich(r('GNC-2027-0004'), { nummer: 'GNC-2027-0004', art: 'storno', datum: '2027-01-04', kunde: 'Hochzeit Meier',
  posten: [{ satz: 7, brutto_cent: -50000 }, { satz: 19, brutto_cent: -11900 }], bezug: 'GNC-2027-0002' }), r('GNC-2027-0004'));
ok('Zahlung einer Sammelrechnung per Überweisung', gleich(meldungen.find((m) => m.art === 'zahlung').daten, { nummer: 'GNC-2026-0099', datum: '2027-01-04', zahlart: 'ueberweisung', betrag_cent: 13080 }));
ok('Hinweis für den Burger-Pass', hinweise.some((h) => h.tag === '2027-01-05' && /Burger-Pass/.test(h.text)), hinweise);
ok('Keine Kundennamen und keine Gutscheincodes in Tagesmeldungen', !JSON.stringify(meldungen.filter((m) => m.art === 'tag')).match(/GNCABCDEF|gncabcdef|GRILL5|Muster|Meier/i));

const nochmal = T.baueMeldungen({ von: '2027-01-01', bis: '2027-01-05', bestellungen: [...bestellungen].reverse(), erstattungen, geschenkCodes: new Set(['GNCABCDEF']), truck: [...truck].reverse(), rechnungen, firmenZahlungen });
ok('Gleiche Daten in anderer Reihenfolge ergeben dieselben Meldungen', gleich(nochmal.meldungen, meldungen));
ok('Leerer Zeitraum ergibt keine Meldungen', T.baueMeldungen({ von: '2027-02-01', bis: '2027-02-14', bestellungen }).meldungen.length === 0);
ok('tagAus versteht ISO, deutsches Datum und Zeitstempel', T.tagAus('2027-01-16') === '2027-01-16' && T.tagAus('16.01.2027') === '2027-01-16'
  && T.tagAus('2027-01-15T23:30:00.000Z') === '2027-01-16' && T.tagAus('morgen') === null);

console.log('\n' + (fehler ? '❌ ' + fehler + ' von ' + n + ' Prüfungen fehlgeschlagen' : '✅ Alle ' + n + ' Prüfungen grün'));
process.exit(fehler ? 1 : 0);
