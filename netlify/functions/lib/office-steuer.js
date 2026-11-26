'use strict';
/**
 * lib/office-steuer.js
 * Steueraufteilung einer Online-Bestellung fürs GNC Office. Spiegel von splitVat() und buildVatSummary() in
 * index.html: Menü-Split (Getränk mit seinem Einzelpreis zu 19 %) und Trinkgeld brutto in der 19-%-Zeile sind vom
 * Betreiber eingefroren, bis der Steuerberater sie gegenzeichnet. Hier nichts anders rechnen als dort;
 * werkzeug/office-steuer-test.js lässt beide Fassungen gegeneinander laufen.
 *
 * Geschenkgutscheine (Mehrzweck) stehen auf dem Beleg als Rabatt. Fürs Office ist der eingelöste Wert aber Umsatz:
 * aufteilung() rechnet die Zeilen einmal mit und einmal ohne Gutschein-Rabatt, der Unterschied je Satz ist die Einlösung.
 */
let SK = null;
try { SK = require('../../../speisekarte.js'); } catch (e) { SK = null; }

const cent = (euro) => Math.round(Number(euro || 0) * 100);

// Wie splitVat() in index.html, mit der Speisekarte als Parameter
function splitVat(entry, bruttoGesamt, K = SK) {
  const item = K.MENU.find((m) => m.id === entry.menuId);
  if (!item) return { 7: bruttoGesamt, 19: 0 };
  if (!entry.isMenu) {
    const satz = item.cat === 'drinks' ? 19 : 7;
    return { 7: satz === 7 ? bruttoGesamt : 0, 19: satz === 19 ? bruttoGesamt : 0 };
  }
  const drink = K.MENU.find((m) => m.id === entry.drink);
  const drinkEinzel = (drink ? drink.price : 0) * entry.qty;
  const anteilDrink = Math.min(drinkEinzel, bruttoGesamt);
  return { 7: bruttoGesamt - anteilDrink, 19: anteilDrink };
}

// Warenwert je Satz vor Rabatten (Euro). Zuerst die Anteile, die der Browser beim Kauf mitgeschickt hat
// (Karte vom Kauftag). Passen sie nicht zum Warenwert, aus dem Warenkorb neu rechnen.
function warenJeSatz(order, K = SK) {
  const soll = Number(order.subtotal) || 0;
  // Ohne Warenwert, aber mit Betrag: nichts ist verlässlich, alles zum vollen Satz (ausgleichen() schiebt den Betrag dann in die 19-%-Zeile)
  if (soll <= 0 && Number(order.total) > 0) return { waren: { 7: 0, 19: 0 }, quelle: 'geschaetzt' };
  const items = Array.isArray(order.items) ? order.items : [];
  if (items.length && items.every((it) => it && it.vatSplit)) {
    const w = items.reduce((s, it) => ({ 7: s[7] + (Number(it.vatSplit[7]) || 0), 19: s[19] + (Number(it.vatSplit[19]) || 0) }), { 7: 0, 19: 0 });
    if (Math.abs(w[7] + w[19] - soll) < 0.005) return { waren: w, quelle: 'beleg' };
  }
  if (K && order.cartSnapshot && typeof order.cartSnapshot === 'object') {
    const w = { 7: 0, 19: 0 };
    for (const e of Object.values(order.cartSnapshot)) {
      if (!e || typeof e !== 'object') continue;
      const t = splitVat(e, K.einzelpreis(e) * e.qty, K);
      w[7] += t[7];
      w[19] += t[19];
    }
    if (Math.abs(w[7] + w[19] - soll) < 0.005) return { waren: w, quelle: 'warenkorb' };
  }
  // Nichts passt: alles zum vollen Satz, damit keine Steuer fehlt. Der Aufrufer meldet die Bestellung.
  return { waren: { 7: 0, 19: soll }, quelle: 'geschaetzt' };
}

// Wie buildVatSummary() in index.html, nur die Bruttobeträge je Satz (Euro, auf 2 Stellen gerundet)
function zeilen(waren, rabattGesamt, liefergebuehr, trinkgeld, rabattSpeisen) {
  const brutto = { 7: waren[7], 19: waren[19] };
  brutto[7] -= Math.min(Math.max(0, Number(rabattSpeisen) || 0), brutto[7]);
  const warenSumme = brutto[7] + brutto[19];
  const tip = Math.max(0, Number(trinkgeld) || 0);
  const aus = { 7: 0, 19: 0 };
  [7, 19].forEach((satz) => {
    if (brutto[satz] <= 0 && !(satz === 19 && tip > 0)) return;
    const anteil = warenSumme > 0 ? brutto[satz] / warenSumme : 0;
    const bru = Math.max(0, brutto[satz] - rabattGesamt * anteil + liefergebuehr * anteil) + (satz === 19 ? tip : 0);
    aus[satz] = +bru.toFixed(2);
  });
  return aus;
}

// Rundungsrest in die größere Zeile (bei geschätzter Aufteilung immer in die 19-%-Zeile), damit die Summe genau dem
// Zielbetrag entspricht. Kein Anteil wird negativ: Ein negativer Anteil wird 0, der andere Satz bekommt den Rest.
function ausgleichen(je, ziel, nur19 = false) {
  const rest = ziel - (je[7] + je[19]);
  if (rest) je[nur19 || je[19] > je[7] ? 19 : 7] += rest;
  for (const [satz, anderer] of [[7, 19], [19, 7]]) {
    if (je[satz] < 0) { je[anderer] += je[satz]; je[satz] = 0; }
  }
  return rest;
}

function aufteilung(order, { gutscheinCent = 0 } = {}, K = SK) {
  order = order && typeof order === 'object' ? order : {};
  const { waren, quelle } = warenJeSatz(order, K);
  const deal = Number(order.dealDiscount) || 0;
  // Wie im Browser: Rabatt gesamt = Aktion + Gutschein + Treue, der Deal geht nur vom 7-%-Anteil ab
  const rabatt = (Number(order.discount) || 0) - deal + (Number(order.loyaltyDiscount) || 0);
  const liefer = Number(order.deliveryFee) || 0;
  const tip = Number(order.tip) || 0;
  const mit = zeilen(waren, rabatt, liefer, tip, deal);
  const ohne = zeilen(waren, rabatt - gutscheinCent / 100, liefer, tip, deal);
  const bezahlt = { 7: cent(mit[7]), 19: cent(mit[19]) };
  const rest = ausgleichen(bezahlt, cent(order.total), quelle === 'geschaetzt');
  const gutschein = { 7: cent(ohne[7]) - cent(mit[7]), 19: cent(ohne[19]) - cent(mit[19]) };
  if (gutscheinCent) ausgleichen(gutschein, gutscheinCent, quelle === 'geschaetzt');
  return { bezahlt, gutschein, quelle, rest };
}

module.exports = { aufteilung, splitVat, zeilen, warenJeSatz };
