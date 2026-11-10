/**
 * werkzeug/preis-differenztest.js
 * ----------------------------------------------------------------------------
 * Beweist, dass die Serverrechnung und die Warenkorb-Anzeige nie auseinander-
 * gehen. Das ist die entscheidende Zusage hinter der Preisprüfung: Der Server
 * belastet Math.max(Browser, Server). Rechnete er auch nur einen Cent höher
 * als der Warenkorb anzeigt, würde jede ehrliche Bestellung stillschweigend
 * teurer – schlimmer als der Betrug, der damit verhindert werden soll.
 *
 * Der Test nimmt deshalb NICHT eine nachgebaute Formel, sondern die echten
 * Zeilen aus index.html: die Berechnung in submitOrder() wird als Text aus der
 * Datei geschnitten und ausgeführt. Ändert jemand dort etwas, ohne den Server
 * mitzuziehen, schlägt dieser Test an.
 *
 * Aufruf:  node werkzeug/preis-differenztest.js
 * Ausgang: 0 = alles deckungsgleich, 1 = Abweichung gefunden
 * ----------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const Module = require('module');

const WURZEL = path.join(__dirname, '..');
const SK = require(path.join(WURZEL, 'speisekarte.js'));

/* Attrappe für den Blob-Speicher, damit der Test ohne `npm install` und ohne
   Netlify läuft. Der Speicher ist hier leer: kein Gutschein existiert, kein
   Kundendatensatz. Genau die Lage, in der die Preisprüfung am strengsten sein
   muss – ein behaupteter Rabatt hat dann keine Deckung. */
const LEERER_SPEICHER = {
  async get() { return null; },
  async setJSON() {},
  async delete() {},
  async list() { return { blobs: [] }; },
};
/* preisberechnung.js holt sich getStore beim Laden per Destrukturierung. Ein
   spaeteres Austauschen von BLOB_ATTRAPPE.getStore wuerde dort nicht mehr
   ankommen – deshalb bleibt die Funktion fest und zeigt auf diese Variable. */
let speicher = LEERER_SPEICHER;
const BLOB_ATTRAPPE = { getStore: () => speicher };
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === '@netlify/blobs') return '@netlify/blobs';
  return origResolve.call(this, req, ...rest);
};
require.cache['@netlify/blobs'] = { id: '@netlify/blobs', exports: BLOB_ATTRAPPE, loaded: true };

/* ---------------------------------------------------------------------------
   1. Die echte Preisberechnung aus index.html holen
   Geschnitten wird zwischen zwei Ankern, die in der Datei stehen. Fehlt einer,
   bricht der Test ab – dann wurde umgebaut und der Test muss nachgezogen werden.
--------------------------------------------------------------------------- */
const html = fs.readFileSync(path.join(WURZEL, 'index.html'), 'utf-8');
// "const sub = cartSubtotal()" steht auch in voucherDiscount(); der Kommentar
// darueber ist der eindeutige Anker auf die Berechnung in submitOrder().
const ANFANG = '  // Calculate effective totals\n  const sub = cartSubtotal();';
const ENDE = '  // Build order summary';
const von = html.indexOf(ANFANG);
const bis = html.indexOf(ENDE, von);
if (von < 0 || bis < 0) {
  console.error('FEHLER: Die Preisberechnung in index.html wurde nicht gefunden.');
  console.error('Anker angepasst? Dann diesen Test nachziehen.');
  process.exit(2);
}
const FRONTEND_QUELLE = html.slice(von, bis);

/* Die Treue-Regel steht seit dem Menü aufs Haus (Oktober 2026) in einer
   eigenen Funktion loyaltyDiscount(). Auch die wird echt aus index.html
   geschnitten, nicht nachgebaut. */
const TREUE_ANFANG = 'function loyaltyDiscount() {';
const TREUE_ENDE = '\nfunction loyaltyLineLabel';
const tv = html.indexOf(TREUE_ANFANG), tb = html.indexOf(TREUE_ENDE, tv);
if (tv < 0 || tb < 0) {
  console.error('FEHLER: loyaltyDiscount() in index.html nicht gefunden. Test nachziehen.');
  process.exit(2);
}
const TREUE_QUELLE = html.slice(tv, tb);
const baueTreueRegel = new Function('z', `
  const { testPromoApplied, loyaltyApplied, loyaltyKind, getLoyalty, accountLoggedIn,
          SK, cart, cartSubtotal, LOYALTY_MIN_ORDER, LOYALTY_REWARD } = z;
  ${TREUE_QUELLE}
  return loyaltyDiscount;
`);

