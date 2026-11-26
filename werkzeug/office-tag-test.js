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
const erstattungen = [{ tag: '2027-01-05', rec: bestellungen[0] }, { tag: '2027-01-05', rec: { status: 'refunded', kind: 'giftcard', completedAt: '2027-01-03T09:00:00.000Z', gift: { amount: 20 } } }];
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

const nochmal = T.baueMeldungen({ von: '2027-01-01', bis: '2027-01-05', bestellungen: [...bestellungen].reverse(), erstattungen: [...erstattungen].reverse(), geschenkCodes: new Set(['GNCABCDEF']),
  truck: [...truck].reverse(), rechnungen: [...rechnungen].reverse(), firmenZahlungen: [...firmenZahlungen].reverse() });
ok('Alle Eingabearten in umgekehrter Reihenfolge ergeben dieselben Meldungen und Hinweise', gleich(nochmal.meldungen, meldungen) && gleich(nochmal.hinweise, hinweise));
const drehen = (a, k) => a.slice(k).concat(a.slice(0, k));
const gedreht = T.baueMeldungen({ von: '2027-01-01', bis: '2027-01-05', bestellungen: drehen(bestellungen, 4), erstattungen: drehen(erstattungen, 1), geschenkCodes: new Set(['GNCABCDEF']),
  truck: drehen(truck, 1), rechnungen: drehen(rechnungen, 2), firmenZahlungen: drehen(firmenZahlungen, 1) });
ok('… und gedreht ebenso', gleich(gedreht.meldungen, meldungen) && gleich(gedreht.hinweise, hinweise));
ok('Leerer Zeitraum ergibt keine Meldungen', T.baueMeldungen({ von: '2027-02-01', bis: '2027-02-14', bestellungen }).meldungen.length === 0);
ok('tagAus versteht ISO, deutsches Datum und Zeitstempel', T.tagAus('2027-01-16') === '2027-01-16' && T.tagAus('16.01.2027') === '2027-01-16'
  && T.tagAus('2027-01-15T23:30:00.000Z') === '2027-01-16' && T.tagAus('morgen') === null);

// ---- Review-Fixes ----
const bau = (x) => T.baueMeldungen({ von: '2027-01-01', bis: '2027-12-31', ...x });
const hat = (res, re) => res.hinweise.some((h) => re.test(h.text));

// Sommerzeit: 23:30 UTC im Juli ist 01:30 am Folgetag in Berlin
const sommer = bau({ bestellungen: [rec({ reference: 'GNC-S' }, { completedAt: '2027-07-03T23:30:00.000Z' })] });
ok('Sommerzeit: Bestellung um 23:30 UTC gehört zum Folgetag', gleich(sommer.meldungen.map((m) => m.schluessel), ['tag:2027-07-04:online']), sommer.meldungen.map((m) => m.schluessel));
const winter = bau({ bestellungen: [rec({ reference: 'GNC-W' }, { completedAt: '2027-01-03T23:30:00.000Z' })] });
ok('Winterzeit: 23:30 UTC gehört ebenfalls zum Folgetag (UTC+1)', gleich(winter.meldungen.map((m) => m.schluessel), ['tag:2027-01-04:online']));
const sommer2 = bau({ bestellungen: [rec({ reference: 'GNC-S2' }, { completedAt: '2027-07-03T21:59:00.000Z' })] });
ok('Sommerzeit: 21:59 UTC bleibt am selben Tag', gleich(sommer2.meldungen.map((m) => m.schluessel), ['tag:2027-07-03:online']));

// Schlussrechnung und Storno mit gemischten Vorzeichen
const schluss = (nr, vat, x = {}) => ({ invoiceNo: nr, art: 'catering_schluss', invoiceDay: '2027-03-01', kundeName: 'Hochzeit Meier', vat, ...x });
let q = bau({ rechnungen: [schluss('GNC-2027-0010', [{ satz: 19, brutto: 300 }, { satz: 7, brutto: -100 }, { satz: 19.0, brutto: 0 }])] });
ok('Schlussrechnung mit gemischten Vorzeichen und positiver Summe: eine Meldung, beide Zeilen', q.meldungen.length === 1 && gleich(q.meldungen[0].daten.posten, [{ satz: 7, brutto_cent: -10000 }, { satz: 19, brutto_cent: 30000 }])
  && q.meldungen[0].daten.art === 'schlussrechnung' && q.hinweise.length === 0, q);
