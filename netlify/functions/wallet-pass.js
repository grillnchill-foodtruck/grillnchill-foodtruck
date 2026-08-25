/**
 * wallet-pass.js
 * ----------------------------------------------------------------------------
 * Kundenkarte fürs Handy-Wallet (Stufe 2/3 der Wallet-Roadmap).
 *
 *   GET  → { google: bool, apple: bool }   Welche Wallets sind konfiguriert?
 *          (Der Client blendet Buttons nur ein, wenn hier true kommt.)
 *   POST { action:'google'|'apple', email, token }  → { url }
 *          Auth = gültiges Konto-Login-Token (wie account.js).
 *
 * GOOGLE WALLET (aktiv, sobald diese Env-Variablen in Netlify gesetzt sind):
 *   GOOGLE_WALLET_ISSUER_ID  – Issuer-ID aus der Google Pay & Wallet Console
 *   GOOGLE_WALLET_SA_EMAIL   – Service-Account-E-Mail (…@…iam.gserviceaccount.com)
 *   GOOGLE_WALLET_SA_KEY_B64 – private_key aus der Service-Account-JSON, Base64-kodiert
 *                              (base64 -w0 key.pem – inkl. BEGIN/END-Zeilen)
 *   → Erzeugt einen signierten "Save to Google Wallet"-Link. Klasse + Objekt
 *     stecken komplett im JWT (kein Vorab-API-Call nötig); Punktestand ist der
 *     Stand beim Hinzufügen. Live-Sync nach jeder Bestellung = Folgeausbau.
 *
 * APPLE WALLET (Stufe 3 – Gerüst steht, wartet auf Zertifikat):
 *   APPLE_TEAM_ID, APPLE_PASS_TYPE_ID, APPLE_PASS_CERT_P12_B64,
 *   APPLE_PASS_CERT_PASSWORD
 *   → .pkpass-Signierung (PKCS#7) braucht eine Signier-Bibliothek; sobald das
 *     Developer-Konto samt Pass-Zertifikat da ist, wird dieser Zweig gefüllt.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { tokenGueltig } = require('./lib/kunden-token');
const applePass = require('./lib/apple-pass');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify(data),
});

function store() {
  const opts = { name: 'customers', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

function googleConfigured() {
  return !!(process.env.GOOGLE_WALLET_ISSUER_ID
    && process.env.GOOGLE_WALLET_SA_EMAIL
    && process.env.GOOGLE_WALLET_SA_KEY_B64);
}
function appleConfigured() {
  return applePass.konfiguriert();
}
function walletStore() {
  const opts = { name: 'wallet', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

const LEVEL_NAMES = ['Grill Rookie', 'Bun Boss', 'Patty Pro', 'Sauce Sensei', 'Cheese Melter', 'Flame Rider', 'Ember Elite', 'Grill Guru', 'Street Legende', 'King of Chill'];
function custLevel(rec) {
  const lv = Math.min(10, 1 + (rec.cards || 0));
  return { level: lv, levelName: LEVEL_NAMES[lv - 1] };
}
function buildGoogleSaveUrl(rec, custId) {
  const issuer = process.env.GOOGLE_WALLET_ISSUER_ID;
  const saEmail = process.env.GOOGLE_WALLET_SA_EMAIL;
  const key = Buffer.from(process.env.GOOGLE_WALLET_SA_KEY_B64, 'base64').toString('utf-8');
  const isRoyal = custLevel(rec).level >= 10;
  const classId = issuer + (isRoyal ? '.gnc_loyalty_royal' : '.gnc_loyalty');
  const objectId = issuer + '.gnc_' + custId + (isRoyal ? '_royal' : '');
  const siteUrl = (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');

  const loyaltyClass = {
    id: classId,
    issuerName: "Grill'n Chill",
    programName: 'Kundenkarte',
    programLogo: { sourceUri: { uri: siteUrl + '/logo.png' } },
    reviewStatus: 'UNDER_REVIEW',
    hexBackgroundColor: isRoyal ? '#B8860B' : '#0C0B09',
  };
  if (isRoyal) loyaltyClass.programName = 'Kundenkarte \u00b7 Royal';
  const loyaltyObject = {
    id: objectId,
    classId,
    state: 'ACTIVE',
    accountName: rec.name || rec.email,
    accountId: rec.email,
    barcode: { type: 'QR_CODE', value: 'GNCQR:' + rec.qrToken, alternateText: 'Am Truck vorzeigen' },
    loyaltyPoints: {
      label: '5-€-Boni',
      balance: { int: rec.rewards || 0 },
    },
    secondaryLoyaltyPoints: {
      label: 'Level',
      balance: { string: custLevel(rec).level + ' · ' + custLevel(rec).levelName },
    },
    textModulesData: [{
      header: 'Bis zum nächsten Bonus',
      body: (Math.max(0, Math.round((100 - (rec.spent || 0)) * 100) / 100)).toFixed(2).replace('.', ',') + ' € Umsatz',
      id: 'to_next',
    }],
  };

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: saEmail,
    aud: 'google',
    typ: 'savetowallet',
    iat: now,
    origins: [siteUrl],
    payload: { loyaltyClasses: [loyaltyClass], loyaltyObjects: [loyaltyObject] },
  };
  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(claims));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = b64url(signer.sign(key));
  return 'https://pay.google.com/gp/v/save/' + signingInput + '.' + signature;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  if (event.httpMethod === 'GET') {
    // Pass-Auslieferung: der "Zu Apple Wallet"-Knopf oeffnet diese URL mit
    // einem kurzlebigen, signierten Beweis (5 Min) - siehe POST apple unten.
    const dl = (event.queryStringParameters || {}).apple;
    if (dl) {
      if (!appleConfigured()) return json(503, { error: 'not_configured' });
      const emailHash = applePass.pruefeDownloadToken(dl);
      if (!emailHash) return json(403, { error: 'link_expired', hint: 'Link abgelaufen – bitte den Knopf im Konto erneut antippen.' });
      const rec = await store().get('c:' + emailHash, { type: 'json' });
      if (!rec || !rec.qrToken) return json(404, { error: 'no_card' });
      try {
        const pkpass = applePass.bauePass(rec, emailHash);
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/vnd.apple.pkpass',
            'Content-Disposition': 'attachment; filename="grillnchill-kundenkarte.pkpass"',
            'Cache-Control': 'no-store',
            ...CORS,
          },
          body: pkpass.toString('base64'),
          isBase64Encoded: true,
        };
      } catch (e) {
        console.error('apple-pass:', e.message);
        return json(500, { error: 'sign_failed' });
      }
    }
    return json(200, { google: googleConfigured(), apple: appleConfigured() });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }

  // Konto-Auth wie in account.js: E-Mail + gültiges Login-Token.
  // Geprüft wird über lib/kunden-token.js – ein direktes rec.tokens[token]
  // fand auch geerbte Eigenschaften ("__proto__" & Co.) und gab die
  // Kundenkarte samt qrToken an jeden heraus, der die Adresse kannte.
  const email = String(input.email || '').trim().toLowerCase().slice(0, 120);
  const token = String(input.token || '').slice(0, 80);
  if (!email || !token) return json(401, { error: 'unauthorized' });
  const s = store();
  const key = 'c:' + sha(email);
  const rec = await s.get(key, { type: 'json' });
  if (!tokenGueltig(rec, token)) return json(401, { error: 'unauthorized' });
  if (!rec.qrToken) return json(409, { error: 'no_card', hint: 'Konto einmal öffnen, dann existiert die Kundenkarte.' });

  if (input.action === 'google') {
    if (!googleConfigured()) return json(503, { error: 'not_configured', hint: 'Google Wallet ist noch nicht eingerichtet.' });
    try {
      const url = buildGoogleSaveUrl(rec, sha(email).slice(0, 16));
      return json(200, { ok: true, url });
    } catch (e) {
      return json(500, { error: 'sign_failed', hint: 'Signatur fehlgeschlagen – Service-Account-Key prüfen.' });
    }
  }

  if (input.action === 'apple') {
    if (!appleConfigured()) return json(503, { error: 'not_configured', hint: 'Apple Wallet ist noch nicht eingerichtet.' });
    try {
      const emailHash = sha(email);
      // Seriennummer -> Kunde merken: braucht der Aktualisierungs-Dienst
      // (wallet-api.js), um zu einer Seriennummer den Datensatz zu finden.
      await walletStore().setJSON('serial:' + applePass.serialFuer(emailHash), { k: emailHash });
      const siteUrl = (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');
      const url = siteUrl + '/wallet-pass?apple=' + applePass.downloadToken(emailHash, Date.now() + 5 * 60 * 1000);
      return json(200, { ok: true, url });
    } catch (e) {
      console.error('apple-pass:', e.message);
      return json(500, { error: 'sign_failed', hint: 'Signatur fehlgeschlagen – Zertifikat-Variablen prüfen.' });
    }
  }

  return json(400, { error: 'unknown_action' });
};
