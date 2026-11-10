#!/usr/bin/env node
/**
 * werkzeug/geburtstag-deal-test.js
 * ----------------------------------------------------------------------------
 * Geburtstags-Deal 9.–14.11.2026: Burger + Pommes für 10 €, nur bei Abholung.
 *
 *   node werkzeug/geburtstag-deal-test.js
 *
 * Prüft die Regel in speisekarte.js, die Server-Nachrechnung in
 * lib/preisberechnung.js (inkl. Manipulation, Code-Sperre, Geschenkgutschein)
 * und die Steueraufstellung aus index.html: Der Deal darf nur den 7%-Anteil
 * mindern. Die Uhr wird auf feste Zeitpunkte gestellt, damit der Test auch
 * nach dem Aktionszeitraum dasselbe prüft.
 * ----------------------------------------------------------------------------
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const WURZEL = path.join(__dirname, '..');
const SK = require(path.join(WURZEL, 'speisekarte.js'));

/* Blob-Speicher im Arbeitsspeicher (Gutscheine) */
const DATEN = new Map();
const store = (name) => ({
  async get(k, o) { const v = DATEN.get(name + '|' + k); return v === undefined ? null : (o && o.type === 'json' ? JSON.parse(v) : v); },
  async setJSON(k, v) { DATEN.set(name + '|' + k, JSON.stringify(v)); return { modified: true }; },
  async set(k, v) { DATEN.set(name + '|' + k, String(v)); },
  async delete(k) { DATEN.delete(name + '|' + k); },
  async list({ prefix } = {}) { return { blobs: [...DATEN.keys()].filter((k) => k.startsWith(name + '|' + (prefix || ''))).map((k) => ({ key: k.slice(name.length + 1) })) }; },
});
const originalLoad = Module._load;
Module._load = function (anfrage, ...rest) {
  if (anfrage === '@netlify/blobs') return { getStore: (o) => store(typeof o === 'string' ? o : o.name) };
  return originalLoad.call(this, anfrage, ...rest);
};
delete process.env.NETLIFY_BLOBS_SITE_ID;
delete process.env.TELEGRAM_BOT_TOKEN;
const preis = require(path.join(WURZEL, 'netlify/functions/lib/preisberechnung.js'));

/* Uhr stellen */
const echtJetzt = Date.now;
const MITTWOCH = Date.UTC(2026, 10, 11, 12, 0, 0);          // im Zeitraum
const SONNTAG = Date.UTC(2026, 10, 15, 12, 0, 0);           // danach
const SA_2059 = Date.UTC(2026, 10, 14, 19, 59, 0);          // Sa 20:59 Berlin
const SA_2101 = Date.UTC(2026, 10, 14, 20, 1, 0);           // Sa 21:01 Berlin
const uhr = (ms) => { Date.now = () => ms; };

let ok = 0, fehler = 0;
function pruef(bed, text) { if (bed) ok++; else { fehler++; console.log('  FEHLER: ' + text); } }
const nah = (a, b) => Math.abs(a - b) < 0.005;

/* Bestellung so, wie der Browser sie schickt */
function bestellung(cart, modus, extra) {
  const w = SK.warenwert(cart);
  const deal = SK.dealRabatt(cart, modus);
  const fee = modus === 'delivery' ? 2.5 : 0;
  return Object.assign({
    reference: 'GNC-DEAL-' + Math.random().toString(36).slice(2, 8),
    mode: modus, payment: 'cash', cartSnapshot: cart,
    subtotal: w, discount: deal, dealDiscount: deal, loyaltyDiscount: 0,
    deliveryFee: fee, tip: 0, total: SK.gesamtbetrag({ warenwert: w, dealRabatt: deal, liefergebuehr: fee }),
    promo: null, voucherCode: null, email: 'gast@example.com',
  }, extra || {});
}

