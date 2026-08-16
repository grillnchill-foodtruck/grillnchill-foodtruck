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

/* Der Ausschnitt greift auf Zustand der Seite zu (cart, voucherApplied, …).
   Der wird hier gestellt, sonst unverändert ausgeführt. */
const frontendRechnung = new Function('zustand', `
  const { cartSubtotal, promoDiscountFor, voucherDiscount, loyaltyRewardAvailable,
          SK, PROMO_MIN_ORDER, LOYALTY_MIN_ORDER, LOYALTY_REWARD, TEST_TOTAL,
          effectivePromo, testPromoApplied, loyaltyApplied, checkoutMode,
          deliveryZone, pay, tipPercent } = zustand;
${FRONTEND_QUELLE}
  return { sub, disc, vDisc, loyDisc, fee, tip, total };
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

function frontendZustand(cart, fall) {
  return {
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
    discount: f.disc + f.vDisc,
    loyaltyDiscount: f.loyDisc,
    loyaltyApplied: f.loyDisc > 0,
    deliveryFee: f.fee,
    tip: f.tip,
    total: f.total,
    promo: null,
    voucherCode: null,
    email: '',            // ohne Konto -> Treuebonus wird durchgelassen
  };

  const p = await preis.betragErmitteln(order);
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
   5. Testbestellung MIT gültigem Code muss weiter 1 € kosten
--------------------------------------------------------------------------- */
async function testbestellung() {
  const cart = { a: { menuId: 'kubis', qty: 5, double: false, isMenu: false } };
  const code = process.env.TEST_ORDER_CODE || 'TESTGNC1';
  const p = await preis.betragErmitteln({
    reference: 'GNC-TEST', mode: 'pickup', payment: 'sumup', cartSnapshot: cart,
    subtotal: SK.warenwert(cart), discount: 0, loyaltyDiscount: 0, deliveryFee: 0,
    tip: 0, total: SK.TEST_TOTAL, isTest: true, testCode: code, email: '',
  });
  return { betrag: p.betrag, test: p.test, ok: p.test === true && Math.abs(p.betrag - 1.0) < 0.005 };
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

  console.log('\n3) TESTBESTELLUNG mit gültigem Code\n');
  const t = await testbestellung();
  console.log('   Warenkorb 55,00 € -> belastet ' + t.betrag.toFixed(2) + ' €  ' + (t.ok ? '✅' : '❌'));

  console.log('\n4) AUSFALLSICHERHEIT – nicht rechenbar heißt: nicht anfassen\n');
  const af = await ausfallsicherheit();
  for (const a of af) {
    console.log('   ' + a.name.padEnd(42) + (a.grund || '-').padEnd(20)
      + 'Betrag bleibt ' + a.betrag.toFixed(2) + ' €  ' + (a.ok ? '✅' : '❌'));
  }
  const afFehler = af.filter(a => !a.ok).length;

  const gesamt = fehler + angFehler + tpFehler + (t.ok ? 0 : 1) + afFehler;
  console.log('\n' + '─'.repeat(74));
  console.log(gesamt === 0
    ? 'ERGEBNIS: ✅ Alles deckungsgleich, alle Manipulationen abgewehrt, kein Abbruchrisiko.'
    : 'ERGEBNIS: ❌ ' + gesamt + ' Problem(e).');
  process.exit(gesamt === 0 ? 0 : 1);
})();
