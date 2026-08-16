/**
 * lib/preisberechnung.js
 * ----------------------------------------------------------------------------
 * Der Betrag, der belastet wird, entsteht HIER – nicht im Browser.
 *
 * WARUM
 * -----
 * Vorher stand in sumup-checkout.js sinngemäß: nimm order.total. Dieses Feld
 * kommt aus dem Browser des Kunden und lässt sich in der Anfrage frei setzen.
 * Eine veränderte Anfrage konnte also 1,00 € für einen 50-€-Warenkorb zahlen.
 * Dass daneben ein input.amount abgeglichen wurde, half nicht: beide Zahlen
 * kamen von derselben, nicht vertrauenswürdigen Seite.
 *
 * Bar-Bestellungen liefen sogar ganz ohne SumUp – dort stand der manipulierte
 * Betrag direkt auf dem Ticket, das das Team am Truck abkassiert.
 *
 * WAS HIER PASSIERT
 * -----------------
 * Aus dem mitgeschickten Warenkorb (cartSnapshot) wird der Preis neu
 * aufgebaut, Position für Position, mit den Preisen aus speisekarte.js –
 * derselben Datei, die auch der Browser lädt. Jeder Abzug wird eigenständig
 * nachgerechnet oder begrenzt:
 *
 *   Warenwert       aus dem Warenkorb, mit derselben Funktion wie im Browser
 *   Aktionsrabatt   aus der Staffel; nur wenn die Aktion wirklich läuft
 *   Gutschein       aus dem Gutschein-Speicher, nie aus der Anfrage
 *   Treuebonus      gegen den Kundendatensatz; ohne Konto hart begrenzt
 *   Liefergebühr    nur die drei Beträge, die es laut Zonen gibt
 *   Trinkgeld       nur die Stufen, die es gibt, und nie negativ
 *   Testbestellung  nur gegen den serverseitigen Code (TEST_ORDER_CODE)
 *
 * DER WICHTIGSTE GRUNDSATZ: NIE ABBRECHEN
 * ---------------------------------------
 * Ein Bestellabbruch ist für einen Foodtruck teurer als ein Betrugsversuch.
 * Deshalb gibt diese Datei NIE einen Fehler zurück, der den Checkout stoppt.
 * Kann sie nicht sicher rechnen – Warenkorb fehlt, ein Artikel ist unbekannt
 * (neue Karte, alter Browser-Cache), Speicher nicht erreichbar –, dann meldet
 * sie `sicher: false` und der Aufrufer bleibt beim Betrag aus dem Browser.
 * Das ist das Verhalten von vorher; es wird also nie schlechter, nur besser.
 *
 * UND WARUM DER BETRAG DAS MAXIMUM IST
 * ------------------------------------
 * Weicht die Rechnung ab, gilt `Math.max(browser, server)`:
 *
 *   Browser zu NIEDRIG  -> Serverbetrag. Der Kunde zahlt den Kartenpreis.
 *   Browser zu HOCH     -> Browserbetrag. Niemand zahlt mehr als angezeigt.
 *
 * Bei einer ehrlichen Bestellung gibt es keine Abweichung: Browser und Server
 * rufen buchstäblich dieselben Funktionen mit denselben Zahlen auf. Belegt
 * ist das mit einem Differenztest, der die echten Frontend-Funktionen aus
 * index.html gegen diese Datei laufen lässt (werkzeug/preis-differenztest.js).
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');

/* Die Speisekarte liegt im Repo-Root und wird von index.html genauso geladen.
   Sollte sie wider Erwarten nicht mitgebündelt sein, darf das den Checkout
   nicht anhalten – dann rechnet der Server eben nicht nach (sicher: false). */
let SK = null;
try {
  SK = require('../../../speisekarte.js');
} catch (e) {
  console.error('preisberechnung: speisekarte.js nicht ladbar –'
    + ' der Betrag wird NICHT nachgerechnet:', e && e.message);
}

/* Erlaubte Liefergebühren: genau die Beträge aus den Zonen, plus 0 (Abholung). */
function erlaubteGebuehren() {
  const s = new Set([0]);
  for (const z of (SK && SK.DELIVERY_ZONES) || []) s.add(z.fee);
  return s;
}

const runde = (x) => Math.round((Number(x) || 0) * 100) / 100;
const zahl = (x) => (typeof x === 'number' && isFinite(x) ? x : 0);

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

