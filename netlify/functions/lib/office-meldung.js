'use strict';
/**
 * lib/office-meldung.js
 * Meldungen ans GNC Office (Plan 2): HMAC-SHA256 über "<Unix-Sekunden>.<Körper>", gemeinsames Geheimnis
 * office-eingang-secret (Blob-Store geheimnisse), höchstens 5 Meldungen je Anfrage.
 * Gegenstück im Office: functions/_lib/eingang.js.
 */
const crypto = require('crypto');
const { geheimnisHolen } = require('./geheimnisse');

const PAKET = 5;
const ZEITLIMIT_MS = 10000;

function signieren(koerper, geheimnis, zeit = Math.floor(Date.now() / 1000)) {
  const z = String(zeit);
  return { zeit: z, signatur: crypto.createHmac('sha256', geheimnis).update(z + '.' + koerper).digest('base64url') };
}

const eingangUrl = () => (process.env.OFFICE_URL || 'https://office.grillnchill-foodtruck.de').replace(/\/$/, '') + '/api/eingang';

async function senden(meldungen, { holen = fetch, geheimnis } = {}) {
  const g = geheimnis || (await geheimnisHolen('office-eingang-secret', 'OFFICE_EINGANG_SECRET'));
  if (g.length < 32) return { ergebnisse: [], offen: null, sicherung: undefined, fehler: 'nicht_eingerichtet' };
  const ergebnisse = [];
  let offen = null;
  let sicherung;
  for (let i = 0; i < meldungen.length; i += PAKET) {
    const koerper = JSON.stringify({ v: 1, meldungen: meldungen.slice(i, i + PAKET) });
    const { zeit, signatur } = signieren(koerper, g);
    let r;
    try {
      r = await holen(eingangUrl(), {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-gnc-zeit': zeit, 'x-gnc-signatur': signatur },
        body: koerper, signal: AbortSignal.timeout(ZEITLIMIT_MS),
      });
    } catch (e) {
      return { ergebnisse, offen, sicherung, fehler: 'netz: ' + String(e && e.message).slice(0, 100) };
    }
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !Array.isArray(d.ergebnisse)) return { ergebnisse, offen, sicherung, fehler: `office_${r.status}${d.fehler ? ' ' + d.fehler : ''}` };
    ergebnisse.push(...d.ergebnisse);
    offen = d.offen;
    sicherung = d.sicherung;
  }
  return { ergebnisse, offen, sicherung, fehler: null };
}

module.exports = { signieren, senden, PAKET };
