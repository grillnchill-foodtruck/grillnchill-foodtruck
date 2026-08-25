#!/usr/bin/env node
/**
 * werkzeug/social-login-test.js
 * ----------------------------------------------------------------------------
 * Prüft die "Mit Apple/Google anmelden"-Strecke ohne Netz und ohne echte
 * Anbieter: ein eigenes Schlüsselpaar spielt Apple/Google, die JWKS-Abfrage
 * wird darauf umgebogen. So lässt sich beides testen – dass ein korrekt
 * signierter Ausweis durchkommt UND dass jede denkbare Fälschung scheitert.
 *
 *   node werkzeug/social-login-test.js
 * ----------------------------------------------------------------------------
 */

const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const originalLoad = Module._load;

/* --- Speicher nachbauen --- */
const SPEICHER = {};
const ablage = (name) => ({
  get: async (k) => (SPEICHER[name] || {})[k] ? JSON.parse(JSON.stringify(SPEICHER[name][k])) : null,
  setJSON: async (k, v) => { (SPEICHER[name] ||= {})[k] = JSON.parse(JSON.stringify(v)); },
  delete: async (k) => { delete (SPEICHER[name] || {})[k]; },
  list: async ({ prefix } = {}) => ({ blobs: Object.keys(SPEICHER[name] || {})
    .filter((k) => !prefix || k.startsWith(prefix)).map((key) => ({ key })) }),
});
Module._load = function (anfrage, ...rest) {
  if (anfrage === '@netlify/blobs') return { getStore: (o) => ablage(typeof o === 'string' ? o : o.name) };
  return originalLoad.call(this, anfrage, ...rest);
};

/* --- Eigenes Schluesselpaar spielt den Anbieter --- */
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const { publicKey: fremdPub, privateKey: fremdPriv } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = publicKey.export({ format: 'jwk' });
jwk.kid = 'testschluessel'; jwk.alg = 'RS256'; jwk.use = 'sig';

global.fetch = async (url) => {
  if (String(url).includes('/auth/keys') || String(url).includes('oauth2/v3/certs')) {
    return { ok: true, json: async () => ({ keys: [jwk] }) };
  }
  throw new Error('unerwarteter Abruf: ' + url);
};
process.env.GOOGLE_LOGIN_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

const b64u = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function baueToken(daten, schluessel = privateKey, kopf = { alg: 'RS256', kid: 'testschluessel' }) {
  const basis = b64u(kopf) + '.' + b64u(daten);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(basis), schluessel);
  return basis + '.' + sig.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const jetzt = Math.floor(Date.now() / 1000);
const googleDaten = (extra = {}) => ({
  iss: 'https://accounts.google.com', aud: 'test-client-id.apps.googleusercontent.com',
  sub: '123', email: 'kunde@example.org', email_verified: true, exp: jetzt + 300, ...extra,
});
const appleDaten = (extra = {}) => ({
  iss: 'https://appleid.apple.com', aud: 'de.grillnchillfoodtruck.app',
  sub: 'apfel-1', email: 'abc123@privaterelay.appleid.com', email_verified: 'true', exp: jetzt + 300, ...extra,
});

const gruen = (t) => '\x1b[32m' + t + '\x1b[0m';
const rot = (t) => '\x1b[31m' + t + '\x1b[0m';
let fehler = 0;
const pruefe = (name, ok, d) => { if (!ok) fehler++; console.log('  ' + (ok ? gruen('✅') : rot('❌')) + ' ' + name.padEnd(52) + (d || '')); };

const { handler } = require(path.join(__dirname, '..', 'netlify', 'functions', 'social-login.js'));
const ruf = (body) => handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) });