(async () => {
  const KLASSIK_POMMES = { classic: { menuId: 'classic', qty: 1 }, 'pommes__dip-mayo': { menuId: 'pommes', qty: 1, dip: 'dip-mayo' } };

  console.log('1. Regel (speisekarte.js)');
  uhr(MITTWOCH);
  pruef(nah(SK.dealRabatt(KLASSIK_POMMES, 'pickup'), 2), 'Classic 8 + Pommes 4 = 10 → 2 € Ersparnis');
  pruef(SK.dealRabatt(KLASSIK_POMMES, 'delivery') === 0, 'Lieferung: kein Deal');
  pruef(nah(SK.dealDetails(KLASSIK_POMMES, 'delivery').moeglich, 2), 'Lieferung: möglicher Deal wird genannt');
  pruef(SK.dealRabatt({ k: { menuId: 'kubis', qty: 1 }, p: { menuId: 'pommes', qty: 1 } }, 'pickup') === 0, 'Kubis Special ausgenommen');
  pruef(SK.dealRabatt({ c: { menuId: 'classic', qty: 1 }, s: { menuId: 'spommes', qty: 1 } }, 'pickup') === 0, 'Süßkartoffelpommes zählen nicht');
  pruef(nah(SK.warenwert({ c: { menuId: 'classic', qty: 1, double: true }, p: { menuId: 'pommes', qty: 1 } }) - SK.dealRabatt({ c: { menuId: 'classic', qty: 1, double: true }, p: { menuId: 'pommes', qty: 1 } }, 'pickup'), 12.5), 'Double Patty: 10 + 2,50');
  pruef(nah(SK.warenwert({ m: { menuId: 'whitebbq', qty: 1, isMenu: true, side: 'pommes', drink: 'fritz-kola', dip: 'dip-mayo' } }) - SK.dealRabatt({ m: { menuId: 'whitebbq', qty: 1, isMenu: true, side: 'pommes' } }, 'pickup'), 12.5), 'Menü mit Pommes: 10 + Getränk 2,50');
  const zwei = { a: { menuId: 'classic', qty: 1 }, b: { menuId: 'sucuk', qty: 1 }, p: { menuId: 'pommes', qty: 1 } };
  pruef(nah(SK.dealRabatt(zwei, 'pickup'), 3) && SK.dealDetails(zwei, 'pickup').offeneBurger === 1, 'zwei Burger, eine Pommes: teurerer Burger gepaart, einer offen');
  uhr(SA_2059); pruef(SK.dealRabatt(KLASSIK_POMMES, 'pickup') > 0, 'Samstag 20:59: Deal gilt noch');
  uhr(SA_2101); pruef(SK.dealRabatt(KLASSIK_POMMES, 'pickup') === 0, 'Samstag 21:01: Deal vorbei');
  uhr(SONNTAG); pruef(SK.dealRabatt(KLASSIK_POMMES, 'pickup') === 0, 'Sonntag: Deal vorbei');

  console.log('2. Server rechnet nach');
  uhr(MITTWOCH);
  let o = bestellung(KLASSIK_POMMES, 'pickup');
  let p = await preis.betragErmitteln(o);
  pruef(p.sicher && nah(p.betrag, 10) && nah(p.posten.dealRabatt, 2), 'Abholung: Server bestätigt 10 € (ist ' + p.betrag + ')');
  o = bestellung(KLASSIK_POMMES, 'delivery');
  p = await preis.betragErmitteln(o);
  pruef(nah(p.betrag, 14.5) && p.posten.dealRabatt === 0, 'Lieferung: 12 € + 2,50 € Gebühr (ist ' + p.betrag + ')');
  o = bestellung(KLASSIK_POMMES, 'delivery', { discount: 2, dealDiscount: 2, total: 12.5 });
  p = await preis.betragErmitteln(o);
  pruef(nah(p.betrag, 14.5), 'Manipuliert: Deal bei Lieferung behauptet → Server verlangt 14,50 (ist ' + p.betrag + ')');
  uhr(SONNTAG);
  o = bestellung(KLASSIK_POMMES, 'pickup', { discount: 2, dealDiscount: 2, total: 10 });
  p = await preis.betragErmitteln(o);
  pruef(nah(p.betrag, 12), 'Nach dem Zeitraum: Server verlangt 12 € (ist ' + p.betrag + ')');

  console.log('3. Codes und Geschenkgutscheine');
  uhr(MITTWOCH);
  DATEN.set('vouchers|c:GRILL5', JSON.stringify({ code: 'GRILL5', type: 'fixed', value: 5, minOrder: 20, active: true }));
  DATEN.set('vouchers|c:GNCGIFT01', JSON.stringify({ code: 'GNCGIFT01', type: 'fixed', value: 10, minOrder: 10, giftcard: true, active: true, maxUses: 1, uses: 0 }));
  const GROSS = { a: { menuId: 'classic', qty: 2 }, p: { menuId: 'pommes', qty: 2 } };   // 24 €, Deal 4 €
  o = bestellung(GROSS, 'pickup', { voucherCode: 'GRILL5', promo: { code: 'GRILL5' }, discount: 9, total: 15 });
  p = await preis.betragErmitteln(o);
  pruef(nah(p.betrag, 20) && p.posten.gutscheinRabatt === 0, 'GRILL5 neben dem Deal: zählt nicht, 20 € (ist ' + p.betrag + ')');
  o = bestellung(GROSS, 'pickup', { voucherCode: 'GNCGIFT01', promo: { code: 'GNCGIFT01' }, discount: 14, total: 10 });
  p = await preis.betragErmitteln(o);
  pruef(nah(p.betrag, 10) && nah(p.posten.gutscheinRabatt, 10), 'Geschenkgutschein neben dem Deal: gilt, 10 € (ist ' + p.betrag + ')');
  o = bestellung(GROSS, 'delivery', { voucherCode: 'GRILL5', promo: { code: 'GRILL5' }, discount: 5, total: 21.5 });
  p = await preis.betragErmitteln(o);
  pruef(nah(p.betrag, 21.5) && nah(p.posten.gutscheinRabatt, 5), 'Lieferung ohne Deal: GRILL5 gilt wie immer (ist ' + p.betrag + ')');

  console.log('4. Steueraufstellung: Deal mindert nur 7 %');
  const html = fs.readFileSync(path.join(WURZEL, 'index.html'), 'utf-8');
  const sv = html.indexOf('const VAT_FOOD = 7;');
  const sb = html.indexOf('/* ====', html.indexOf('function buildVatSummary'));
  const STEUER = new Function('MENU', 'entryUnitPrice', html.slice(sv, sb) + '\nreturn { splitVat, buildVatSummary };')(SK.MENU, SK.einzelpreis);
  const MIT_GETRAENK = { c: { menuId: 'classic', qty: 1 }, p: { menuId: 'pommes', qty: 1 }, d: { menuId: 'fritz-kola', qty: 1 } };   // 14,50
  const v = STEUER.buildVatSummary(MIT_GETRAENK, 0, 0, 0, 2);
  const v7 = v.find(x => x.satz === 7), v19 = v.find(x => x.satz === 19);
  pruef(v7 && nah(v7.brutto, 10), '7 %: 12 − 2 = 10 € (ist ' + (v7 && v7.brutto) + ')');
  pruef(v19 && nah(v19.brutto, 2.5), '19 %: Getränk bleibt 2,50 € (ist ' + (v19 && v19.brutto) + ')');
  const ohne = STEUER.buildVatSummary(MIT_GETRAENK, 0, 0, 0);
  pruef(nah(ohne.find(x => x.satz === 7).brutto, 12) && nah(ohne.find(x => x.satz === 19).brutto, 2.5), 'ohne Deal unverändert');
  const menue = { m: { menuId: 'cheese', qty: 1, isMenu: true, side: 'pommes', drink: 'fritz-kola', dip: 'dip-mayo' } };   // 13,50, Deal 1,00
  const vm = STEUER.buildVatSummary(menue, 0, 0, 0, SK.dealRabatt(menue, 'pickup'));
  pruef(nah(vm.find(x => x.satz === 7).brutto, 10) && nah(vm.find(x => x.satz === 19).brutto, 2.5), 'Menü im Deal: Speisen 10 €, Getränk 2,50 €');

  Date.now = echtJetzt;
  console.log('\n' + (fehler ? '✗ ' + fehler + ' Fehler, ' : '✓ ') + ok + ' Prüfungen bestanden');
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
