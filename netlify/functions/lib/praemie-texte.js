/**
 * lib/praemie-texte.js
 * ----------------------------------------------------------------------------
 * Texte zur Treue-Prämie auf den Handy-Wallet-Karten (Apple und Google), an
 * einer Stelle, damit beide Karten dasselbe sagen.
 *
 * Seit Oktober 2026 gibt eine volle Stempelkarte (100 € Umsatz) ein Menü aufs
 * Haus statt 5 €. Die Regel selbst steht in speisekarte.js
 * (LOYALTY_MENU_EXCLUDE_IDS, gratisMenuZeile); hier nur die Worte dazu.
 * 5-€-Boni gibt es weiter zum Geburtstag und für Empfehlungen. Sie erscheinen
 * auf den Karten nur, wenn jemand welche hat.
 * ----------------------------------------------------------------------------
 */

const MENUE_HINWEIS = 'Gilt für jedes Burger-Menü mit Single Patty, normalen Pommes, '
  + 'einem Softdrink und einem Dip. Kubis Special ausgenommen. '
  + 'Double Patty und Süßkartoffelpommes gegen Aufpreis.';

const MENUE_TEXT = 'Je 100 € Umsatz gibt es ein Menü aufs Haus. ' + MENUE_HINWEIS;

function boniText(rec) {
  const n = (rec && rec.rewards) || 0;
  return n > 0 ? n + ' (Geburtstag oder Empfehlung), einlösbar ab 15 € Bestellwert' : '';
}

function bisZumMenue(rec) {
  return Math.max(0, Math.round((100 - ((rec && rec.spent) || 0)) * 100) / 100);
}

// Textblöcke für Google Wallet (loyaltyObject.textModulesData). Ersetzt beim
// Aktualisieren die ganze Liste, also stehen hier immer alle Blöcke.
function googleTextModule(rec) {
  const module = [
    { header: 'Bis zum Menü aufs Haus', body: bisZumMenue(rec).toFixed(2).replace('.', ',') + ' € Umsatz', id: 'to_next' },
    { header: 'Menü aufs Haus', body: MENUE_TEXT, id: 'menue' },
  ];
  const b = boniText(rec);
  if (b) module.push({ header: '5-€-Boni', body: b, id: 'boni5' });
  return module;
}

module.exports = { MENUE_HINWEIS, MENUE_TEXT, boniText, bisZumMenue, googleTextModule };