/* Geburtstags-Deal (November 2026): dealDiscount() samt Hilfsfunktionen,
   ebenfalls echt aus index.html geschnitten. */
const DEAL_ANFANG = 'function dealOhneMenuKey() {';
const DEAL_ENDE = 'return dealInfo().rabatt;\n}';
const dv = html.indexOf(DEAL_ANFANG), db = html.indexOf(DEAL_ENDE, dv);
if (dv < 0 || db < 0) {
  console.error('FEHLER: dealDiscount() in index.html nicht gefunden. Test nachziehen.');
  process.exit(2);
}
const DEAL_QUELLE = html.slice(dv, db + DEAL_ENDE.length);
const baueDealRegel = new Function('z', `
  const { testPromoApplied, loyaltyApplied, loyaltyKind, loyaltyDiscount, SK, cart, checkoutMode } = z;
  ${DEAL_QUELLE}
  return dealDiscount;
`);

/* Der Ausschnitt greift auf Zustand der Seite zu (cart, voucherApplied, …).
   Der wird hier gestellt, sonst unverändert ausgeführt. */
const frontendRechnung = new Function('zustand', `
  const { cartSubtotal, promoDiscountFor, voucherDiscount, loyaltyRewardAvailable,
          SK, PROMO_MIN_ORDER, LOYALTY_MIN_ORDER, LOYALTY_REWARD, TEST_TOTAL,
          effectivePromo, testPromoApplied, loyaltyApplied, checkoutMode,
          deliveryZone, pay, tipPercent, loyaltyDiscount, loyaltyKind, email, ACCOUNT,
          releaseCheckout, flashCartNotice, t, dealDiscount } = zustand;
${FRONTEND_QUELLE}
  return { sub, deal, disc, vDisc, loyDisc, fee, tip, total };
`);

/* ---------------------------------------------------------------------------
   2. Zufällige, aber realistische Warenkörbe
--------------------------------------------------------------------------- */
let saat = 20260816;
function zufall() {              // deterministisch, damit Fehler reproduzierbar sind
  saat = (saat * 1103515245 + 12345) & 0x7fffffff;
  return saat / 0x7fffffff;
}
const wahl = (arr) => arr[Math.floor(zufall() * arr.length)];
const zwischen = (a, b) => a + Math.floor(zufall() * (b - a + 1));

function baueWarenkorb() {
  const cart = {};
  const zeilen = zwischen(1, 6);
  for (let i = 0; i < zeilen; i++) {
    const item = wahl(SK.MENU);
    const istBurger = item.cat === 'burger';
    const darfDouble = istBurger && !SK.DOUBLE_PATTY_EXCLUDE_IDS.includes(item.id);
    const entry = {
      menuId: item.id,
      qty: zwischen(1, 4),
      double: darfDouble && zufall() < 0.4,
      isMenu: istBurger && zufall() < 0.4,
    };
    if (entry.isMenu) {
      entry.side = wahl(SK.MENU_SIDE_OPTIONS).id;
      entry.drink = wahl(SK.MENU_DRINK_IDS);
      entry.dip = wahl(SK.MENU_DIP_IDS);
    }
    cart['z' + i] = entry;
  }
  return cart;
}

/* ---------------------------------------------------------------------------
   3. Ein Durchgang: Frontend rechnen lassen, Bestellung daraus bauen,
      Server nachrechnen lassen, vergleichen.
--------------------------------------------------------------------------- */
const preis = require(path.join(WURZEL, 'netlify/functions/lib/preisberechnung.js'));

/* Ein angemeldetes Konto mit einem offenen Menü aufs Haus. Der Token hat die
   Form, die account.js ausgibt (48 Hex-Zeichen). */
const MENU_KONTO = { mail: 'menu@example.com', token: 'a1'.repeat(24) };
function menuKontoDatensatz(menus) {
  return { email: MENU_KONTO.mail, menus, rewards: 0, tokens: { [MENU_KONTO.token]: new Date().toISOString() } };
}

