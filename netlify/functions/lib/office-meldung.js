'use strict';
/**
 * lib/office-meldung.js
 * Meldungen ans GNC Office (Plan 2): HMAC-SHA256 über "<Unix-Sekunden>.<Körper>", gemeinsames Geheimnis
 * office-eingang-secret (Blob-Store geheimnisse), höchstens 5 Meldungen je Anfrage, eine leere Liste als Lebenszeichen.
 * Gegenstück im Office: functions/_lib/eingang.js.
 */
const crypto = require('crypto');
const { geheimnisHolen } = require('./geheimnisse');

const PAKET = 5;
const ZEITLIMIT_MS = 10000;
// Gesamt-Frist für alle Pakete einer Sendung (Netlify-Funktion läuft nur begrenzt); Rest bleibt für den nächsten Lauf
const FRIST_MS = 20000;

function signieren(koerper, geheimnis, zeit = Math.floor(Date.now() / 1000)) {
  const z = String(zeit);
  return { zeit: z, signatur: crypto.createHmac('sha256', geheimnis).update(z + '.' + koerper).digest('base64url') };
}

const eingangUrl = () => (process.env.OFFICE_URL || 'https://office.grillnchill-foodtruck.de').replace(/\/$/, '') + '/api/eingang';

// Eine leere Liste geht als genau ein leeres Paket raus: Lebenszeichen, das Office antwortet trotzdem mit offen und sicherung.
// pakete zählt die Anfragen. Ein abgelaufenes Zeitlimit einer Anfrage heißt "zeitlimit", ein Netzfehler "netz: …".
async function senden(meldungen, { holen = fetch, geheimnis, frist = FRIST_MS } = {}) {
  const g = geheimnis || (await geheimnisHolen('office-eingang-secret', 'OFFICE_EINGANG_SECRET'));
  if (g.length < 32) return { ergebnisse: [], offen: null, sicherung: undefined, fehler: 'nicht_eingerichtet', pakete: 0 };
  const ergebnisse = [];
  let offen = null;
  let sicherung;
  let pakete = 0;
  const ergebnis = (fehler) => ({ ergebnisse, offen, sicherung, fehler, pakete });
  const ende = Date.now() + frist;
  for (let i = 0; i === 0 || i < meldungen.length; i += PAKET) {
    const rest = ende - Date.now();
    if (rest <= 0) return ergebnis('frist');
    const paket = meldungen.slice(i, i + PAKET);
    const koerper = JSON.stringify({ v: 1, meldungen: paket });
    const { zeit, signatur } = signieren(koerper, g);
    let r;
    pakete++;
    try {
      r = await holen(eingangUrl(), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-gnc-zeit': zeit, 'x-gnc-signatur': signatur },
        body: koerper, signal: AbortSignal.timeout(Math.min(ZEITLIMIT_MS, rest)),
      });
    } catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return ergebnis('zeitlimit');
      return ergebnis('netz: ' + String(e && e.message).slice(0, 100));
    }
    const d = (await r.json().catch(() => null)) || {};
    if (!r.ok || !Array.isArray(d.ergebnisse)) return ergebnis(`office_${r.status}${d.fehler ? ' ' + d.fehler : ''}`);
    if (d.ergebnisse.length !== paket.length) return ergebnis('antwort_unvollstaendig');
    ergebnisse.push(...d.ergebnisse);
    offen = d.offen;
    sicherung = d.sicherung;
  }
  return ergebnis(null);
}

module.exports = { signieren, senden, PAKET };