/* ---------------------------------------------------------------------------
   TESTBESTELLUNG
   Der Code lag früher als Klartext in index.html – also im Quelltext jeder
   ausgelieferten Seite und im öffentlichen Repo. Jeder, der ihn dort las,
   konnte beliebig viel für 1 € bestellen. Er kommt jetzt aus der Netlify-
   Variable TEST_ORDER_CODE.

   Der Rückfall auf den alten Wert steht bewusst hier: Ohne ihn wären
   Testbestellungen in der Sekunde des Deploys kaputt, in der die Variable
   noch nicht gesetzt ist. Sobald TEST_ORDER_CODE in Netlify steht, ist der
   alte Code wertlos.
--------------------------------------------------------------------------- */
const TEST_CODE_RUECKFALL = 'TESTGNC1';
function testCode() {
  return String(process.env.TEST_ORDER_CODE || TEST_CODE_RUECKFALL).trim().toUpperCase();
}
function istTestCode(eingabe) {
  const soll = testCode();
  const ist = String(eingabe || '').trim().toUpperCase();
  return !!ist && ist === soll;
}

/* ---------------------------------------------------------------------------
   Gutschein: der verbindliche Wert steht im Speicher, nicht in der Anfrage.
   Spiegelt voucherDiscount() aus index.html, aber mit den Konditionen aus
   dem Gutschein-Datensatz statt denen, die der Browser mitschickt.
--------------------------------------------------------------------------- */
async function gutscheinRabatt(code, warenwert, modus) {
  const sauber = String(code || '').toUpperCase().replace(/[^A-Z0-9ÄÖÜŞĞÇ]/g, '').slice(0, 20);
  if (!sauber) return 0;
  const c = await store('vouchers').get('c:' + sauber, { type: 'json' });
  if (!c || c.active === false) return 0;

  // Modus-Bindung (nur Abholung / nur Lieferung)
  if (c.mode && c.mode !== 'any' && modus !== c.mode) return 0;

  if (c.type === 'percent') {
    if (warenwert < (c.minOrder || 0)) return 0;
    let d = warenwert * (c.value || 0) / 100;
    if (c.maxDiscount > 0) d = Math.min(d, c.maxDiscount);
    return Math.min(runde(d), warenwert);
  }
  // Fester Betrag. Mindestbestellwert wie im Browser: persönlich => 15 €.
  const mindest = c.minOrder || (c.referral || c.kind === 'personal' ? 15 : 0);
  if (warenwert < mindest) return 0;
  return Math.min(c.value || 3, warenwert);
}

/* ---------------------------------------------------------------------------
   Treuebonus. Ohne Konto lebt die Stempelkarte nur im Browser – dort ist sie
   nicht prüfbar. Deshalb: gegen den Kundendatensatz prüfen, wenn es einen
   gibt, sonst auf den einen möglichen Bonus begrenzen. Der Schaden ist damit
   auch im ungünstigsten Fall auf 5 € gedeckelt, und kein ehrlicher Gast
   verliert seinen Bonus.
--------------------------------------------------------------------------- */
async function treueRabatt(order, warenwert) {
  if (!SK) return 0;
  if (!order.loyaltyApplied && !zahl(order.loyaltyDiscount)) return 0;
  if (warenwert < SK.LOYALTY_MIN_ORDER) return 0;
  const gewuenscht = Math.min(zahl(order.loyaltyDiscount) || SK.LOYALTY_REWARD, SK.LOYALTY_REWARD);
  if (gewuenscht <= 0) return 0;

  const mail = String(order.email || '').trim().toLowerCase();
  if (!mail) return gewuenscht;
  try {
    const crypto = require('crypto');
    const key = 'c:' + crypto.createHash('sha256').update(mail).digest('hex');
    const rec = await store('customers').get(key, { type: 'json' });
    // Kein Datensatz -> Gast ohne Konto, Stempelkarte nur lokal. Durchlassen.
    if (!rec) return gewuenscht;
    return (rec.rewards || 0) >= 1 ? gewuenscht : 0;
  } catch (e) {
    return gewuenscht;   // Speicherproblem darf keinen Bonus schlucken
  }
}