function frontendZustand(cart, fall) {
  const loyaltyDiscount = baueTreueRegel({
    testPromoApplied: false, loyaltyApplied: fall.treue, loyaltyKind: fall.art,
    getLoyalty: () => fall.art === 'menu' ? { spent: 0, menus: 1, bonus: 0, konto: true } : { spent: 0, menus: 0, bonus: 1, konto: false },
    accountLoggedIn: () => fall.art === 'menu',
    SK, cart, cartSubtotal: () => SK.warenwert(cart),
    LOYALTY_MIN_ORDER: SK.LOYALTY_MIN_ORDER, LOYALTY_REWARD: SK.LOYALTY_REWARD,
  });
  const dealDiscount = baueDealRegel({
    testPromoApplied: false, loyaltyApplied: fall.treue, loyaltyKind: fall.art,
    loyaltyDiscount, SK, cart, checkoutMode: fall.modus,
  });
  return {
    loyaltyDiscount,
    dealDiscount,
    loyaltyKind: fall.art,
    email: fall.art === 'menu' ? MENU_KONTO.mail : '',
    ACCOUNT: fall.art === 'menu' ? { email: MENU_KONTO.mail, token: MENU_KONTO.token } : null,
    releaseCheckout() {}, flashCartNotice() {}, t: (k) => k,
    SK,
    cartSubtotal: () => SK.warenwert(cart),
    promoDiscountFor: SK.promoDiscountFor,
    voucherDiscount: () => fall.vDisc,
    loyaltyRewardAvailable: () => fall.treueVerfuegbar,
    PROMO_MIN_ORDER: SK.PROMO_MIN_ORDER,
    LOYALTY_MIN_ORDER: SK.LOYALTY_MIN_ORDER,
    LOYALTY_REWARD: SK.LOYALTY_REWARD,
    TEST_TOTAL: SK.TEST_TOTAL,
    effectivePromo: fall.promo,
    testPromoApplied: false,
    loyaltyApplied: fall.treue,
    checkoutMode: fall.modus,
    deliveryZone: fall.modus === 'delivery' ? fall.zone : null,
    pay: fall.zahlung,
    tipPercent: fall.trinkgeldProzent,
  };
}

async function einDurchgang(nr) {
  const cart = baueWarenkorb();
  const fall = {
    promo: false,                                  // WM-Aktion ist abgelaufen
    vDisc: 0,                                      // Gutscheine: eigener Test unten
    treue: zufall() < 0.3,
    art: zufall() < 0.5 ? 'menu' : 'bonus',
    treueVerfuegbar: true,
    modus: zufall() < 0.5 ? 'delivery' : 'pickup',
    zone: wahl(SK.DELIVERY_ZONES),
    zahlung: zufall() < 0.7 ? 'sumup' : 'cash',
    trinkgeldProzent: wahl(SK.TIP_PERCENTS),
  };

  const f = frontendRechnung(frontendZustand(cart, fall));

  // Genau die Felder, die der Browser auch wirklich mitschickt
  const order = {
    reference: 'GNC-TEST-' + nr,
    mode: fall.modus,
    payment: fall.zahlung,
    cartSnapshot: cart,
    subtotal: f.sub,
    discount: f.disc + f.vDisc + f.deal,
    dealDiscount: f.deal,
    loyaltyDiscount: f.loyDisc,
    loyaltyApplied: f.loyDisc > 0,
    loyaltyType: f.loyDisc > 0 ? fall.art : null,
    kontoToken: f.loyDisc > 0 && fall.art === 'menu' ? MENU_KONTO.token : undefined,
    deliveryFee: f.fee,
    tip: f.tip,
    total: f.total,
    promo: null,
    voucherCode: null,
    // 5-€-Bonus: Gast ohne Konto -> wird durchgelassen. Menü: angemeldetes Konto.
    email: fall.art === 'menu' ? MENU_KONTO.mail : '',
  };

  // Für das Menü braucht der Server den Kundendatensatz mit gültigem Token
  speicher = fall.art === 'menu' ? speicherMit({ [MENU_KONTO.mail]: menuKontoDatensatz(1) }) : LEERER_SPEICHER;
  const p = await preis.betragErmitteln(order);
  speicher = LEERER_SPEICHER;
  const abweichung = Math.abs(p.betrag - f.total);
  return { nr, cart, fall, f, p, abweichung, ok: p.sicher && abweichung < 0.005 };
}

