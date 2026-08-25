/**
 * lib/wallet-google.js
 * ----------------------------------------------------------------------------
 * Live-Aktualisierung der Google-Wallet-Kundenkarte.
 *
 * Anders als bei Apple braucht es keinen Push: Wir aendern das gespeicherte
 * Karten-Objekt direkt ueber Googles Wallet-API (PATCH), und alle Handys, die
 * die Karte im Wallet haben, ziehen sich den neuen Stand von selbst.
 *
 * Zugang: derselbe Service-Account wie beim "Save to Google Wallet"-Link
 * (GOOGLE_WALLET_SA_EMAIL + GOOGLE_WALLET_SA_KEY_B64 + GOOGLE_WALLET_ISSUER_ID).
 * OAuth-Token wie in lib/fcm.js: selbst signiertes JWT gegen Googles
 * Token-Endpunkt, fuer die Laufzeit wiederverwendet.
 *
 * 404 = Kunde hat die Karte nie gespeichert -> kein Fehler, einfach still.
 * Grenze der Gold-Stufe: die Kartenfarbe haengt an der Klasse und laesst sich
 * an einem gespeicherten Objekt nicht umhaengen - Punkte/Level aktualisieren
 * sich live, GOLD wird die Karte beim erneuten Hinzufuegen im Konto.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');

function konfiguriert() {
  return !!(process.env.GOOGLE_WALLET_ISSUER_ID
    && process.env.GOOGLE_WALLET_SA_EMAIL
    && process.env.GOOGLE_WALLET_SA_KEY_B64);
}

const b64u = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let tokenCache = { wert: null, ablauf: 0 };
async function zugangsToken(holen) {
  if (tokenCache.wert && Date.now() < tokenCache.ablauf - 60000) return tokenCache.wert;
  const key = Buffer.from(process.env.GOOGLE_WALLET_SA_KEY_B64, 'base64').toString('utf8');
  const jetzt = Math.floor(Date.now() / 1000);
  const kopf = b64u({ alg: 'RS256', typ: 'JWT' });
  const daten = b64u({
    iss: process.env.GOOGLE_WALLET_SA_EMAIL,
    scope: 'https://www.googleapis.com/auth/wallet_object.issuer',
    aud: 'https://oauth2.googleapis.com/token',
    iat: jetzt, exp: jetzt + 3600,
  });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(kopf + '.' + daten), key)
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const antwort = await (holen || fetch)('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')
      + '&assertion=' + (kopf + '.' + daten + '.' + sig),
  });
  const d = await antwort.json();
  if (!antwort.ok || !d.access_token) throw new Error('Wallet-Token: ' + (d.error || antwort.status));
  tokenCache = { wert: d.access_token, ablauf: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
  return tokenCache.wert;
}

const LEVEL_NAMES = ['Grill Rookie', 'Bun Boss', 'Patty Pro', 'Sauce Sensei', 'Cheese Melter', 'Flame Rider', 'Ember Elite', 'Grill Guru', 'Street Legende', 'King of Chill'];

/**
 * Punktestand/Level auf der gespeicherten Google-Karte aktualisieren.
 * Wirft nie. @param custId sha256(email).slice(0,16) – wie beim Erstellen.
 */
async function aktualisiereGoogleKarte(rec, custId, holen) {
  try {
    if (!konfiguriert()) return { ok: false, grund: 'nicht_eingerichtet' };
    const issuer = process.env.GOOGLE_WALLET_ISSUER_ID;
    const level = Math.min(10, 1 + (rec.cards || 0));
    const patch = {
      loyaltyPoints: { label: '5-€-Boni', balance: { int: rec.rewards || 0 } },
      secondaryLoyaltyPoints: {
        label: 'Level',
        balance: { string: level + ' · ' + LEVEL_NAMES[level - 1] },
      },
      textModulesData: [{
        header: 'Bis zum nächsten Bonus',
        body: (Math.max(0, Math.round((100 - (rec.spent || 0)) * 100) / 100)).toFixed(2).replace('.', ',') + ' € Umsatz',
        id: 'to_next',
      }],
    };
    const token = await zugangsToken(holen);
    // Beide moeglichen Objekt-IDs versuchen: die normale Karte und - ab der
    // Gold-Stufe - auch die Royal-Karte. 404 heisst nur "nie gespeichert".
    const ids = [issuer + '.gnc_' + custId];
    if (level >= 10) ids.push(issuer + '.gnc_' + custId + '_royal');
    let aktualisiert = 0;
    for (const id of ids) {
      const antwort = await (holen || fetch)(
        'https://walletobjects.googleapis.com/walletobjects/v1/loyaltyObject/' + encodeURIComponent(id), {
          method: 'PATCH',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
      if (antwort.ok) aktualisiert++;
      else if (antwort.status !== 404) {
        const d = await antwort.json().catch(() => ({}));
        console.error('wallet-google:', antwort.status, JSON.stringify(d.error || {}).slice(0, 120));
      }
    }
    return { ok: true, aktualisiert };
  } catch (e) {
    console.error('wallet-google:', e.message);
    return { ok: false, grund: String(e.message).slice(0, 120) };
  }
}

module.exports = { aktualisiereGoogleKarte, konfiguriert };
