'use strict';
/**
 * lib/office-zeit.js
 * Stempel ans GNC Office (Zeiterfassung 4a): POST /api/zeit, HMAC-SHA256 über "<Unix-Sekunden>.<Körper>" wie bei den
 * Meldungen (lib/office-meldung.js), aber mit eigenem Geheimnis office-zeit-secret (Blob-Store geheimnisse).
 * Gegenstück im Office: functions/_lib/stempel.js (endpunkt).
 *
 * Ergebnis { status, daten }. Alles, was das Gerät später noch einmal senden soll, wird 503 office_weg: Office nicht
 * erreichbar, Zeitlimit, Fehler 5xx, Signatur abgelehnt (Geheimnis oder Uhr falsch) und fehlendes Geheimnis.
 */
const { geheimnisHolen } = require('./geheimnisse');
const { signieren } = require('./office-meldung');

const ZEITLIMIT_MS = 8000;
const zeitUrl = () => (process.env.OFFICE_URL || 'https://office.grillnchill-foodtruck.de').replace(/\/$/, '') + '/api/zeit';
const weg = (grund) => ({ status: 503, daten: { ok: false, fehler: 'office_weg', grund } });

async function anOffice(daten, { holen = fetch, geheimnis } = {}) {
  const g = geheimnis || (await geheimnisHolen('office-zeit-secret', 'OFFICE_ZEIT_SECRET'));
  if (g.length < 32) {
    console.error('office-zeit: office-zeit-secret fehlt oder ist kürzer als 32 Zeichen');
    return weg('nicht_eingerichtet');
  }
  const koerper = JSON.stringify({ v: 1, ...daten });
  const { zeit, signatur } = signieren(koerper, g);
  let r;
  try {
    r = await holen(zeitUrl(), {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-gnc-zeit': zeit, 'x-gnc-signatur': signatur },
      body: koerper, signal: AbortSignal.timeout(ZEITLIMIT_MS),
    });
  } catch (e) {
    console.error('office-zeit: nicht erreichbar', e && e.name);
    return weg('netz');
  }
  const d = await r.json().catch(() => null);
  if (!d || r.status >= 500) return weg('office_' + r.status);
  if (r.status === 401) {
    console.error('office-zeit: Office lehnt die Signatur ab', d.fehler);
    return weg('signatur');
  }
  return { status: r.status, daten: d };
}

module.exports = { anOffice, ZEITLIMIT_MS };