/* ---------------------------------------------------------------------------
   4. Angriffsfälle: hier MUSS der Server korrigieren
--------------------------------------------------------------------------- */
async function angriffe() {
  const cart = { a: { menuId: 'kubis', qty: 3, double: false, isMenu: false } };  // 33,00 €
  const echt = SK.warenwert(cart);
  const B = SK.LOYALTY_REWARD;   // 5,00 € – der eine Treuebonus, den es gibt

  /* Jeder Fall nennt den Betrag, der herauskommen MUSS. Ein pauschales
     "mindestens der Kartenpreis" waere hier falsch: Ein Gast ohne Konto hat
     seine Stempelkarte nur im Browser, der Server kann sie nicht gegenpruefen.
     Ihm den Bonus zu verweigern hiesse, ihm 5 € mehr abzubuchen, als der
     Warenkorb angezeigt hat. Deshalb ist die Regel nicht "kein Bonus", sondern
     "hoechstens der eine Bonus, den es gibt" – der Schaden ist auf 5 €
     gedeckelt, und kein ehrlicher Gast verliert etwas. Wo ein Kundendatensatz
     existiert, wird scharf geprueft (letzter Fall). */
  const faelle = [
    ['Gesamtbetrag auf 1 € gesetzt',      { total: 1.0 }, echt],
    ['Gesamtbetrag auf 0 € gesetzt',      { total: 0 }, echt],
    ['Rabatt von 30 € erfunden',          { total: echt - 30, discount: 30 }, echt],
    ['Treuebonus 25 € statt 5 €',         { total: echt - 25, loyaltyDiscount: 25, loyaltyApplied: true }, echt - B],
    ['Negative Liefergebühr',             { total: echt - 20, deliveryFee: -20, mode: 'delivery' }, echt],
    ['Gutschein ohne Deckung',            { total: echt - 20, voucherCode: 'GIBTESNICHT', discount: 20 }, echt],
    ['Trinkgeld negativ',                 { total: echt - 15, tip: -15 }, echt],
    ['Menge in der Position verdreht',    { total: 11.0, subtotal: 11.0 }, echt],
    ['Testbestellung ohne Code',          { total: 1.0, isTest: true }, echt],
    ['Testbestellung falscher Code',      { total: 1.0, isTest: true, testCode: 'FALSCH123' }, echt],
  ];
  const ergebnisse = [];
  for (const [name, patch, erwartet] of faelle) {
    const order = Object.assign({
      reference: 'GNC-ANGRIFF', mode: 'pickup', payment: 'sumup',
      cartSnapshot: cart, subtotal: echt, discount: 0, loyaltyDiscount: 0,
      deliveryFee: 0, tip: 0, total: echt, email: '',
    }, patch);
    const p = await preis.betragErmitteln(order);
    ergebnisse.push({
      name, gefordert: order.total, belastet: p.betrag, erwartet,
      abgewehrt: Math.abs(p.betrag - erwartet) < 0.005,
    });
  }
  return ergebnisse;
}

function speicherMit(konten, archiv) {
  const crypto = require('crypto');
  return {
    async get(key) {
      for (const [mail, rec] of Object.entries(konten)) {
        if (key === 'c:' + crypto.createHash('sha256').update(mail).digest('hex')) return rec;
      }
      if (archiv && archiv[key]) return archiv[key];
      return null;
    },
    async setJSON() {}, async delete() {}, async list() { return { blobs: [] }; },
  };
}

/* Menü aufs Haus: nur mit gültiger Anmeldung und offenem Menü auf dem Konto.
   Warenkorb: Cheeseburger-Menü (13,50 €) und Kubis Special einzeln (11,00 €).
   Gratis ist der Grundpreis des Menüs: 8,50 € + 5,00 € = 13,50 €. */
async function menupruefung() {
  const cart = {
    a: { menuId: 'cheese', qty: 1, double: false, isMenu: true, side: 'pommes', drink: 'fritz-kola', dip: 'dip-mayo' },
    b: { menuId: 'kubis', qty: 1, double: false, isMenu: false },
  };
  const echt = SK.warenwert(cart);
  const gratis = SK.gratisMenuWert(cart);
  const nurKubis = { a: { menuId: 'kubis', qty: 1, isMenu: true, side: 'pommes', drink: 'fritz-kola', dip: 'dip-mayo' } };
  const mitExtras = { a: { menuId: 'cheese', qty: 1, double: true, isMenu: true, side: 'spommes', drink: 'fritz-kola', dip: 'dip-mayo' } };
  const tok = MENU_KONTO.token, mail = MENU_KONTO.mail;
  const faelle = [
    ['Konto mit Menü, gültige Anmeldung',   { [mail]: menuKontoDatensatz(1) }, null, cart, tok, echt - gratis],
    ['Konto mit Menü, falscher Token',      { [mail]: menuKontoDatensatz(1) }, null, cart, 'b2'.repeat(24), echt],
    ['Konto mit Menü, ohne Token',          { [mail]: menuKontoDatensatz(1) }, null, cart, undefined, echt],
    ['Konto ohne offenes Menü',             { [mail]: menuKontoDatensatz(0) }, null, cart, tok, echt],
    ['Gast ohne Konto',                     {}, null, cart, tok, echt],
    ['Nur Kubis Special im Korb',           { [mail]: menuKontoDatensatz(1) }, null, nurKubis, tok, SK.warenwert(nurKubis)],
    ['Double Patty + Süßkartoffel zahlt Gast', { [mail]: menuKontoDatensatz(1) }, null, mitExtras, tok, SK.DOUBLE_PATTY_PRICE + 1.00],
    ['2. Lauf nach Einlösung (Archiv)',     { [mail]: menuKontoDatensatz(0) }, { 'o:GNC-MENU': { treueEingeloest: 'menu' } }, cart, undefined, echt - gratis],
  ];
  const out = [];
  for (const [was, konten, archiv, korb, token, erwartet] of faelle) {
    speicher = speicherMit(konten, archiv);
    const w = SK.warenwert(korb), g = SK.gratisMenuWert(korb);
    const p = await preis.betragErmitteln({
      reference: 'GNC-MENU', mode: 'pickup', payment: 'cash', cartSnapshot: korb,
      subtotal: w, discount: 0, loyaltyDiscount: g, loyaltyApplied: true, loyaltyType: 'menu',
      kontoToken: token, deliveryFee: 0, tip: 0, total: Math.max(0, w - g), email: mail,
    });
    out.push({ was, belastet: p.betrag, erwartet, ok: Math.abs(p.betrag - erwartet) < 0.005 });
  }
  speicher = LEERER_SPEICHER;
  return out;
}