q = bau({ rechnungen: [schluss('GNC-2027-0011', [{ satz: 7, brutto: 0 }, { satz: 19, brutto: 119 }])] });
ok('Schlussrechnung: Zeilen mit 0 entfallen', gleich(q.meldungen[0].daten.posten, [{ satz: 19, brutto_cent: 11900 }]));
for (const vat of [[{ satz: 7, brutto: -100 }, { satz: 19, brutto: 100 }], [{ satz: 7, brutto: -100 }, { satz: 19, brutto: 40 }]]) {
  q = bau({ rechnungen: [schluss('GNC-2027-0012', vat)] });
  ok('Schlussrechnung mit Summe ' + (vat[1].brutto === 100 ? '0' : 'unter 0') + ': keine Meldung, Hinweis zum Handbuchen', q.meldungen.length === 0 && q.hinweise.length === 1
    && q.hinweise[0].text === 'Schlussrechnung GNC-2027-0012 ergibt keinen offenen Betrag (Anzahlung höher als Endstand). Bitte im Office von Hand buchen.', q.hinweise);
}
ok('rechnungsMeldung liefert für Summe ≤ 0 null', T.rechnungsMeldung(schluss('GNC-2027-0013', [{ satz: 19, brutto: -5 }])) === null);
const storno = (nr, vat) => ({ invoiceNo: nr, art: 'catering_storno', invoiceDay: '2027-03-02', kundeName: 'Hochzeit Meier', stornoZu: 'GNC-2027-0010', vat });
q = bau({ rechnungen: [storno('GNC-2027-0014', [{ satz: 7, brutto: 100 }, { satz: 19, brutto: -300 }])] });
ok('Storno mit gemischten Vorzeichen und negativer Summe: eine Meldung, beide Zeilen', q.meldungen.length === 1 && gleich(q.meldungen[0].daten.posten, [{ satz: 7, brutto_cent: 10000 }, { satz: 19, brutto_cent: -30000 }])
  && q.meldungen[0].daten.bezug === 'GNC-2027-0010', q);
for (const vat of [[{ satz: 7, brutto: 100 }, { satz: 19, brutto: -100 }], [{ satz: 7, brutto: 100 }, { satz: 19, brutto: -40 }]]) {
  q = bau({ rechnungen: [storno('GNC-2027-0015', vat)] });
  ok('Storno mit Summe ' + (vat[1].brutto === -100 ? '0' : 'über 0') + ': keine Meldung, Hinweis zum Handbuchen', q.meldungen.length === 0 && hat(q, /^Stornorechnung GNC-2027-0015 ergibt keinen offenen Betrag \(Anzahlung höher als Endstand\)\. Bitte im Office von Hand buchen\.$/), q.hinweise);
}
q = bau({ rechnungen: [schluss('GNC-2027-0016', [{ satz: 19, brutto: 50 }], { createdAt: '2027-03-01T10:00:00.000Z', invoiceDay: undefined })] });
ok('catering_schluss: Datum aus createdAt, Art schlussrechnung', q.meldungen[0].daten.datum === '2027-03-01' && q.meldungen[0].daten.art === 'schlussrechnung');

// Rechnung ohne Posten, ohne Kunde
q = bau({ rechnungen: [schluss('GNC-2027-0017', []), schluss('GNC-2027-0018', [{ satz: 7, brutto: 0 }])] });
ok('Rechnung ohne Posten ergibt keine Meldung', q.meldungen.length === 0 && T.rechnungsMeldung(schluss('GNC-2027-0017', [])) === null);
const ohneName = { invoiceNo: 'GNC-2027-0019', mode: 'sammel', invoiceDay: '2027-03-01', vat: [{ satz: 7, brutto: 10 }] };
q = bau({ rechnungen: [{ ...ohneName, email: 'kunde@beispiel.de' }] });
ok('Kunde ohne Namen: E-Mail-Adresse', q.meldungen.length === 1 && q.meldungen[0].daten.kunde === 'kunde@beispiel.de', q);
q = bau({ rechnungen: [{ ...ohneName, kundeName: ' ', company: '' }] });
ok('Kunde ganz ohne Angaben: null und Hinweis mit Nummer', q.meldungen.length === 0 && hat(q, /GNC-2027-0019/) && T.rechnungsMeldung(ohneName) === null, q);
ok('Name geht vor E-Mail', bau({ rechnungen: [{ ...ohneName, kundeName: 'Frau Meier', email: 'x@y.de' }] }).meldungen[0].daten.kunde === 'Frau Meier');