/* ---------------------------------------------------------------------------
   DIE RECHNUNG
   Gibt immer ein Ergebnis zurück. `sicher` sagt, ob nachgerechnet werden
   konnte; nur dann darf der Aufrufer den Betrag verwenden.
--------------------------------------------------------------------------- */
async function betragErmitteln(order) {
  const ausBrowser = runde(zahl(order && order.total));
  const ergebnis = {
    sicher: false,
    betrag: ausBrowser,
    ausBrowser,
    berechnet: null,
    abweichung: 0,
    test: false,
    grund: null,
    posten: null,
  };
  if (!SK) { ergebnis.grund = 'speisekarte_fehlt'; return ergebnis; }
  if (!order || typeof order !== 'object') { ergebnis.grund = 'keine_bestellung'; return ergebnis; }

  // --- Testbestellung: nur gegen den serverseitigen Code -------------------
  if (order.isTest || order.testCode) {
    if (istTestCode(order.testCode)) {
      ergebnis.sicher = true;
      ergebnis.test = true;
      ergebnis.betrag = SK.TEST_TOTAL;
      ergebnis.berechnet = SK.TEST_TOTAL;
      ergebnis.abweichung = runde(SK.TEST_TOTAL - ausBrowser);
      return ergebnis;
    }
    // Kennzeichen gesetzt, Code falsch oder fehlt: KEIN Testrabatt.
    // Weiterrechnen wie bei einer normalen Bestellung.
  }

  // --- Warenkorb ----------------------------------------------------------
  const korb = order.cartSnapshot;
  if (!korb || typeof korb !== 'object' || !Object.keys(korb).length) {
    ergebnis.grund = 'kein_warenkorb';
    return ergebnis;
  }
  // Ein unbekannter Artikel bedeutet: die Karte hat sich geändert, während der
  // Kunde bestellte (alter Browser-Cache). Dann wäre jede Nachrechnung falsch.
  for (const k of Object.keys(korb)) {
    const e = korb[k];
    if (!e || !SK.MENU.some(m => m.id === e.menuId)) {
      ergebnis.grund = 'artikel_unbekannt';
      return ergebnis;
    }
    const menge = Number(e.qty);
    if (!isFinite(menge) || menge <= 0 || menge > 99) {
      ergebnis.grund = 'menge_unplausibel';
      return ergebnis;
    }
  }

  const warenwert = SK.warenwert(korb);

  // --- Aktionsrabatt: aus der Staffel, nur solange die Aktion läuft --------
  let aktionsRabatt = 0;
  const promoCode = String((order.promo && order.promo.code) || '').toUpperCase();
  if (promoCode && promoCode === SK.PROMO_CODE && SK.promoActive() && warenwert >= SK.PROMO_MIN_ORDER) {
    aktionsRabatt = SK.promoDiscountFor(warenwert);
  }

  // --- Gutschein: aus dem Speicher ----------------------------------------
  let gutschein = 0;
  const modus = order.mode === 'delivery' ? 'delivery' : 'pickup';
  const gutscheinCode = order.voucherCode || (order.promo && order.promo.code);
  if (gutscheinCode && String(gutscheinCode).toUpperCase() !== SK.PROMO_CODE) {
    try {
      gutschein = await gutscheinRabatt(gutscheinCode, warenwert, modus);
    } catch (e) {
      // Gutschein-Speicher nicht erreichbar: den angezeigten Abzug stehen
      // lassen, aber auf den Warenwert begrenzen. Lieber ein Gutschein zu
      // viel als eine abgelehnte Bestellung.
      gutschein = Math.min(Math.max(0, zahl(order.discount)), warenwert);
    }
  }

  // --- Treuebonus ---------------------------------------------------------
  const treue = await treueRabatt(order, warenwert);

  // --- Liefergebühr: nur bekannte Beträge ---------------------------------
  // Die Zone hängt an der Entfernung zur Adresse; die kann der Server hier
  // nicht bestimmen (das braucht Geokodierung). Die Gebühr ERHÖHT den Betrag,
  // ist also kein Hebel zum Unterbezahlen – begrenzt wird sie trotzdem.
  let gebuehr = 0;
  if (modus === 'delivery') {
    const gemeldet = runde(order.deliveryFee);
    gebuehr = erlaubteGebuehren().has(gemeldet) ? gemeldet : 0;
  }

  // --- Trinkgeld: nur die angebotenen Stufen ------------------------------
  const basis = Math.max(0, warenwert - aktionsRabatt - treue - gutschein);
  const gemeldetesTrinkgeld = runde(order.tip);
  let trinkgeld = 0;
  if (gemeldetesTrinkgeld > 0) {
    const stufen = (SK.TIP_PERCENTS || [0]).map(p => SK.trinkgeldBetrag(basis, p));
    const treffer = stufen.some(s => Math.abs(s - gemeldetesTrinkgeld) < 0.005);
    // Kein Treffer -> auf die höchste angebotene Stufe deckeln. Nie hochsetzen.
    trinkgeld = treffer ? gemeldetesTrinkgeld : Math.min(gemeldetesTrinkgeld, Math.max(...stufen));
  }

  const berechnet = runde(SK.gesamtbetrag({
    warenwert, aktionsRabatt, treueRabatt: treue,
    gutscheinRabatt: gutschein, liefergebuehr: gebuehr, trinkgeld,
  }));

  ergebnis.sicher = true;
  ergebnis.berechnet = berechnet;
  ergebnis.abweichung = runde(berechnet - ausBrowser);
  // Nie mehr verlangen als angezeigt, nie weniger als die Karte hergibt.
  ergebnis.betrag = Math.max(berechnet, ausBrowser);
  ergebnis.posten = {
    warenwert: runde(warenwert), aktionsRabatt: runde(aktionsRabatt),
    gutscheinRabatt: runde(gutschein), treueRabatt: runde(treue),
    liefergebuehr: runde(gebuehr), trinkgeld: runde(trinkgeld),
  };
  return ergebnis;
}