/* Mit Kundendatensatz kann der Server den Treuebonus wirklich pruefen.
   Hier zwei Konten: eines mit Guthaben (Bonus gilt), eines ohne (Bonus faellt). */
async function treuepruefung() {
  const crypto = require('crypto');
  const cart = { a: { menuId: 'kubis', qty: 3, double: false, isMenu: false } };  // 33,00 €
  const echt = SK.warenwert(cart);
  const konten = {
    'mit@example.com': { rewards: 2 },
    'ohne@example.com': { rewards: 0 },
  };
  // Speicher-Attrappe fuer diesen Abschnitt: liefert die beiden Konten aus
  speicher = {
    async get(key) {
      for (const [mail, rec] of Object.entries(konten)) {
        if (key === 'c:' + crypto.createHash('sha256').update(mail).digest('hex')) return rec;
      }
      return null;
    },
    async setJSON() {}, async delete() {}, async list() { return { blobs: [] }; },
  };

  const out = [];
  for (const [mail, erwartet, was] of [
    ['mit@example.com',  echt - SK.LOYALTY_REWARD, 'Konto mit Guthaben -> Bonus gilt'],
    ['ohne@example.com', echt,                     'Konto ohne Guthaben -> Bonus faellt'],
  ]) {
    const p = await preis.betragErmitteln({
      reference: 'GNC-TREUE', mode: 'pickup', payment: 'sumup', cartSnapshot: cart,
      subtotal: echt, discount: 0, loyaltyDiscount: SK.LOYALTY_REWARD, loyaltyApplied: true,
      deliveryFee: 0, tip: 0, total: echt - SK.LOYALTY_REWARD, email: mail,
    });
    out.push({ was, belastet: p.betrag, erwartet, ok: Math.abs(p.betrag - erwartet) < 0.005 });
  }
  speicher = LEERER_SPEICHER;   // fuer die folgenden Abschnitte wieder leer
  return out;
}