// Kaputte Daten brechen den Lauf nicht ab
let kaputt;
try {
  kaputt = bau({
    bestellungen: [rec({ reference: 'GNC-K1' }, { completedAt: 'kein-datum' }), rec({ reference: 'GNC-K2' }), { status: 'completed', kind: 'giftcard', completedAt: 'x', gift: { amount: 5 } }],
    erstattungen: [{ tag: '2027-13-45', rec: bestellungen[0] }, { tag: 'gestern', rec: bestellungen[0] }],
    truck: [{ tag: '2027-02-30', wert_cent: 100, bestellwert_cent: 100 }],
    rechnungen: [{ invoiceNo: 'GNC-2027-0030', art: 'catering_anzahlung', invoiceDay: 'xx', createdAt: 'yy', kundeName: 'Frau Geheim', vat: [{ satz: 7, brutto: 5 }] },
      { invoiceNo: 'GNC-2027-0031', art: 'catering_anzahlung', invoiceDay: '2027-03-01', bezahltAm: 'kaputt', kundeName: 'Frau Geheim', vat: [{ satz: 7, brutto: 5 }] }],
    firmenZahlungen: [{ tag: '31.02.2027', nummer: 'GNC-2027-0032', betrag_cent: 100 }],
  });
} catch (e) { kaputt = { fehler: e.message }; }
ok('Kaputte Datumswerte werfen nicht', !kaputt.fehler, kaputt.fehler);
ok('… die gesunde Bestellung kommt durch, kaputte Datensätze nicht', kaputt.meldungen && kaputt.meldungen.length === 1 && kaputt.meldungen[0].schluessel === 'tag:2027-01-03:online', kaputt.meldungen);
ok('… Hinweise nennen Nummern: Bestellung, Rechnungen, Zahlung', ['GNC-K1', 'GNC-2027-0030', 'GNC-2027-0031', 'GNC-2027-0032'].every((nr) => hat(kaputt, new RegExp(nr))), kaputt.hinweise);
ok('… Erstattung und Truck mit kaputtem Tag bekommen je einen Hinweis', kaputt.hinweise.filter((h) => /Erstattung/.test(h.text)).length === 2 && hat(kaputt, /Truck/), kaputt.hinweise);
ok('… Hinweise enthalten keine Kundendaten', !JSON.stringify(kaputt.hinweise).match(/Geheim|@/));
ok('tagAus lehnt unmögliche Kalendertage ab', ['2027-13-45', '2027-02-30', '2027-00-10', '31.02.2027', '2027-02-30T10:00:00Z', '2027-13-45T10:00:00Z', ''].every((x) => T.tagAus(x) === null) && T.tagAus('2028-02-29') === '2028-02-29' && T.tagAus('2027-02-29') === null);
ok('berlinTag wirft bei ungültigem Wert nicht', T.berlinTag('quatsch') === null && T.berlinTag(undefined) === null);

// Erstattungen
const erst = (tag, r) => bau({ erstattungen: [{ tag, rec: r }] });
q = erst('2027-02-01', { status: 'refunded', quelle: 'online', order: { payment: 'sumup', reference: 'GNC-E1', ...ware() } });
ok('Erstattung ohne vorherigen Umsatz (kein completedAt): Hinweis, keine Meldung', q.meldungen.length === 0 && hat(q, /GNC-E1.*ohne vorherigen Umsatz/), q);
q = erst('2027-02-01', { status: 'pending', quelle: 'online', completedAt: '2027-01-03T10:00:00Z', order: { payment: 'sumup', reference: 'GNC-E2', ...ware() } });
ok('Erstattung einer nicht bezahlten Bestellung: Hinweis, keine Meldung', q.meldungen.length === 0 && hat(q, /GNC-E2/));
q = erst('2027-02-01', { status: 'refunded', kind: 'giftcard', gift: { amount: 20 } });
ok('Gutschein-Erstattung ohne vorherigen Verkauf: Hinweis', q.meldungen.length === 0 && hat(q, /ohne vorherigen Umsatz/));
q = erst('2027-02-01', rec({ reference: 'GNC-E3', payment: 'cash', items: [{ qty: 1, vatSplit: { 7: 8, 19: 0 } }], subtotal: 8, total: 8 }, { status: 'refunded' }));
ok('Erstattung bei Barzahlung: vor_ort_erstattung ohne Zahlart', gleich(q.meldungen[0].daten.posten, [{ typ: 'vor_ort_erstattung', satz: 7, brutto_cent: 800 }]), q.meldungen);
q = erst('2027-02-01', { ...bestellungen[1], status: 'refunded' });
ok('Erstattung mit Gutschein-Anteil: nur der bezahlte Teil, keine Einlösung', gleich(q.meldungen[0].daten.posten, [
  { typ: 'erstattung', zahlart: 'sumup', satz: 19, brutto_cent: 679 }, { typ: 'erstattung', zahlart: 'sumup', satz: 7, brutto_cent: 1621 }]) ,
  q.meldungen.length ? q.meldungen[0].daten : q);
