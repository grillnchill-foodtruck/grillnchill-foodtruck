/**
 * lib/id-token.js
 * ----------------------------------------------------------------------------
 * Prüft Anmelde-Ausweise (ID-Tokens) von Apple und Google.
 *
 * Ablauf "Mit Apple/Google anmelden": Der Anbieter gibt dem Gerät ein
 * signiertes Token (JWT) mit der bestätigten E-Mail-Adresse. Der Server darf
 * dem Gerät NICHTS davon glauben – er prüft die Signatur selbst gegen die
 * öffentlichen Schlüssel des Anbieters (JWKS), dazu Aussteller, Empfänger
 * und Ablaufzeit. Erst dann gilt die E-Mail als echt.
 *
 * Bewusst ohne Fremdbibliothek: Node kann seit v17 JWK-Schlüssel direkt
 * importieren (crypto.createPublicKey({format:'jwk'})) und RS256 pruefen.
 *
 * Empfänger (aud):
 *   Apple  = die Bundle-ID der iOS-App (fest, kein Geheimnis)
 *   Google = die OAuth-Client-ID aus der Umgebung (GOOGLE_LOGIN_CLIENT_ID)
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');

const ANBIETER = {
  apple: {
    jwks: 'https://appleid.apple.com/auth/keys',
    iss: ['https://appleid.apple.com'],
    aud: () => 'de.grillnchillfoodtruck.app',
  },
  google: {
    jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    iss: ['https://accounts.google.com', 'accounts.google.com'],
    aud: () => process.env.GOOGLE_LOGIN_CLIENT_ID || '',
  },
};

/* Schlüssel je Anbieter kurz merken – die Function lebt zwischen Aufrufen
   weiter, und die JWKS ändern sich selten. 10 Minuten sind konservativ. */
const cache = {};
async function holeJwks(anbieter, holen) {
  const c = cache[anbieter];
  if (c && Date.now() - c.stand < 10 * 60 * 1000) return c.keys;
  const res = await (holen || fetch)(ANBIETER[anbieter].jwks);
  if (!res.ok) throw new Error('JWKS nicht erreichbar: HTTP ' + res.status);
  const { keys } = await res.json();
  cache[anbieter] = { keys, stand: Date.now() };
  return keys;
}

const b64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/**
 * Token prüfen.
 * @returns {{email: string, emailVerified: boolean, sub: string}} bei Erfolg
 * @throws bei jedem Mangel – der Aufrufer antwortet dann 401.
 */
async function pruefeIdToken(anbieter, token, holen) {
  const def = ANBIETER[anbieter];
  if (!def) throw new Error('unbekannter Anbieter');
  const erwarteteAud = def.aud();
  if (!erwarteteAud) throw new Error('Anbieter nicht konfiguriert (Client-ID fehlt)');

  const teile = String(token || '').split('.');
  if (teile.length !== 3) throw new Error('kein JWT');
  const kopf = JSON.parse(b64url(teile[0]).toString('utf8'));
  const daten = JSON.parse(b64url(teile[1]).toString('utf8'));

  if (kopf.alg !== 'RS256') throw new Error('unerwarteter Algorithmus: ' + kopf.alg);

  // Passenden öffentlichen Schlüssel suchen und Signatur prüfen
  const keys = await holeJwks(anbieter, holen);
  const jwk = keys.find((k) => k.kid === kopf.kid);
  if (!jwk) throw new Error('Signaturschlüssel unbekannt');
  const pub = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256',
    Buffer.from(teile[0] + '.' + teile[1]), pub, b64url(teile[2]));
  if (!ok) throw new Error('Signatur ungültig');

  // Aussteller, Empfänger, Ablauf
  if (!def.iss.includes(daten.iss)) throw new Error('falscher Aussteller');
  const aud = Array.isArray(daten.aud) ? daten.aud : [daten.aud];
  if (!aud.includes(erwarteteAud)) throw new Error('falscher Empfänger');
  if (!daten.exp || Date.now() / 1000 > daten.exp + 60) throw new Error('Token abgelaufen');

  const email = String(daten.email || '').trim().toLowerCase();
  if (!email) throw new Error('Token ohne E-Mail');
  // Apple liefert email_verified teils als String "true"
  const emailVerified = daten.email_verified === true || daten.email_verified === 'true';

  return { email, emailVerified, sub: String(daten.sub || '') };
}

module.exports = { pruefeIdToken };
