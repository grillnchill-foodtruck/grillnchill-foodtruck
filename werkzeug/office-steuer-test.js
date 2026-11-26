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

  // 5. Untergrenze, Rückfall zum vollen Satz, leere Eingaben
  const k3 = { a: menue('classic', 2, 'fritz-kola'), b: einzeln('fritz-or', 1) };
  a = S.aufteilung({ ...bestellung(k3), total: 1, isTest: true });
  ok('Testbestellung über 1 €: kein Anteil negativ, Summe = total', a.bezahlt[7] >= 0 && a.bezahlt[19] >= 0 && a.bezahlt[7] + a.bezahlt[19] === 100, a);
  a = S.aufteilung({ ...bestellung(k3), total: 0 });
  ok('Total 0 bei vollem Warenwert: beide Anteile 0', gleich(a.bezahlt, { 7: 0, 19: 0 }), a);
  const ohneSub = bestellung(k3); delete ohneSub.subtotal; ohneSub.total = 20;
  a = S.aufteilung(ohneSub);
  ok('Ohne subtotal bei total > 0: alles 19 %, geschätzt', gleich(a.bezahlt, { 7: 0, 19: 2000 }) && a.quelle === 'geschaetzt', a);
  a = S.aufteilung({ ...bestellung(k3), subtotal: 0, total: 20 });
  ok('subtotal 0 bei total > 0: alles 19 %, geschätzt', gleich(a.bezahlt, { 7: 0, 19: 2000 }) && a.quelle === 'geschaetzt', a);
  let wirft = null; try { a = S.aufteilung(null); } catch (e) { wirft = e; }
  ok('aufteilung(null) wirft nicht und liefert eine leere Aufteilung', !wirft && a.quelle === 'geschaetzt' && gleich(a.bezahlt, { 7: 0, 19: 0 }) && gleich(a.gutschein, { 7: 0, 19: 0 }), wirft && wirft.message);
  wirft = null; try { a = S.aufteilung({ ...bestellung(k3), cartSnapshot: { x: null, ...k3 }, items: [] }); } catch (e) { wirft = e; }
  ok('null-Eintrag im Warenkorb wird übersprungen', !wirft && a.quelle === 'warenkorb' && gleich(a.bezahlt, { 7: 2100, 19: 750 }), wirft ? wirft.message : a);

  // 6. Zufallsvergleich mit dem Browser: 2000 Bestellungen, fester Startwert (LCG), echte Preise
  let seed = 20270103;
  const r = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const ids = SK.MENU.map((m) => m.id);
  const pick = (liste) => liste[Math.floor(r() * liste.length)];
  const f = { negativ: 0, summe: 0, gutschein: 0, browser: 0, abweichend1: 0 };
  for (let k = 0; k < 2000; k++) {
    const korb = {};
    const positionen = 1 + Math.floor(r() * 4);
    for (let i = 0; i < positionen; i++) {
      const e = { menuId: pick(ids), qty: 1 + Math.floor(r() * 3) };
      if (r() < 0.5) { e.isMenu = true; e.drink = pick(SK.MENU_DRINK_IDS); e.side = pick(SK.MENU_SIDE_OPTIONS).id; }
      if (r() < 0.3) e.double = true;
      korb['k' + i] = e;
    }
    const sub = SK.warenwert(korb);
    // Der Deal gilt nur auf Speisen zu 7 %, höchstens 4 €; sonst stimmt schon die Beleg-Summe im Browser nicht mit dem Betrag überein
    const speisen7 = Object.values(korb).reduce((sum, e) => sum + B.splitVat(e, SK.einzelpreis(e) * e.qty)[7], 0);
    const deal = r() < 0.2 ? +Math.min(4, speisen7).toFixed(2) : 0;
    const aktion = r() < 0.3 ? +(sub * 0.1).toFixed(2) : 0;
    const gutschein = r() < 0.3 ? +(r() * sub * 1.2).toFixed(2) : 0;
    const treue = r() < 0.2 ? 5 : 0;
    // Deckt der Deal den ganzen Warenwert, verteilt der Browser die Liefergebühr auf keine Zeile (Anteil 0): Randfall, der hier nicht verglichen wird
    const liefer = r() < 0.4 && sub - deal > 0 ? 3.5 : 0;
    const tip = r() < 0.4 ? +(r() * 3).toFixed(2) : 0;
    const total = SK.gesamtbetrag({ warenwert: sub, aktionsRabatt: aktion, dealRabatt: deal, treueRabatt: treue, gutscheinRabatt: gutschein, liefergebuehr: liefer, trinkgeld: tip });
    const items = Object.values(korb).map((e) => ({ qty: e.qty, vatSplit: B.splitVat(e, SK.einzelpreis(e) * e.qty) }));
    const o = { items, subtotal: sub, discount: aktion + gutschein + deal, dealDiscount: deal, loyaltyDiscount: treue, deliveryFee: liefer, tip, total, cartSnapshot: korb };
    const gc = Math.round(gutschein * 100);
    const x = S.aufteilung(o, { gutscheinCent: gc });
    if ([x.bezahlt[7], x.bezahlt[19], x.gutschein[7], x.gutschein[19]].some((v) => v < 0)) f.negativ++;
    if (x.bezahlt[7] + x.bezahlt[19] !== Math.round(total * 100)) f.summe++;
    if (gc && x.gutschein[7] + x.gutschein[19] !== gc) f.gutschein++;
    // Browser: Rabatt gesamt = Aktion + Gutschein + Treue, Deal getrennt (nur 7 %)
    const br = JSON.parse(JSON.stringify(B.buildVatSummary(korb, aktion + gutschein + treue, liefer, tip, deal)));
    const erw = { 7: 0, 19: 0 };
    br.forEach((z) => { erw[z.satz] = Math.round(z.brutto * 100); });
    const d7 = Math.abs(x.bezahlt[7] - erw[7]), d19 = Math.abs(x.bezahlt[19] - erw[19]);
    if (d7 > 1 || d19 > 1) { f.browser++; if (process.env.DBG) console.log(JSON.stringify({ sub, deal, aktion, gutschein, treue, liefer, tip, total, bezahlt: x.bezahlt, erw, rest: x.rest })); }
    if (d7 || d19) f.abweichend1++;
  }
  ok('2000 Zufallsbestellungen: kein Anteil negativ', f.negativ === 0, f);
  ok('2000 Zufallsbestellungen: Summe bezahlt = total auf den Cent', f.summe === 0, f);
  ok('2000 Zufallsbestellungen: Summe Gutschein = eingelöster Betrag auf den Cent', f.gutschein === 0, f);
  ok('2000 Zufallsbestellungen: 7-/19-%-Zeilen höchstens 1 Cent neben dem Browser (bekannte Gleitkomma-Abweichung bei Deals)', f.browser === 0, f);

  console.log('\n' + (fehler ? '❌ ' + fehler + ' von ' + n + ' Prüfungen fehlgeschlagen' : '✅ Alle ' + n + ' Prüfungen grün'));
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.log('Absturz:', e && e.stack); process.exit(1); });
