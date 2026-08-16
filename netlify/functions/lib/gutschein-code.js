/**
 * lib/gutschein-code.js
 * ----------------------------------------------------------------------------
 * Ein Gutscheincode -> ein Speicherschlüssel. EINE Stelle für alle.
 *
 * Vorher stand dieselbe Normalisierung viermal im Code – und lief auseinander:
 * Anlegen, Prüfen und Nachrechnen erlaubten Umlaute, das ZÄHLEN nicht
 * (send-email.js: `[^A-Z0-9]` statt `[^A-Z0-9ÄÖÜŞĞÇ]`). Ein Code wie "GRÜN10"
 * lag damit als `c:GRÜN10` im Speicher, wurde beim Einlösen als `c:GRÜN10`
 * gefunden – der Rabatt griff also – aber beim Zählen als `c:GRN10` gesucht.
 * Der Datensatz wurde nicht gefunden, deshalb:
 *   - der Zähler blieb auf 0 ("0 / 1 eingelöst" im Admin-Tool),
 *   - und die verbindliche Prüfung von maxUses / oncePerCustomer lief ins
 *     Leere: ein Code mit Umlaut liess sich beliebig oft einlösen.
 *
 * Deshalb liegt die Regel jetzt hier und wird überall importiert.
 *
 * Zu den erlaubten Zeichen: ÄÖÜ für deutsche, ŞĞÇ für türkische Codes.
 * "ß" braucht keinen eigenen Eintrag – toUpperCase() macht daraus von sich
 * aus "SS", und zwar in allen vier Aufrufern gleich.
 * ----------------------------------------------------------------------------
 */

const ERLAUBT = /[^A-Z0-9ÄÖÜŞĞÇ]/g;
const MAX_LAENGE = 20;

/** Freie Eingabe -> einheitlicher Code. Leerer String, wenn nichts übrig bleibt. */
function codeNormalisieren(code) {
  return String(code == null ? '' : code)
    .trim()
    .toUpperCase()
    .replace(ERLAUBT, '')
    .slice(0, MAX_LAENGE);
}

/** Fertiger Speicherschlüssel im Store "vouchers". */
function codeSchluessel(code) {
  const sauber = codeNormalisieren(code);
  return sauber ? 'c:' + sauber : null;
}

module.exports = { codeNormalisieren, codeSchluessel, MAX_LAENGE };
