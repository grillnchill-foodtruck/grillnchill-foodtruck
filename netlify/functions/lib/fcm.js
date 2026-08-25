/**
 * lib/fcm.js
 * ----------------------------------------------------------------------------
 * Versand an die iOS-App über Firebase Cloud Messaging (Thema "alle").
 *
 * Warum der Umweg: Im WKWebView der iOS-App gibt es keinen Web-Push. Die App
 * abonniert deshalb nativ das FCM-Thema "alle" (Brücke in der App); der
 * Admin-Versand schickt EINE Nachricht an dieses Thema, Apple stellt zu.
 *
 * Zugang: Firebase-Dienstkonto als Netlify-Umgebungsvariable
 * FIREBASE_SERVICE_ACCOUNT (kompletter JSON-Inhalt der Schlüsseldatei aus
 * Projekteinstellungen → Dienstkonten). Das ist ein GEHEIMNIS – niemals ins
 * Repo. Fehlt die Variable, meldet dieser Baustein schlicht "nicht
 * eingerichtet" und der Web-Push läuft unverändert weiter.
 *
 * Ohne Fremdbibliothek: der Zugangs-Token ist ein selbst signiertes JWT
 * (RS256, Node-crypto), eingetauscht bei Googles Token-Endpunkt. Er wird für
 * seine Lebensdauer (~1h) wiederverwendet.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');

const b64u = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* Dienstkonto: Env hat Vorrang (lokale Tests); im Betrieb liegt die JSON im
   Blobs-Store "geheim" ('firebase-service-account') - das AWS-4KB-Limit fuer
   Umgebungsvariablen liess sie dort nicht mehr zu. */
async function dienstkonto() {
  let roh = process.env.FIREBASE_SERVICE_ACCOUNT || '';
  if (!roh) {
    try { roh = (await require('./geheim').holeGeheim('firebase-service-account')) || ''; }
    catch (e) { roh = ''; }
  }
  if (!roh) return null;
  try {
    const sa = JSON.parse(roh);
    return (sa.client_email && sa.private_key && sa.project_id) ? sa : null;
  } catch (e) { return null; }
}

/* Zugangs-Token zwischen Aufrufen behalten – die Function lebt weiter. */
let tokenCache = { wert: null, ablauf: 0 };

async function zugangsToken(sa, holen) {
  if (tokenCache.wert && Date.now() < tokenCache.ablauf - 60000) return tokenCache.wert;
  const jetzt = Math.floor(Date.now() / 1000);
  const kopf = b64u({ alg: 'RS256', typ: 'JWT' });
  const daten = b64u({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: jetzt, exp: jetzt + 3600,
  });
  const signatur = crypto.sign('RSA-SHA256', Buffer.from(kopf + '.' + daten), sa.private_key)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const antwort = await (holen || fetch)('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')
      + '&assertion=' + (kopf + '.' + daten + '.' + signatur),
  });
  const d = await antwort.json();
  if (!antwort.ok || !d.access_token) {
    throw new Error('FCM-Token fehlgeschlagen: ' + (d.error_description || d.error || antwort.status));
  }
  tokenCache = { wert: d.access_token, ablauf: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
  return tokenCache.wert;
}

/**
 * Nachricht an alle iOS-Abonnenten (Thema "alle").
 * @returns {{ok: boolean, grund?: string}} – wirft nie; ein iOS-Fehler darf
 *          den Web-Push-Versand nicht mitreißen.
 */
async function sendeAnIOS(titel, text, url, holen) {
  const sa = await dienstkonto();
  if (!sa) return { ok: false, grund: 'nicht_eingerichtet' };
  try {
    const token = await zugangsToken(sa, holen);
    const antwort = await (holen || fetch)(
      'https://fcm.googleapis.com/v1/projects/' + encodeURIComponent(sa.project_id) + '/messages:send', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            topic: 'alle',
            notification: { title: titel, body: text },
            data: { url: url || '/' },
            apns: { payload: { aps: { sound: 'default' } } },
          },
        }),
      });
    if (!antwort.ok) {
      const d = await antwort.json().catch(() => ({}));
      throw new Error('FCM-Versand: HTTP ' + antwort.status + ' ' + JSON.stringify(d.error || {}).slice(0, 120));
    }
    return { ok: true };
  } catch (e) {
    console.error('fcm:', e.message);
    return { ok: false, grund: String(e.message).slice(0, 160) };
  }
}

module.exports = { sendeAnIOS, dienstkonto };