/* ---------------------------------------------------------------------------
   4b. Kundenlimit je E-Mail UND Telefon, Wegwerf-Adressen (November 2026)
   GRILL5: 5 € ab 20 €, höchstens 3× pro Kunde. Es gilt das Maximum aus
   E-Mail- und Telefon-Zählung. Adressen von Wegwerfdiensten bekommen Codes
   mit Kundenlimit nicht. Verbindlich ist die Preisberechnung; voucher-check
   sagt es dem Kunden vorher.
--------------------------------------------------------------------------- */
async function kundenlimitpruefung() {
  const crypto = require('crypto');
  const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
  const roh = new Map();
  const gemeinsam = {
    async get(k) { return roh.has(k) ? JSON.parse(roh.get(k)) : null; },
    async setJSON(k, v) { roh.set(k, JSON.stringify(v)); },
    async delete(k) { roh.delete(k); },
    async list() { return { blobs: [] }; },
  };
  speicher = gemeinsam;
  const seit = '2026-07-20T00:00:00.000Z';
  const GRILL5 = { code: 'GRILL5', type: 'fixed', value: 5, minOrder: 20, maxUses: 0, maxPerCustomer: 3,
    combinable: false, mode: 'any', active: true, createdAt: seit, createdBy: 'Admin', uses: 0, usedBy: {} };
  roh.set('c:GRILL5', JSON.stringify(GRILL5));
  roh.set('c:FREI10', JSON.stringify({ ...GRILL5, code: 'FREI10', maxPerCustomer: 0 }));
  const zaehlerSetzen = (art, wert, n) => roh.set((art === 'mail' ? 'n:GRILL5:' : 't:GRILL5:') + sha(wert), JSON.stringify({ seit, n }));
  zaehlerSetzen('mail', 'dreimal@example.com', 3);
  zaehlerSetzen('tel', '491701234567', 3);
  zaehlerSetzen('mail', 'einmal@example.com', 1);
  zaehlerSetzen('tel', '491709998887', 2);

  const cart = { a: { menuId: 'kubis', qty: 2, double: false, isMenu: false } };   // 22,00 €
  const echt = SK.warenwert(cart);
  const faelle = [
    ['Neue E-Mail, neue Nummer: Rabatt gilt',              'GRILL5', 'neu@example.com',       '0171 2223334',        echt - 5, null],
    ['E-Mail schon 3×: kein Rabatt',                       'GRILL5', 'dreimal@example.com',   '',                    echt, 'kundenlimit'],
    ['Neue E-Mail, Nummer schon 3×: kein Rabatt',          'GRILL5', 'frisch@example.com',    '+49 (0) 170 123 4567', echt, 'kundenlimit'],
    ['Nummer anders geschrieben (0049 …): kein Rabatt',    'GRILL5', 'frisch2@example.com',   '0049 170 1234567',    echt, 'kundenlimit'],
    ['E-Mail 1×, Nummer 2×: Maximum 2, Rabatt gilt',        'GRILL5', 'einmal@example.com',    '0170 9998887',        echt - 5, null],
    ['Wegwerf-Adresse: kein Rabatt',                        'GRILL5', 'x@mailinator.com',      '',                    echt, 'wegwerf'],
    ['Wegwerf als Subdomain: kein Rabatt',                  'GRILL5', 'x@neu.guerrillamail.de', '',                   echt, 'wegwerf'],
    ['Wegwerf, aber Code ohne Kundenlimit: Rabatt gilt',    'FREI10', 'x@yopmail.com',         '',                    echt - 5, null],
  ];
  const out = [];
  for (const [was, code, email, phone, erwartet, grund] of faelle) {
    const p = await preis.betragErmitteln({
      reference: 'GNC-LIMIT', mode: 'pickup', payment: 'cash', cartSnapshot: cart, subtotal: echt,
      discount: 5, voucherCode: code, loyaltyDiscount: 0, deliveryFee: 0, tip: 0, total: echt - 5, email, phone,
    });
    const g = p.gutscheinGesperrt ? p.gutscheinGesperrt.grund : null;
    out.push({ was, belastet: p.betrag, erwartet, ok: Math.abs(p.betrag - erwartet) < 0.005 && g === grund });
  }

  // Zweiter Lauf derselben Bestellung nach dem Zählen: gilt wie beim ersten
  roh.set('o:GNC-ZWEITER', JSON.stringify({ gutscheinGezaehlt: 'GRILL5' }));
  const zweiter = await preis.betragErmitteln({
    reference: 'GNC-ZWEITER', mode: 'pickup', payment: 'sumup', cartSnapshot: cart, subtotal: echt,
    discount: 5, voucherCode: 'GRILL5', loyaltyDiscount: 0, deliveryFee: 0, tip: 0, total: echt - 5,
    email: 'dreimal@example.com', phone: '01701234567',
  });
  out.push({ was: '2. Lauf nach dem Zählen (Archiv): Rabatt bleibt', belastet: zweiter.betrag, erwartet: echt - 5, ok: Math.abs(zweiter.betrag - (echt - 5)) < 0.005 });

  // voucher-check sagt es dem Kunden vorher (echter Handler, gleicher Speicher)
  const vc = require(path.join(WURZEL, 'netlify/functions/voucher-check.js'));
  const pruef = async (body) => JSON.parse((await vc.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) })).body);
  for (const [was, body, soll] of [
    ['voucher-check: Wegwerf-Adresse -> wegwerf',          { code: 'grill5', email: 'a@trashmail.de' },                        'wegwerf'],
    ['voucher-check: Subdomain eines Wegwerfdienstes',     { code: 'GRILL5', email: 'a@b.yopmail.com' },                       'wegwerf'],
    ['voucher-check: Nummer schon 3× -> customer_limit',  { code: 'GRILL5', email: 'ganz.neu@example.com', phone: '0170 1234567' }, 'customer_limit'],
    ['voucher-check: neue Kundin -> gültig',               { code: 'GRILL5', email: 'ganz.neu@example.com', phone: '0171 0001112' }, true],
  ]) {
    const d = await pruef(body);
    const ist = d.valid === true ? true : d.reason;
    out.push({ was, belastet: null, erwartet: null, ist, soll, ok: ist === soll });
  }
  speicher = LEERER_SPEICHER;
  return out;
}

