/* ====================================================================
   GRILL'N CHILL – SPEISEKARTE & PREISREGELN
   ====================================================================

   Diese Datei ist die EINZIGE Quelle für Preise. Sie wird von beiden
   Seiten geladen:

     Browser          <script src="speisekarte.js"> in index.html
     Netlify-Function require('../../speisekarte.js')

   WARUM DAS SO SEIN MUSS
   ----------------------
   Der Betrag, der bei SumUp belastet wird, wurde früher aus dem
   mitgeschickten order.total übernommen. Der kam aus dem Browser und war
   damit frei setzbar – eine veränderte Anfrage konnte 1 € für eine
   50-€-Bestellung zahlen. Seit netlify/functions/lib/preisberechnung.js
   rechnet der Server den Betrag selbst aus dem Warenkorb nach.

   Damit das trägt, müssen beide Seiten mit denselben Zahlen rechnen.
   Zwei Kopien der Preisliste – eine im Browser, eine im Server – würden
   früher oder später auseinanderlaufen: Kubi ändert einen Preis an einer
   Stelle, der Server rechnet weiter mit dem alten, und plötzlich weicht
   jede Bestellung ab. Deshalb liegt hier alles genau einmal, inklusive
   der Rechenfunktionen selbst (einzelpreis, warenwert, gesamtbetrag).
   Client und Server führen buchstäblich denselben Code aus.

   PREISE ÄNDERN
   -------------
   Nur in diesem File. Sonst nirgends. Nach der Änderung in sw.js die
   CACHE_VERSION hochzählen, damit niemand die alte Karte im Cache behält.
   ==================================================================== */

