#!/usr/bin/env node
/**
 * werkzeug/office-steuer-test.js
 * Steueraufteilung fürs Office gegen splitVat()/buildVatSummary() aus index.html (eingefrorene Regeln)
 * und feste Rechenbeispiele.
 *   node werkzeug/office-steuer-test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const SK = require(ROOT + '/speisekarte.js');
const S = require(ROOT + '/netlify/functions/lib/office-steuer.js');

let n = 0, fehler = 0;
const ok = (name, b, info) => { n++; if (!b) fehler++; console.log((b ? '✅ ' : '❌ ') + name + (b || info === undefined ? '' : '   → ' + JSON.stringify(info))); };
const gleich = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Die beiden Funktionen aus index.html, so wie der Browser sie ausführt
const html = fs.readFileSync(ROOT + '/index.html', 'utf8');
const stueck = (name) => { const i = html.indexOf('function ' + name + '('); const j = html.indexOf('\n}\n', i); return html.slice(i, j + 2); };
const B = { MENU: SK.MENU, entryUnitPrice: (e) => SK.einzelpreis(e), VAT_FOOD: 7, VAT_DRINK: 19 };
vm.createContext(B);
vm.runInContext(stueck('splitVat') + '\n' + stueck('buildVatSummary') + '\nthis.splitVat = splitVat; this.buildVatSummary = buildVatSummary;', B);

const menue = (menuId, qty, drink, extra = {}) => ({ menuId, qty, isMenu: true, drink, side: 'pommes', dip: 'dip-mayo', ...extra });
const einzeln = (menuId, qty, extra = {}) => ({ menuId, qty, ...extra });
// Bestellung wie aus dem Browser: items mit vatSplit, Summen in Euro
function bestellung(korb, x = {}) {
  const items = Object.values(korb).map((e) => ({ qty: e.qty, vatSplit: B.splitVat(e, SK.einzelpreis(e) * e.qty) }));
  const subtotal = SK.warenwert(korb);
  const o = { items, subtotal, discount: 0, dealDiscount: 0, loyaltyDiscount: 0, deliveryFee: 0, tip: 0, cartSnapshot: korb, ...x };
  o.total = +(Math.max(0, o.subtotal - o.discount - o.loyaltyDiscount + o.deliveryFee) + o.tip).toFixed(2);
  return o;
}

(async () => {
  // 1. splitVat: jede Position, einzeln und als Menü mit jedem Getränk
  let gleicheTeile = true;
  for (const m of SK.MENU) {
    for (const e of [einzeln(m.id, 2), ...SK.MENU_DRINK_IDS.map((d) => menue(m.id, 3, d))]) {
      const brutto = SK.einzelpreis(e) * e.qty;
      if (!gleich(S.splitVat(e, brutto), JSON.parse(JSON.stringify(B.splitVat(e, brutto))))) { gleicheTeile = false; console.log('   abweichend:', e); }
    }
  }
  ok('splitVat rechnet für jede Position wie im Browser', gleicheTeile);

  // 2. buildVatSummary: Zeilen je Satz gleich, auch mit Rabatt, Deal, Liefergebühr, Trinkgeld und Gutschein über alles
  const korb = { a: menue('classic', 2, 'fritz-kola'), b: einzeln('fritz-or', 1), c: einzeln('pommes', 1) };
  const faelle = [[0, 0, 0, 0], [10, 3.5, 1, 0], [0, 0, 0, 4], [5, 0, 0.9, 4], [40, 0, 0, 0], [13, 2.5, 0, 0]];
  let gleicheZeilen = true;
  for (const [rabatt, liefer, tip, deal] of faelle) {
    const waren = S.warenJeSatz(bestellung(korb)).waren;
    const browser = JSON.parse(JSON.stringify(B.buildVatSummary(korb, rabatt, liefer, tip, deal)));
    const hier = S.zeilen(waren, rabatt, liefer, tip, deal);
    const erwartet = { 7: 0, 19: 0 };
    for (const z of browser) erwartet[z.satz] = z.brutto;
    if (!gleich(hier, erwartet)) { gleicheZeilen = false; console.log('   abweichend:', { rabatt, liefer, tip, deal, hier, erwartet }); }
  }
  ok('buildVatSummary: gleiche Bruttobeträge je Satz in allen Fällen', gleicheZeilen);

  // 3. Feste Rechenbeispiele (Warenwert 7 %: 21,00 €, 19 %: 7,50 €)
  const k2 = { a: menue('classic', 2, 'fritz-kola'), b: einzeln('fritz-or', 1) };
  let a = S.aufteilung(bestellung(k2));
  ok('Ohne Rabatt: 2100 / 750 Cent, aus dem Beleg', gleich(a.bezahlt, { 7: 2100, 19: 750 }) && a.quelle === 'beleg' && a.rest === 0, a);
  a = S.aufteilung(bestellung(k2, { discount: 10, deliveryFee: 3.5, tip: 1 }), { gutscheinCent: 1000 });
  ok('Gutschein 10 €, Lieferung 3,50 €, Trinkgeld 1 €: bezahlt 1621 / 679, Gutschein 737 / 263', gleich(a.bezahlt, { 7: 1621, 19: 679 }) && gleich(a.gutschein, { 7: 737, 19: 263 }), a);
  a = S.aufteilung(bestellung(k2, { discount: 4, dealDiscount: 4 }));
  ok('Geburtstags-Deal 4 € nur auf 7 %: 1700 / 750', gleich(a.bezahlt, { 7: 1700, 19: 750 }), a);
  a = S.aufteilung(bestellung(k2, { discount: 28.5 }), { gutscheinCent: 2850 });
  ok('Gutschein über alles: bezahlt 0 / 0, Gutschein 2100 / 750', gleich(a.bezahlt, { 7: 0, 19: 0 }) && gleich(a.gutschein, { 7: 2100, 19: 750 }), a);
  a = S.aufteilung(bestellung(k2, { discount: 5 }), { gutscheinCent: 0 });
  ok('Aktionscode (kein Geschenkgutschein): Rabatt mindert den Umsatz, keine Einlösung', a.bezahlt[7] + a.bezahlt[19] === 2350 && a.gutschein[7] === 0 && a.gutschein[19] === 0, a);

  // 4. Rückfall: Anteile passen nicht zum Warenwert (Server hat korrigiert) oder fehlen
  const o = bestellung(k2);
  o.items[0].vatSplit = { 7: 1, 19: 1 };
  a = S.aufteilung(o);
  ok('Falsche Anteile im Beleg: aus dem Warenkorb neu gerechnet', a.quelle === 'warenkorb' && gleich(a.bezahlt, { 7: 2100, 19: 750 }), a);
  a = S.aufteilung({ subtotal: 20, total: 20, items: [{ qty: 1 }] });
  ok('Ohne Anteile und ohne Warenkorb: alles mit 19 % und als geschätzt markiert', a.quelle === 'geschaetzt' && gleich(a.bezahlt, { 7: 0, 19: 2000 }), a);
  a = S.aufteilung({ ...bestellung(k2), total: 28.51 });
  ok('Rundungsrest landet in der größeren Zeile, rest wird gemeldet', a.bezahlt[7] === 2101 && a.rest === 1, a);

  console.log('\n' + (fehler ? '❌ ' + fehler + ' von ' + n + ' Prüfungen fehlgeschlagen' : '✅ Alle ' + n + ' Prüfungen grün'));
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.log('Absturz:', e && e.stack); process.exit(1); });
