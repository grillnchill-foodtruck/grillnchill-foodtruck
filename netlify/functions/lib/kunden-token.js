/**
 * lib/kunden-token.js
 * ----------------------------------------------------------------------------
 * Prüfung des Anmelde-Tokens eines Kundenkontos – an EINER Stelle.
 *
 * WARUM ES DIESE DATEI GIBT
 * -------------------------
 * Die Tokens eines Kontos liegen als Objekt im Datensatz:
 *
 *     rec.tokens = { "a3f1…": "2026-08-16T12:00:00.000Z", … }
 *
 * Geprüft wurde bisher an drei Stellen (account.js, standing-orders.js,
 * wallet-pass.js) gleichlautend so:
 *
 *     if (!rec.tokens[token]) return null;          // <-- Lücke
 *
 * Ein Objekt in JavaScript erbt Eigenschaften von Object.prototype. Ein
 * Nachschlagen mit eckigen Klammern findet diese Erbstücke mit. Wer als
 * Token die Zeichenkette "__proto__" schickt, bekommt Object.prototype
 * zurück – ein Objekt, und damit "wahr". Dasselbe gilt für "constructor",
 * "toString", "valueOf" und "hasOwnProperty".
 *
 *     rec.tokens["irgendwas"]   -> undefined   -> abgelehnt   (richtig)
 *     rec.tokens["__proto__"]   -> {}          -> ANGENOMMEN  (falsch)
 *
 * Praktisch hiess das: Wer eine E-Mail-Adresse kannte, kam ohne jede
 * Anmeldung an das zugehörige Konto. Der Weg dahin brauchte nicht einmal
 * einen bestehenden Datensatz – ein "request_code" für die fremde Adresse
 * legt ihn an (mit leerem, aber vorhandenem tokens-Objekt), danach genügte
 * ein Aufruf mit token="__proto__", um Name, Telefonnummer, Geburtstag,
 * Firmendaten, alle hinterlegten Lieferadressen, den Empfehlungscode und den
 * Kundenkarten-Token zu lesen – und über 'save' zu ändern bzw. über 'delete'
 * das ganze Konto zu löschen. Bei standing-orders.js dieselbe Wirkung für
 * stehende Bestellungen, bei wallet-pass.js für die Kundenkarte.
 *
 * WIE ES JETZT GEPRÜFT WIRD
 * -------------------------
 * 1. Der Token muss die Form haben, die die Ausgabe erzeugt: reine
 *    Kleinbuchstaben-Hexzeichen (crypto.randomBytes(24).toString('hex')
 *    ergibt 48 Zeichen). Damit sind "__proto__" & Co. schon an der Form
 *    zu erkennen und fallen raus, bevor irgendetwas nachgeschlagen wird.
 * 2. Nachgeschlagen wird mit hasOwnProperty über Object.prototype.call –
 *    das sieht ausschliesslich EIGENE Eigenschaften des Objekts, niemals
 *    geerbte. Selbst wenn Form-Prüfung Nr. 1 eines Tages gelockert würde,
 *    bliebe die Lücke zu.
 * 3. Der hinterlegte Wert (Zeitstempel der Anmeldung) muss gesetzt sein.
 *
 * Bestehende Anmeldungen bleiben gültig: das Format der ausgegebenen Tokens
 * hat sich nie geändert (in der gesamten Git-Historie nur
 * crypto.randomBytes(24).toString('hex')), niemand wird abgemeldet.
 *
 * Die Spanne 32–128 statt fest 48 ist bewusst: sie lässt Raum, die Token-
 * Länge künftig zu ändern, ohne alle angemeldeten Kunden auszusperren –
 * die Absicherung hängt an Schritt 2, nicht an der Länge.
 * ----------------------------------------------------------------------------
 */

/* Form der ausgegebenen Tokens: Hex, Kleinbuchstaben. */
const TOKEN_FORM = /^[a-f0-9]{32,128}$/;

/**
 * Wie lange eine Anmeldung gilt.
 *
 * Vorher: unbegrenzt. Wer sich einmal angemeldet hatte, blieb es für immer –
 * auch auf dem Rechner im Hotel, dem verkauften Handy oder dem Tablet, das
 * sich jemand geliehen hat. Fünf Tokens pro Konto, keiner davon lief je ab.
 *
 * 180 Tage sind bewusst grosszügig: Wer zweimal im Jahr bestellt, merkt
 * nichts. Wer länger weg war, fordert einen neuen Code an – das dauert die
 * halbe Minute, die eine Anmeldung ohnehin dauert, und das Konto mit allen
 * Daten und Stempeln ist unverändert da.
 */
const GUELTIG_MS = 180 * 24 * 60 * 60 * 1000;

/**
 * Ist dieser Token für diesen Kundendatensatz gültig?
 *
 * @param {object|null} rec   Kundendatensatz aus dem Store 'customers'
 * @param {unknown}     token Token aus der Anfrage (ungeprüft)
 * @returns {boolean}
 */
function tokenGueltig(rec, token) {
  if (!rec || typeof rec !== 'object') return false;
  const tokens = rec.tokens;
  if (!tokens || typeof tokens !== 'object') return false;
  if (typeof token !== 'string' || !TOKEN_FORM.test(token)) return false;
  if (!Object.prototype.hasOwnProperty.call(tokens, token)) return false;
  const seit = tokens[token];
  if (!seit) return false;

  /* Abgelaufen? Der Wert ist der Zeitstempel der Anmeldung.
     Lässt er sich nicht lesen – ein Datensatz aus einer früheren Fassung,
     ein kaputter Eintrag –, gilt der Token WEITER. Lieber eine Anmeldung zu
     lang als ein Kunde, der ohne Grund vor der Tür steht. */
  const t = new Date(seit).getTime();
  if (!isFinite(t)) return true;
  return (Date.now() - t) < GUELTIG_MS;
}

module.exports = { tokenGueltig, TOKEN_FORM, GUELTIG_MS };