(function (wurzel, fabrik) {
  if (typeof module === 'object' && module.exports) module.exports = fabrik();
  else wurzel.SPEISEKARTE = fabrik();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ==================================================================
     KARTE – Namen, Beschreibungen, Preise hier anpassen
     ================================================================== */
  const MENU = [
    // BURGER (mit Fleisch)
    { id: 'classic',     cat: 'burger', emoji: '🍔', image: 'produktbilder/classic.webp', name: "Classic Burger",       desc: "100% Beef-Patty, Salat, Tomate, Zwiebel, Hausgemachte Burgersauce", price: 8.00, allergens: '1, 10', tag: null },
    { id: 'cheese',      cat: 'burger', emoji: '🍔', image: 'produktbilder/cheese.webp', name: "Cheeseburger",         desc: "Beef-Patty mit Käse, Salat, Tomate, Zwiebel, Burgersauce", price: 8.50, allergens: '1, 7, 10', tag: { label: 'BELIEBT', class: 'popular' } },
    { id: 'chilicheese', cat: 'burger', emoji: '🌶️', image: 'produktbilder/chilicheese.webp', name: "Chili-Cheese-Burger",  desc: "Beef-Patty, Käse, Jalapeños, scharfe Sauce, Salat", price: 9.00, allergens: '1, 7, 10', tag: { label: 'SCHARF', class: 'spicy' } },
    { id: 'whitebbq',    cat: 'burger', emoji: '🍔', image: 'produktbilder/whitebbq.webp', name: "White BBQ Burger",     desc: "Beef-Patty mit Champignons, Käse, White-BBQ-Sauce, Salat", price: 9.00, allergens: '1, 7, 10', tag: null },
    { id: 'crispy',      cat: 'burger', emoji: '🍗', image: 'produktbilder/crispy.webp', name: "Crispy Chicken Burger", desc: "Knusprig panierte Hähnchenbrust, Salat, Tomate, Sauce", price: 9.00, allergens: '1, 10', spuren: '3', tag: null },
    { id: 'sucuk',       cat: 'burger', emoji: '🌶️', image: 'produktbilder/sucuk.webp', name: "Sucuk Burger",         desc: "Beef-Patty mit pikanter Sucuk, Käse, Salat, Sauce", price: 9.00, allergens: '1, 7, 10', tag: null },
    { id: 'kubis',       cat: 'burger', emoji: '👑', image: 'produktbilder/kubis.webp', name: "Kubis Special",         desc: "Smashburger, Double Patty, mit Käse, Special-Topping", price: 11.00, allergens: '1, 7, 10', tag: { label: 'CHEF-EMPFEHLUNG', class: 'new' } },

    // VEGGIE / VEGAN BURGER (100% Gemüse-Patty, eigene Produkte)
    { id: 'classic-veg',     cat: 'burger', emoji: '🌱', image: 'produktbilder/classic.webp', name: "Classic Burger (Veggie/Vegan)",      desc: "100% Gemüse-Patty, Salat, Tomate, Zwiebel, Hausgemachte Burgersauce", price: 8.00, allergens: '1, 10', veggie: true, vegan: true, tag: { label: 'VEGGIE', class: 'veggie' } },
    { id: 'cheese-veg',      cat: 'burger', emoji: '🌱', image: 'produktbilder/cheese.webp', name: "Cheeseburger (Veggie/Vegan)",        desc: "100% Gemüse-Patty mit veganem Käse, Salat, Tomate, Zwiebel, Burgersauce", price: 8.50, allergens: '1, 7, 10', veggie: true, vegan: true, tag: { label: 'VEGGIE', class: 'veggie' } },
    { id: 'chilicheese-veg', cat: 'burger', emoji: '🌱', image: 'produktbilder/chilicheese.webp', name: "Chili-Cheese-Burger (Veggie/Vegan)", desc: "100% Gemüse-Patty, veganer Käse, Jalapeños, scharfe Sauce, Salat", price: 9.00, allergens: '1, 7, 10', veggie: true, vegan: true, tag: { label: 'VEGGIE', class: 'veggie' } },
    { id: 'whitebbq-veg',    cat: 'burger', emoji: '🌱', image: 'produktbilder/whitebbq.webp', name: "White BBQ Burger (Veggie/Vegan)",    desc: "100% Gemüse-Patty mit Champignons, veganer Käse, White-BBQ-Sauce, Salat", price: 9.00, allergens: '1, 7, 10', veggie: true, vegan: true, tag: { label: 'VEGGIE', class: 'veggie' } },

    // SNACKS & BEILAGEN
    { id: 'nug6',        cat: 'sides', emoji: '🍗', image: 'produktbilder/nuggets.webp', name: "6er Chicken Nuggets",   desc: "Knusprig paniert, mit Dip nach Wahl", price: 4.00, allergens: '1', spuren: '3, 6', includesDip: true, tag: null },
    { id: 'nug9',        cat: 'sides', emoji: '🍗', image: 'produktbilder/nuggets.webp', name: "9er Chicken Nuggets",   desc: "Knusprig paniert, mit Dip nach Wahl", price: 5.00, allergens: '1', spuren: '3, 6', includesDip: true, tag: { label: 'BELIEBT', class: 'popular' } },
    { id: 'nug20',       cat: 'sides', emoji: '🍗', image: 'produktbilder/nuggets.webp', name: "20er Chicken Nuggets",  desc: "Knusprig paniert, mit Dip nach Wahl – perfekt zum Teilen", price: 10.00, allergens: '1', spuren: '3, 6', includesDip: true, tag: { label: 'TO SHARE', class: 'new' } },
    { id: 'pommes',      cat: 'sides', emoji: '🍟', image: 'produktbilder/pommes.webp', name: "Pommes",                desc: "Knusprige goldbraune Pommes inkl. 1 Dip", price: 4.00, veggie: true, vegan: true, includesDip: true, tag: { label: 'VEGGIE', class: 'veggie' } },
    { id: 'spommes',     cat: 'sides', emoji: '🍠', image: 'produktbilder/spommes.webp', name: "Süßkartoffelpommes",    desc: "Knusprig frittiert inkl. 1 Dip", price: 5.00, veggie: true, vegan: true, includesDip: true, tag: { label: 'VEGGIE', class: 'veggie' } },

    // DIPS
    { id: 'dip-mayo',    cat: 'dips', emoji: '🥚', name: "Dip: Mayo",              desc: "Cremige Mayonnaise", price: 0.50, allergens: '3', tag: null },
    { id: 'dip-ket',     cat: 'dips', emoji: '🍅', name: "Dip: Ketchup",           desc: "Klassischer Tomaten-Ketchup", price: 0.50, tag: null },
    { id: 'dip-mango',   cat: 'dips', emoji: '🥭', name: "Dip: Mango-Curry",       desc: "Fruchtig-würzig", price: 0.50, tag: null },
    { id: 'dip-sweetsour', cat: 'dips', emoji: '🍯', name: "Dip: Süß-Sauer",        desc: "Asia-Style", price: 0.50, tag: null },

    // GETRÄNKE
    { id: 'fritz-kola',  cat: 'drinks', emoji: '🥤', image: 'produktbilder/fritz-kola.webp', name: "Fritz Kola",            desc: "0,33 l Flasche", price: 2.50, liter: 0.33, zusatz: '11', tag: null },
    { id: 'fritz-or',    cat: 'drinks', emoji: '🍊', image: 'produktbilder/fritz-or.webp', name: "Fritz Orange",          desc: "0,33 l Flasche", price: 2.50, liter: 0.33, tag: null },
    { id: 'fritz-zero',  cat: 'drinks', emoji: '🥤', image: 'produktbilder/fritz-zero.webp', name: "Fritz Kola Super Zero", desc: "0,33 l Flasche, zuckerfrei", price: 2.50, liter: 0.33, zusatz: '9, 11', tag: null },
  ];

  // Burger die als Veggie / Vegan verfügbar sind (Hinweis auf Produkt-Karten)
  const VEGGIE_AVAILABLE_IDS = ['classic', 'cheese', 'chilicheese', 'whitebbq'];

  // Aufpreis für Double Patty (bei allen Burgern wählbar, außer Kubis Special – ist schon Double)
  const DOUBLE_PATTY_PRICE = 2.50;
  const DOUBLE_PATTY_EXCLUDE_IDS = ['kubis']; // diese Burger haben keinen Toggle (schon Double)

  // MENÜ: Jeder Burger kann zum Menü gemacht werden (Burger + Beilage + Getränk + Dip).
  // Der Kunde wählt im Konfigurator Beilage, Getränk und Dip.
  const MENU_SURCHARGE = 5.00;                        // Aufpreis fürs Menü (Beilage + Getränk + Dip)
  const MENU_DRINK_IDS = ['fritz-kola', 'fritz-or', 'fritz-zero'];  // wählbare Getränke
  const MENU_DIP_IDS = ['dip-mayo', 'dip-ket', 'dip-mango', 'dip-sweetsour']; // wählbare Dips
  // Wählbare Beilagen: Pommes inkl., Süßkartoffelpommes gegen Aufpreis
  const MENU_SIDE_OPTIONS = [
    { id: 'pommes',  label: 'Pommes',             emoji: '🍟', surcharge: 0.00 },
    { id: 'spommes', label: 'Süßkartoffelpommes', emoji: '🍠', surcharge: 1.00 },
  ];

  /* ==================================================================
     AKTIONSCODE (gestaffelter Prozentrabatt)
     ================================================================== */
  const PROMO_CODE = 'WM';
  // Gestaffelter Rabatt: 10 % ab 20 €, 15 % ab 50 €, 20 % ab 100 € Warenwert.
  const PROMO_TIERS = [
    { min: 100.00, pct: 20 },
    { min: 50.00,  pct: 15 },
    { min: 20.00,  pct: 10 },
  ];
  const PROMO_MIN_ORDER = 20.00;    // Einstieg: ab 20 € Bestellwert
  // Aktionszeitraum WM 2026: gültig bis einschließlich 20.07.2026 (ein Tag nach dem Finale am 19.07.2026).
  const PROMO_VALID_UNTIL = new Date(2026, 6, 21, 0, 0, 0); // exklusiv → gilt bis 20.07.2026 23:59 Uhr
  const PROMO_VALID_UNTIL_LABEL = '20.07.2026';
  function promoActive() { return Date.now() < PROMO_VALID_UNTIL.getTime(); }
  // Ab 20.07.2026 bewerben wir im Warenkorb GRILL5 (5 € ab 20 €), davor die WM-Aktion.
  const GRILL5_START = new Date(2026, 6, 20, 0, 0, 0);
  // GRILL5 laeuft ab Start ohne Enddatum weiter. Enddatum hier setzen, falls gewuenscht (z.B. new Date(2026,11,31)).
  const GRILL5_UNTIL = null;
  function grill5Active() { return Date.now() >= GRILL5_START.getTime() && (!GRILL5_UNTIL || Date.now() < GRILL5_UNTIL.getTime()); }
  function adCode() { return Date.now() >= GRILL5_START.getTime() ? 'GRILL5' : (promoActive() ? 'WM' : 'GRILL5'); }
  // Liefert den Rabatt-Prozentsatz für einen Warenwert (0, wenn unter Einstieg).
  function promoTierPercent(subtotal) {
    for (const tier of PROMO_TIERS) {
      if (subtotal >= tier.min) return tier.pct;
    }
    return 0;
  }
  // Rabattbetrag in € für einen gegebenen Warenwert.
  function promoDiscountFor(subtotal) {
    const pct = promoTierPercent(subtotal);
    if (pct === 0) return 0;
    return Math.round(subtotal * pct) / 100;
  }

  /* ==================================================================
     TREUE, LIEFERZONEN, TRINKGELD, TESTBESTELLUNG
     ================================================================== */
  const LOYALTY_GOAL_EUR = 100;     // € Gesamtumsatz bis zum Treuebonus (über mehrere Bestellungen)
  const LOYALTY_REWARD = 5.00;      // € Treuebonus
  const LOYALTY_MIN_ORDER = 15.00;  // ab diesem Bestellwert einlösbar
  const LOYALTY_STAMPS = 10;        // Stempel auf der Karte (1 Stempel = 10 € Umsatz)

  // Lieferzonen nach Luftlinien-km
  const DELIVERY_ZONES = [
    { maxKm: 3,  minOrder: 15.00, fee: 2.50, key: 'zone.z1', label: 'Zone 1 – bis 3 km' },
    { maxKm: 5,  minOrder: 25.00, fee: 3.50, key: 'zone.z2', label: 'Zone 2 – 3 bis 5 km' },
    { maxKm: 13, minOrder: 50.00, fee: 5.00, key: 'zone.z3', label: 'Zone 3 – 5 bis 13 km' },
  ];
  const MAX_DELIVERY_KM = 13;

  // Wählbare Trinkgeld-Stufen (nur bei Online-Zahlung)
  const TIP_PERCENTS = [0, 5, 10];

  // Testbestellung: Gesamtbetrag wird auf diesen Wert gesetzt.
  // Der zugehörige CODE steht bewusst NICHT hier – er lag früher im
  // Seitenquelltext und war damit für jeden lesbar, der ihn suchte.
  // Er liegt jetzt ausschliesslich serverseitig (Netlify-Variable
  // TEST_ORDER_CODE, ausgewertet in netlify/functions/voucher-check.js).
  const TEST_TOTAL = 1.00;

  /* ==================================================================
     RECHNEN – dieselben Funktionen im Browser wie auf dem Server
     ================================================================== */

  /** Preis EINER Warenkorb-Zeile (ohne Menge). */
  function einzelpreis(entry) {
    const item = MENU.find(m => m.id === (entry && entry.menuId));
    if (!item) return 0;
    let p = item.price + (entry.double ? DOUBLE_PATTY_PRICE : 0);
    if (entry.isMenu) {
      p += MENU_SURCHARGE;
      const side = MENU_SIDE_OPTIONS.find(s => s.id === entry.side);
      if (side) p += side.surcharge;
    }
    return p;
  }

  /** Warenwert des gesamten Warenkorbs (vor Rabatt, Gebühr, Trinkgeld). */
  function warenwert(cart) {
    if (!cart || typeof cart !== 'object') return 0;
    return Object.keys(cart).reduce((summe, key) => {
      const entry = cart[key];
      if (!entry) return summe;
      return summe + einzelpreis(entry) * (entry.qty || 0);
    }, 0);
  }

  /** Trinkgeld aus Bemessungsgrundlage und Prozentsatz. */
  function trinkgeldBetrag(basis, prozent) {
    if (!prozent) return 0;
    return Math.round(basis * prozent) / 100;
  }

  /**
   * Der Gesamtbetrag. Genau eine Formel für beide Seiten – deshalb kann
   * die Anzeige im Warenkorb nicht von der Serverrechnung abweichen.
   * Bewusst OHNE Rundung, exakt wie die Anzeige es bisher gerechnet hat;
   * gerundet wird erst dort, wo der Betrag tatsächlich belastet wird.
   */
  function gesamtbetrag(p) {
    const w = p.warenwert || 0;
    const ab = p.aktionsRabatt || 0;
    const tb = p.treueRabatt || 0;
    const gb = p.gutscheinRabatt || 0;
    const lg = p.liefergebuehr || 0;
    const tg = p.trinkgeld || 0;
    return Math.max(0, w - ab - tb - gb + lg) + tg;
  }

  return {
    MENU, VEGGIE_AVAILABLE_IDS,
    DOUBLE_PATTY_PRICE, DOUBLE_PATTY_EXCLUDE_IDS,
    MENU_SURCHARGE, MENU_DRINK_IDS, MENU_DIP_IDS, MENU_SIDE_OPTIONS,
    PROMO_CODE, PROMO_TIERS, PROMO_MIN_ORDER, PROMO_VALID_UNTIL, PROMO_VALID_UNTIL_LABEL,
    GRILL5_START, GRILL5_UNTIL,
    promoActive, grill5Active, adCode, promoTierPercent, promoDiscountFor,
    LOYALTY_GOAL_EUR, LOYALTY_REWARD, LOYALTY_MIN_ORDER, LOYALTY_STAMPS,
    DELIVERY_ZONES, MAX_DELIVERY_KM, TIP_PERCENTS, TEST_TOTAL,
    einzelpreis, warenwert, trinkgeldBetrag, gesamtbetrag,
  };
});