/* Auffällig ist eine Abweichung erst ab einem Cent – darunter ist es
   Fließkomma-Rauschen aus der Prozentrechnung, kein Manipulationsversuch. */
const AUFFAELLIG_AB = 0.01;
function istAuffaellig(p) {
  return !!(p && p.sicher && p.abweichung > AUFFAELLIG_AB);
}

/* Meldung an den Inhaber. Eine Abweichung ist entweder ein Betrugsversuch
   oder ein Fehler in dieser Datei – beides will Kubi sofort wissen. */
async function meldeAbweichung(p, order) {
  try {
    const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
    const text = '⚠️ Preisabweichung bei ' + (order && order.reference ? '#' + order.reference : 'einer Bestellung')
      + '\nBrowser: ' + p.ausBrowser.toFixed(2) + ' €'
      + '\nNachgerechnet: ' + Number(p.berechnet).toFixed(2) + ' €'
      + '\nBelastet: ' + Number(p.betrag).toFixed(2) + ' €'
      + (p.posten ? '\nWarenwert ' + p.posten.warenwert.toFixed(2)
          + ' · Rabatt ' + (p.posten.aktionsRabatt + p.posten.gutscheinRabatt + p.posten.treueRabatt).toFixed(2)
          + ' · Lieferung ' + p.posten.liefergebuehr.toFixed(2)
          + ' · Trinkgeld ' + p.posten.trinkgeld.toFixed(2) : '');
    console.warn('preisberechnung:', text.replace(/\n/g, ' | '));
    if (!tok || !chat) return;
    await fetch('https://api.telegram.org/bot' + tok + '/sendMessage', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text }),
    });
  } catch (e) { /* Melden darf den Checkout nie aufhalten */ }
}

/**
 * Bequemer Weg für die Aufrufer: rechnet nach, meldet bei Abweichung und
 * schreibt den korrigierten Betrag in die Bestellung zurück, damit Ticket,
 * Mail, Archiv und Rechnung dieselbe Zahl zeigen wie die Belastung.
 * Wirft nie.
 */
async function pruefeUndKorrigiere(order) {
  let p;
  try {
    p = await betragErmitteln(order);
  } catch (e) {
    console.error('preisberechnung: unerwarteter Fehler –'
      + ' Betrag bleibt wie gemeldet:', e && e.message);
    return { sicher: false, betrag: runde(zahl(order && order.total)), grund: 'ausnahme' };
  }
  if (istAuffaellig(p)) {
    await meldeAbweichung(p, order);
    if (order && typeof order === 'object') {
      order.totalGemeldet = p.ausBrowser;   // was der Browser behauptete
      order.total = p.betrag;               // was tatsächlich gilt
      order.preisKorrigiert = true;
      if (p.posten) {
        order.subtotal = p.posten.warenwert;
        order.discount = runde(p.posten.aktionsRabatt + p.posten.gutscheinRabatt);
        order.loyaltyDiscount = p.posten.treueRabatt;
        order.deliveryFee = p.posten.liefergebuehr;
        order.tip = p.posten.trinkgeld;
      }
    }
  }
  // Eine Testbestellung ohne gültigen Code ist keine – Kennzeichen entfernen,
  // sonst landet sie ohne Treuegutschrift und mit Test-Banner beim Inhaber,
  // obwohl der volle Preis belastet wurde.
  if (order && order.isTest && !p.test) {
    order.isTest = false;
    order.testCode = null;
  }
  if (order && typeof order === 'object') delete order.testCode;
  return p;
}

module.exports = {
  betragErmitteln, pruefeUndKorrigiere, istAuffaellig, meldeAbweichung,
  istTestCode, AUFFAELLIG_AB,
};