ok('… Test- und Fremdzahlungsbestellungen bleiben still', erst('2027-02-01', { ...bestellungen[4], status: 'refunded' }).hinweise.length === 0 && erst('2027-02-01', { ...bestellungen[6], status: 'refunded' }).hinweise.length === 0);

// Stilles Überspringen mit Hinweis
q = erst('2027-02-01', { status: 'refunded', kind: 'burgerpass', quelle: 'online', completedAt: '2027-01-05T09:00:00Z', reference: 'BP-1' });
ok('Erstattung eines Burger-Passes: Hinweis', q.meldungen.length === 0 && hat(q, /Burger-Pass-Erstattung/), q);
q = bau({ bestellungen: [{ status: 'completed', kind: 'giftcard', reference: 'GS-1', completedAt: '2027-01-03T09:00:00.000Z' }] });
ok('Gutschein-Verkauf ohne gift: Hinweis', q.meldungen.length === 0 && hat(q, /GS-1.*ohne Gutscheindaten/), q);
q = erst('2027-02-01', { status: 'refunded', kind: 'giftcard', reference: 'GS-2', completedAt: '2027-01-03T09:00:00.000Z' });
ok('Gutschein-Erstattung ohne gift: Hinweis', q.meldungen.length === 0 && hat(q, /GS-2.*ohne Gutscheindaten/), q);
ok('Erstattung außerhalb des Zeitraums: still', bau({ von: '2027-03-01', bis: '2027-03-31', erstattungen: [{ tag: '2027-02-01', rec: { status: 'refunded' } }] }).hinweise.length === 0);

// Mehrere Zahlungen auf dieselbe Rechnung
q = bau({ firmenZahlungen: [{ tag: '2027-02-10', nummer: 'GNC-2027-0040', betrag_cent: 5000, zahlart: 'ueberweisung' }, { tag: '2027-02-03', nummer: 'GNC-2027-0040', betrag_cent: 8080, zahlart: 'bar' }, { tag: '2027-02-04', nummer: 'GNC-2027-0041', betrag_cent: 100 }] });
ok('Zwei Zahlungen auf eine Rechnung: eine Meldung mit Summe, Datum und Zahlart der letzten', q.meldungen.length === 2 && gleich(q.meldungen[0], { schluessel: 'zahlung:GNC-2027-0040', art: 'zahlung',
  daten: { nummer: 'GNC-2027-0040', datum: '2027-02-10', zahlart: 'ueberweisung', betrag_cent: 13080 } }), q.meldungen);
q = bau({ firmenZahlungen: [{ tag: '2027-02-03', nummer: 'GNC-2027-0040', betrag_cent: 8080, zahlart: 'bar' }, { tag: '2027-02-10', nummer: 'GNC-2027-0040', betrag_cent: 5000 }].reverse() });
ok('… unabhängig von der Eingabereihenfolge', q.meldungen.length === 1 && q.meldungen[0].daten.betrag_cent === 13080 && q.meldungen[0].daten.datum === '2027-02-10');
q = bau({ von: '2027-02-05', bis: '2027-02-28', firmenZahlungen: [{ tag: '2027-02-03', nummer: 'GNC-2027-0040', betrag_cent: 100 }] });
ok('Zahlung vor dem Zeitraum: keine Meldung', q.meldungen.length === 0);

// ---- Schluss-Review ----
// Sammelrechnung: Unterschied zwischen Satzzeilen und Rechnungsbetrag (Rundung je Bestellung) in die größere Zeile
const sammel = (nr, vat, total) => ({ invoiceNo: nr, mode: 'sammel', invoiceDay: '2027-03-01', company: 'Muster GmbH', vat, total });
q = bau({ rechnungen: [sammel('GNC-2027-0050', [{ satz: 7, brutto: 10.7 }, { satz: 19, brutto: 23.81 }], 34.5)] });
ok('Sammelrechnung: 1 Cent Rundung in der größeren Zeile, Posten gleich total, kein Hinweis', gleich(q.meldungen[0].daten.posten, [{ satz: 7, brutto_cent: 1070 }, { satz: 19, brutto_cent: 2380 }])
  && q.hinweise.length === 0, q);