/* ---------------------------------------------------------------------------
   5. Testbestellung MIT gültigem Code muss weiter 1 € kosten
--------------------------------------------------------------------------- */
async function testbestellung() {
  const cart = { a: { menuId: 'kubis', qty: 5, double: false, isMenu: false } };
  /* Der Code kommt ausschliesslich aus TEST_ORDER_CODE – einen Rueckfall auf
     einen fest verdrahteten Wert gibt es bewusst nicht mehr. Fuer den Test
     wird die Variable deshalb hier gesetzt. */
  const code = 'TESTLAUF-' + 'GNC2026';
  process.env.TEST_ORDER_CODE = code;
  const p = await preis.betragErmitteln({
    reference: 'GNC-TEST', mode: 'pickup', payment: 'sumup', cartSnapshot: cart,
    subtotal: SK.warenwert(cart), discount: 0, loyaltyDiscount: 0, deliveryFee: 0,
    tip: 0, total: SK.TEST_TOTAL, isTest: true, testCode: code, email: '',
  });
  const mitCode = { betrag: p.betrag, test: p.test, ok: p.test === true && Math.abs(p.betrag - 1.0) < 0.005 };

  /* Und die Gegenprobe: ohne gesetzte Variable gibt es keine Testbestellung.
     Frueher stand hier ein Rueckfall auf den alten, oeffentlich bekannten
     Code – wer die Variable loescht, soll nicht stillschweigend wieder eine
     1-€-Hintertuer haben. */
  const gemerkt = process.env.TEST_ORDER_CODE;
  delete process.env.TEST_ORDER_CODE;
  const ohne = await preis.betragErmitteln({
    reference: 'GNC-TEST', mode: 'pickup', payment: 'sumup', cartSnapshot: cart,
    subtotal: SK.warenwert(cart), discount: 0, loyaltyDiscount: 0, deliveryFee: 0,
    tip: 0, total: SK.TEST_TOTAL, isTest: true, testCode: 'TESTGNC1', email: '',
  });
  process.env.TEST_ORDER_CODE = gemerkt;
  mitCode.ohneVariable = ohne.betrag;
  mitCode.ohneOk = ohne.test !== true && Math.abs(ohne.betrag - SK.warenwert(cart)) < 0.005;
  mitCode.ok = mitCode.ok && mitCode.ohneOk;
  return mitCode;
}

/* ---------------------------------------------------------------------------
   6. Ausfallsicherheit: ohne Warenkorb / mit unbekanntem Artikel darf NICHT
      korrigiert werden – sonst bräche eine ehrliche Bestellung.
--------------------------------------------------------------------------- */
async function ausfallsicherheit() {
  const faelle = [
    ['Kein Warenkorb mitgeschickt', { cartSnapshot: null, total: 42.5 }],
    ['Leerer Warenkorb', { cartSnapshot: {}, total: 42.5 }],
    ['Artikel nicht auf der Karte (alter Cache)', { cartSnapshot: { a: { menuId: 'gibtsnicht', qty: 1 } }, total: 42.5 }],
    ['Unsinnige Menge', { cartSnapshot: { a: { menuId: 'classic', qty: -5 } }, total: 42.5 }],
  ];
  const out = [];
  for (const [name, patch] of faelle) {
    const p = await preis.betragErmitteln(Object.assign({
      reference: 'GNC-FALLBACK', mode: 'pickup', payment: 'cash', email: '',
    }, patch));
    out.push({ name, sicher: p.sicher, betrag: p.betrag, grund: p.grund, ok: !p.sicher && Math.abs(p.betrag - 42.5) < 0.005 });
  }
  return out;
}

