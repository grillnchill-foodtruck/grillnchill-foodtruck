/**
 * lib/standing.js
 * ----------------------------------------------------------------------------
 * Termin-Berechnung für Dauerbestellungen – eine Stelle für alle drei
 * Funktionen (anlegen, erinnern, aussetzen). Vorher stand dieselbe Logik
 * doppelt in standing-orders.js und standing-skip.js.
 *
 * Zeitzone: Der Kunde wählt eine BERLINER Wanduhrzeit ("Donnerstag 12:30").
 * Der Server läuft in UTC. Die frühere Fassung baute das Datum aus einem
 * nach Berlin umgerechneten String und setzte darauf setHours() – damit
 * landete 12:30 als 12:30 UTC, also 14:30 Berliner Zeit. Bei Mittagszeiten
 * fiel das nicht auf, weil nur das DATUM verglichen wird; bei einer Zeit ab
 * 22:00 wäre der Termin aber auf den Folgetag gerutscht.
 * Hier wird der Versatz zur jeweiligen Jahreszeit ermittelt und abgezogen.
 * ----------------------------------------------------------------------------
 */

/* Datum in Berlin als JJJJ-MM-TT. */
function berlinDatum(d) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(d || new Date());
}

/* Wochentag (0 = Sonntag) in Berlin. */
function berlinWochentag(d) {
  const kurz = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', weekday: 'short' })
    .format(d || new Date());
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(kurz);
}

/* Versatz Berlin↔UTC in Minuten zum gegebenen Zeitpunkt (60 oder 120). */
function berlinVersatzMin(d) {
  const alsBerlin = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const alsUtc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((alsBerlin - alsUtc) / 60000);
}

/* Berliner Wanduhrzeit an einem Datum → echter Zeitpunkt (ISO/UTC). */
function berlinZeitpunkt(datumIso, zeit) {
  const [hh, mm] = String(zeit || '12:30').split(':').map(Number);
  // Erst so tun, als wäre die Wanduhrzeit UTC …
  const roh = new Date(`${datumIso}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  // … dann den Versatz abziehen, der zu diesem Zeitpunkt in Berlin gilt.
  return new Date(roh.getTime() - berlinVersatzMin(roh) * 60000);
}

/**
 * Nächster Termin nach jetzt (oder nach `nach`, falls gesetzt).
 * @param {number} weekday 0 = Sonntag
 * @param {string} zeit    "12:30"
 * @param {string} [nach]  ISO – Termine bis einschließlich hier werden übersprungen
 * @returns {string|null}  ISO
 */
function naechsterTermin(weekday, zeit, nach) {
  const jetzt = new Date();
  const grenze = nach ? new Date(nach) : jetzt;
  const start = new Date(berlinDatum(jetzt) + 'T00:00:00Z');

  for (let i = 0; i < 21; i++) {
    const tag = new Date(start.getTime() + i * 86400000);
    const datumIso = tag.toISOString().slice(0, 10);
    // Wochentag des Kalendertags bestimmen (12:00 UTC liegt sicher im Tag)
    const wt = berlinWochentag(new Date(datumIso + 'T12:00:00Z'));
    if (wt !== weekday) continue;

    const zeitpunkt = berlinZeitpunkt(datumIso, zeit);
    if (zeitpunkt <= jetzt) continue;      // schon vorbei
    if (zeitpunkt <= grenze) continue;     // ausgesetzt
    return zeitpunkt.toISOString();
  }
  return null;
}

module.exports = { naechsterTermin, berlinDatum, berlinWochentag };