q = bau({ rechnungen: [sammel('GNC-2027-0051', [{ satz: 7, brutto: 40 }, { satz: 19, brutto: 23.8 }], 63.85)] });
ok('… 5 Cent: ausgeglichen in der 7-%-Zeile, mit Hinweis', gleich(q.meldungen[0].daten.posten, [{ satz: 7, brutto_cent: 4005 }, { satz: 19, brutto_cent: 2380 }])
  && hat(q, /GNC-2027-0051.*5 Cent/), q);
q = bau({ rechnungen: [sammel('GNC-2027-0052', [{ satz: 7, brutto: 10 }, { satz: 19, brutto: 5 }], 15)] });
ok('… stimmt schon: unverändert, kein Hinweis', gleich(q.meldungen[0].daten.posten, [{ satz: 7, brutto_cent: 1000 }, { satz: 19, brutto_cent: 500 }]) && q.hinweise.length === 0, q);
q = bau({ rechnungen: [sammel('GNC-2027-0053', [{ satz: 7, brutto: 1 }], 0)] });
ok('… Zeile würde 0: keine Meldung, Hinweis', q.meldungen.length === 0 && hat(q, /GNC-2027-0053/), q);
q = bau({ rechnungen: [{ ...sammel('GNC-2027-0054', [{ satz: 7, brutto: 2 }], 99), mode: undefined, art: 'catering_anzahlung', kundeName: 'Frau Meier' }] });
ok('… nur bei Sammelrechnungen: Anzahlung bleibt wie gestellt', gleich(q.meldungen[0].daten.posten, [{ satz: 7, brutto_cent: 200 }]), q);

// Truck-Gutscheine mit kaputtem Datum: Hinweis mit den letzten 4 Zeichen, damit zwei Fälle zwei Hinweise sind
q = bau({ truck: [{ tag: 'kaputt', wert_cent: 100, bestellwert_cent: 100, kennung: 'AB12' }, { tag: '2027-02-30', wert_cent: 100, bestellwert_cent: 100, kennung: 'CD34' }] });
ok('Truck: zwei kaputte Gutscheine ergeben zwei verschiedene Hinweise mit Endung', q.hinweise.length === 2 && new Set(q.hinweise.map((h) => h.text)).size === 2
  && hat(q, /AB12/) && hat(q, /CD34/), q.hinweise);

// Unbekannte Zahlart, fehlende Zahlart, fehlende Bestelldaten: Hinweis mit Nummer statt still wegfallen
q = bau({ bestellungen: [rec({ reference: 'GNC-Z1', payment: 'paypal' }), rec({ reference: 'GNC-Z2', payment: undefined }),
  { status: 'completed', quelle: 'online', completedAt: '2027-01-03T11:00:00.000Z', reference: 'GNC-Z3' },
  rec({ reference: 'GNC-Z4', payment: 'firma' }), rec({ reference: 'GNC-Z5', isTest: true })] });
ok('Unbekannte oder fehlende Zahlart und fehlende Bestelldaten: Hinweis mit Nummer, keine Meldung', q.meldungen.length === 0
  && ['GNC-Z1', 'GNC-Z2', 'GNC-Z3'].every((nr) => hat(q, new RegExp(nr + ':'))) && hat(q, /paypal/), q.hinweise);
ok('… Firmen- und Testbestellungen bleiben still', !hat(q, /GNC-Z4|GNC-Z5/), q.hinweise);
q = erst('2027-02-01', rec({ reference: 'GNC-Z6', payment: 'paypal' }, { status: 'refunded' }));
ok('Erstattung mit unbekannter Zahlart: Hinweis mit Nummer', q.meldungen.length === 0 && hat(q, /GNC-Z6/), q.hinweise);
q = bau({ erstattungen: [{ tag: '2027-02-01', rec: null, referenz: 'GNC-Z7' }] });
ok('Erstattung, deren Bestellung fehlt: Hinweis mit Nummer', q.meldungen.length === 0 && hat(q, /GNC-Z7.*nicht gefunden/), q.hinweise);

console.log('\n' + (fehler ? '❌ ' + fehler + ' von ' + n + ' Prüfungen fehlgeschlagen' : '✅ Alle ' + n + ' Prüfungen grün'));
process.exit(fehler ? 1 : 0);