/* ------------------------------- Ablauf ---------------------------------- */
(async () => {
  const DURCHGAENGE = 3000;
  console.log('\n1) DECKUNGSGLEICHHEIT – echte Frontend-Rechnung gegen Serverrechnung');
  console.log('   Quelle: index.html, ' + FRONTEND_QUELLE.split('\n').length + ' Zeilen unverändert ausgeführt\n');

  let fehler = 0, groessteAbweichung = 0, beispiel = null;
  for (let i = 0; i < DURCHGAENGE; i++) {
    const r = await einDurchgang(i);
    if (r.abweichung > groessteAbweichung) groessteAbweichung = r.abweichung;
    if (!r.ok) { fehler++; if (!beispiel) beispiel = r; }
  }
  console.log('   ' + DURCHGAENGE + ' zufällige Warenkörbe · Abweichungen: ' + fehler
    + ' · größte Differenz: ' + groessteAbweichung.toFixed(6) + ' €');
  if (beispiel) {
    console.log('   Erster Fehlerfall:');
    console.log('     Warenkorb:  ' + JSON.stringify(beispiel.cart));
    console.log('     Frontend:   ' + JSON.stringify(beispiel.f));
    console.log('     Server:     ' + JSON.stringify(beispiel.p.posten) + ' -> ' + beispiel.p.betrag);
  }
  console.log('   ' + (fehler === 0 ? '✅ deckungsgleich – ehrliche Bestellungen werden nie korrigiert'
                                    : '❌ Abweichungen gefunden'));

  console.log('\n2) MANIPULIERTE BESTELLUNGEN – hier MUSS korrigiert werden');
  console.log('   Warenkorb: 3× Kubis Special = 33,00 €\n');
  const ang = await angriffe();
  for (const a of ang) {
    console.log('   ' + a.name.padEnd(32)
      + 'gefordert ' + String(a.gefordert.toFixed(2)).padStart(6) + ' €'
      + ' -> belastet ' + String(a.belastet.toFixed(2)).padStart(6) + ' €'
      + ' (soll ' + a.erwartet.toFixed(2) + ')  '
      + (a.abgewehrt ? '✅' : '❌'));
  }
  const angFehler = ang.filter(a => !a.abgewehrt).length;
  console.log('   ' + (angFehler === 0 ? '✅ alle abgewehrt' : '❌ ' + angFehler + ' durchgelassen'));

  console.log('\n2b) TREUEBONUS gegen den Kundendatensatz\n');
  const tp = await treuepruefung();
  for (const a of tp) {
    console.log('   ' + a.was.padEnd(42) + 'belastet ' + a.belastet.toFixed(2)
      + ' € (soll ' + a.erwartet.toFixed(2) + ')  ' + (a.ok ? '✅' : '❌'));
  }
  const tpFehler = tp.filter(a => !a.ok).length;

  console.log('\n2c) MENÜ AUFS HAUS gegen Konto und Anmeldung\n');
  const mp = await menupruefung();
  for (const a of mp) {
    console.log('   ' + a.was.padEnd(42) + 'belastet ' + a.belastet.toFixed(2)
      + ' € (soll ' + a.erwartet.toFixed(2) + ')  ' + (a.ok ? '✅' : '❌'));
  }
  const mpFehler = mp.filter(a => !a.ok).length;

  console.log('\n2d) KUNDENLIMIT je E-Mail und Telefon, Wegwerf-Adressen (GRILL5)\n');
  const kl = await kundenlimitpruefung();
  for (const a of kl) {
    console.log('   ' + a.was.padEnd(52) + (a.belastet != null
      ? 'belastet ' + a.belastet.toFixed(2) + ' € (soll ' + a.erwartet.toFixed(2) + ')  '
      : 'Antwort ' + String(a.ist).padEnd(15) + '  ') + (a.ok ? '✅' : '❌'));
  }
  const klFehler = kl.filter(a => !a.ok).length;

  console.log('\n3) TESTBESTELLUNG mit gültigem Code\n');
  const t = await testbestellung();
  console.log('   mit gueltigem Code:  Warenkorb 55,00 € -> belastet ' + t.betrag.toFixed(2)
    + ' €  ' + (Math.abs(t.betrag - 1) < 0.005 ? '✅' : '❌'));
  console.log('   ohne die Variable:   Warenkorb 55,00 € -> belastet ' + t.ohneVariable.toFixed(2)
    + ' €  ' + (t.ohneOk ? '✅ keine Hintertuer' : '❌ 1-€-Tuer offen'));

  console.log('\n4) AUSFALLSICHERHEIT – nicht rechenbar heißt: nicht anfassen\n');
  const af = await ausfallsicherheit();
  for (const a of af) {
    console.log('   ' + a.name.padEnd(42) + (a.grund || '-').padEnd(20)
      + 'Betrag bleibt ' + a.betrag.toFixed(2) + ' €  ' + (a.ok ? '✅' : '❌'));
  }
  const afFehler = af.filter(a => !a.ok).length;

  const gesamt = fehler + angFehler + tpFehler + mpFehler + klFehler + (t.ok ? 0 : 1) + afFehler;
  console.log('\n' + '─'.repeat(74));
  console.log(gesamt === 0
    ? 'ERGEBNIS: ✅ Alles deckungsgleich, alle Manipulationen abgewehrt, kein Abbruchrisiko.'
    : 'ERGEBNIS: ❌ ' + gesamt + ' Problem(e).');
  process.exit(gesamt === 0 ? 0 : 1);
})();
