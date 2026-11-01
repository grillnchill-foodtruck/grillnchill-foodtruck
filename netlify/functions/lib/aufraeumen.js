/**
 * lib/aufraeumen.js
 * ----------------------------------------------------------------------------
 * Löschfristen, die in der Datenschutzerklärung stehen, auch wirklich
 * durchsetzen. Läuft nachts über aufraeumen.js (netlify.toml).
 *
 *   geo        Koordinaten zu Lieferadressen         365 Tage nach Abruf
 *   feedback   Bewertungen nach der Bestellung        730 Tage
 *   abholnr    Tageszähler der Abholnummern           30 Tage
 *   fahrt      Live-Position des Fahrers              6 Stunden
 *   bremse     Zähler gegen Missbrauch (je Tag)       ab 3 Tagen alt
 *   firmen     abgelehnte Firmenanträge               180 Tage nach Entscheidung
 *
 * Nur was eindeutig abgelaufen ist, wird gelöscht. Einträge ohne lesbares
 * Datum bleiben liegen. Je Lauf gibt es ein Zeitbudget, der Rest kommt in
 * der nächsten Nacht dran.
 * ----------------------------------------------------------------------------
 */

const TAG = 86400000;
const FRISTEN = {
  geo: 365 * TAG,
  feedback: 730 * TAG,
  abholnr: 30 * TAG,
  fahrt: 6 * 3600000,
  bremseTage: 3,
  bremseBisTage: 45,
  firmenAbgelehnt: 180 * TAG,
};

const alt = (wann, frist, jetzt) => {
  const t = typeof wann === 'number' ? wann : Date.parse(wann);
  return Number.isFinite(t) && jetzt - t > frist;
};
const tagVon = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * @param holeStore  name -> Blob-Store (getStore-kompatibel)
 * @param opts       { jetzt, budgetMs }
 * @returns {Promise<object>} gelöschte Einträge je Store, dazu `abgebrochen`
 */
async function aufraeumen(holeStore, opts = {}) {
  const jetzt = opts.jetzt || Date.now();
  const ende = Date.now() + (opts.budgetMs || 20000);
  const zeit = () => Date.now() < ende;
  const ergebnis = { geo: 0, feedback: 0, abholnr: 0, fahrt: 0, bremse: 0, firmen: 0, abgebrochen: false };

  async function jeEintrag(name, prefix, pruefe) {
    const s = holeStore(name);
    let liste;
    try { liste = (await s.list(prefix ? { prefix } : {})).blobs || []; } catch (e) { return; }
    for (const b of liste) {
      if (!zeit()) { ergebnis.abgebrochen = true; return; }
      try {
        const v = await s.get(b.key, { type: 'json' });
        if (v && pruefe(v, b.key)) { await s.delete(b.key); ergebnis[name]++; }
      } catch (e) { /* einzelner Eintrag: weiter */ }
    }
  }

  await jeEintrag('fahrt', 'pos:', (v) => alt(v.at, FRISTEN.fahrt, jetzt));
  await jeEintrag('geo', '', (v, k) => k !== '_takt' && alt(v.at, FRISTEN.geo, jetzt));
  await jeEintrag('feedback', 'f:', (v) => alt(v.at, FRISTEN.feedback, jetzt));
  await jeEintrag('firmen', 'antrag:', (v) => v.status === 'abgelehnt' && alt(v.entschiedenAt, FRISTEN.firmenAbgelehnt, jetzt));

  // Abholnummern: Schlüssel t:<YYYY-MM-DD>, das Datum steckt im Schlüssel
  if (zeit()) {
    const s = holeStore('abholnr');
    const grenze = tagVon(jetzt - FRISTEN.abholnr);
    try {
      for (const b of (await s.list({ prefix: 't:' })).blobs || []) {
        if (!zeit()) { ergebnis.abgebrochen = true; break; }
        const tag = b.key.slice(2, 12);
        if (/^\d{4}-\d{2}-\d{2}$/.test(tag) && tag < grenze) { await s.delete(b.key); ergebnis.abholnr++; }
      }
    } catch (e) { /* nächste Nacht */ }
  }

  // Bremse: Schlüssel <YYYY-MM-DD>/..., ganze alte Tage löschen. lib/bremse.js
  // räumt selbst nur gelegentlich genau einen Tag auf; hier werden Lücken geschlossen.
  if (zeit()) {
    const s = holeStore('bremse');
    for (let d = FRISTEN.bremseTage; d <= FRISTEN.bremseBisTage && zeit(); d++) {
      try {
        for (const b of (await s.list({ prefix: tagVon(jetzt - d * TAG) + '/' })).blobs || []) {
          if (!zeit()) { ergebnis.abgebrochen = true; break; }
          await s.delete(b.key);
          ergebnis.bremse++;
        }
      } catch (e) { /* nächster Tag */ }
    }
    if (!zeit()) ergebnis.abgebrochen = true;
  }

  return ergebnis;
}

module.exports = { aufraeumen, FRISTEN };