(async () => {
  console.log('\nAnmeldung mit Apple/Google\n' + '─'.repeat(74) + '\n');

  console.log('1) Echte Ausweise kommen durch');
  let r = await ruf({ anbieter: 'google', idToken: baueToken(googleDaten()), name: 'Test Kunde',
                      localLoyalty: { spent: 40, rewards: 1 } });
  let d = JSON.parse(r.body);
  pruefe('Google-Anmeldung → Token', r.statusCode === 200 && !!d.token, d.email);
  const konto = SPEICHER['customers']['c:' + crypto.createHash('sha256').update('kunde@example.org').digest('hex')];
  pruefe('Konto angelegt, Name übernommen', konto && konto.name === 'Test Kunde');
  pruefe('Stempelkarte einmalig übernommen', konto.spent === 40 && konto.rewards === 1 && konto.merged === true);

  r = await ruf({ anbieter: 'apple', idToken: baueToken(appleDaten()) });
  d = JSON.parse(r.body);
  pruefe('Apple-Anmeldung (Weiterleitungsadresse)', r.statusCode === 200 && !!d.token, d.email);

  console.log('\n2) Gleiches Konto bei erneuter Anmeldung');
  r = await ruf({ anbieter: 'google', idToken: baueToken(googleDaten()), localLoyalty: { spent: 99, rewards: 9 } });
  const konto2 = SPEICHER['customers']['c:' + crypto.createHash('sha256').update('kunde@example.org').digest('hex')];
  pruefe('kein Doppelkonto', Object.keys(SPEICHER['customers']).length === 2);
  pruefe('Stempelkarte NICHT doppelt übernommen', konto2.spent === 40 && konto2.rewards === 1);
  pruefe('zweiter Anmelde-Token zusätzlich', Object.keys(konto2.tokens).length === 2);

  console.log('\n3) Fälschungen scheitern');
  const faelle = [
    ['fremder Schlüssel, gleicher kid', { anbieter: 'google', idToken: baueToken(googleDaten(), fremdPriv) }],
    ['abgelaufen', { anbieter: 'google', idToken: baueToken(googleDaten({ exp: jetzt - 3600 })) }],
    ['falscher Empfänger (andere App)', { anbieter: 'google', idToken: baueToken(googleDaten({ aud: 'boese-app' })) }],
    ['falscher Aussteller', { anbieter: 'google', idToken: baueToken(googleDaten({ iss: 'https://boese.example' })) }],
    ['E-Mail nicht bestätigt (Google)', { anbieter: 'google', idToken: baueToken(googleDaten({ email_verified: false })) }],
    ['Apple-Token beim Google-Zweig', { anbieter: 'google', idToken: baueToken(appleDaten()) }],
    ['alg none', { anbieter: 'google', idToken: b64u({ alg: 'none' }) + '.' + b64u(googleDaten()) + '.' }],
    ['manipulierte Nutzdaten', { anbieter: 'google', idToken: (() => {
        const t = baueToken(googleDaten()).split('.');
        return t[0] + '.' + b64u(googleDaten({ email: 'angreifer@example.org' })) + '.' + t[2];
      })() }],
    ['leer', { anbieter: 'google', idToken: '' }],
    ['unbekannter Anbieter', { anbieter: 'facebook', idToken: baueToken(googleDaten()) }],
  ];
  for (const [name, body] of faelle) {
    const res = await ruf(body);
    pruefe(name + ' → abgelehnt', res.statusCode === 401 || res.statusCode === 400, 'HTTP ' + res.statusCode);
  }
  pruefe('kein Konto für den Angreifer entstanden',
    !SPEICHER['customers']['c:' + crypto.createHash('sha256').update('angreifer@example.org').digest('hex')]);

  console.log('\n' + '─'.repeat(74));
  console.log(fehler === 0
    ? gruen('ERGEBNIS: ✅ Echte Ausweise rein, alle Fälschungen draußen, ein Konto je Adresse.')
    : rot('ERGEBNIS: ❌ ' + fehler + ' Prüfung(en) fehlgeschlagen.'));
  process.exit(fehler === 0 ? 0 : 1);
})().catch((e) => { console.error(rot('Abbruch: ' + e.stack)); process.exit(1); });
