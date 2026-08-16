/**
 * werkzeug/konto-angriffstest.js
 * ----------------------------------------------------------------------------
 * Versucht, ein fremdes Kundenkonto ohne Anmeldung zu oeffnen – gegen den
 * echten account.js-Handler.
 *
 * Hintergrund: Die Tokenpruefung schlug frueher mit rec.tokens[token] nach und
 * fand damit auch geerbte Eigenschaften. Wer "__proto__" als Token schickte,
 * kam in jedes Konto, dessen E-Mail-Adresse er kannte. Siehe
 * netlify/functions/lib/kunden-token.js.
 *
 * Aufruf:  node werkzeug/konto-angriffstest.js
 * Ausgang: 0 = Luecke zu, 1 = Konto weiterhin erreichbar
 * ----------------------------------------------------------------------------
 */
const path = require('path');
const Module = require('module');
const FUNCS = path.join(__dirname, '..', 'netlify', 'functions');

/* ---- Attrappe für @netlify/blobs ---------------------------------------- */
const daten = new Map();
const fakeBlobs = {
  getStore: () => ({
    async get(key) {
      const v = daten.get(key);
      return v === undefined ? null : JSON.parse(v);   // wie echt: JSON.parse
    },
    async setJSON(key, val) { daten.set(key, JSON.stringify(val)); },
    async delete(key) { daten.delete(key); },
    async list() { return { blobs: [...daten.keys()].map(key => ({ key })) }; },
  }),
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === '@netlify/blobs') return '@netlify/blobs';
  return origResolve.call(this, req, ...rest);
};
require.cache['@netlify/blobs'] = { id: '@netlify/blobs', exports: fakeBlobs, loaded: true };

/* ---- Opfer-Datensatz anlegen (wie nach einer echten Anmeldung) ----------- */
const crypto = require('crypto');
const OPFER = 'opfer@example.com';
const schluessel = 'c:' + crypto.createHash('sha256').update(OPFER).digest('hex');
const ECHTER_TOKEN = crypto.randomBytes(24).toString('hex');
daten.set(schluessel, JSON.stringify({
  email: OPFER,
  name: 'Erika Musterfrau',
  phone: '+49 151 1234567',
  birthday: '14.03.',
  business: { isBusiness: true, company: 'Muster GmbH', street: 'Hauptstr. 1', zip: '33649', city: 'Bielefeld' },
  addresses: [{ label: 'Zuhause', street: 'Hauptstr. 1', zip: '33649', city: 'Bielefeld' }],
  spent: 85, rewards: 2,
  tokens: { [ECHTER_TOKEN]: new Date().toISOString() },
}));

const account = require(path.join(FUNCS, 'account.js'));
const ruf = (body) => account.handler({ httpMethod: 'POST', body: JSON.stringify(body) });

(async () => {
  const zeile = (label, code, extra = '') =>
    console.log('  ' + label.padEnd(34) + '→ HTTP ' + code + '  ' + extra);

  console.log('\nANGRIFF: fremdes Konto ohne Anmeldung auslesen');
  console.log('Ziel: ' + OPFER + '  (Angreifer kennt NUR die E-Mail-Adresse)\n');

  let schlimm = false;
  for (const t of ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'irgendwas']) {
    const r = await ruf({ action: 'get', email: OPFER, token: t });
    const d = JSON.parse(r.body || '{}');
    const durch = r.statusCode === 200;
    if (durch) schlimm = true;
    zeile('token = "' + t + '"', r.statusCode,
      durch ? '❌ DURCHGELASSEN – Name: ' + (d.profile && d.profile.name) : '✅ abgewiesen');
  }

  console.log('\nÄndern und Löschen mit demselben Trick:');
  for (const a of ['save', 'delete']) {
    const r = await ruf({ action: a, email: OPFER, token: '__proto__', name: 'Gekapert' });
    if (r.statusCode === 200) schlimm = true;
    zeile('action = "' + a + '"', r.statusCode, r.statusCode === 200 ? '❌ DURCHGELASSEN' : '✅ abgewiesen');
  }

  console.log('\nGEGENPROBE: echter Token muss weiterhin funktionieren');
  const ok = await ruf({ action: 'get', email: OPFER, token: ECHTER_TOKEN });
  const okD = JSON.parse(ok.body || '{}');
  const echtGeht = ok.statusCode === 200 && okD.profile && okD.profile.name === 'Erika Musterfrau';
  zeile('echter 48-Zeichen-Token', ok.statusCode, echtGeht ? '✅ angenommen (Konto intakt)' : '❌ FEHLER – Kunde ausgesperrt!');

  console.log('\n' + '─'.repeat(66));
  console.log(!schlimm && echtGeht
    ? 'ERGEBNIS: ✅ Lücke geschlossen, bestehende Anmeldungen unberührt.'
    : 'ERGEBNIS: ❌ Problem besteht weiter.');
  process.exit(!schlimm && echtGeht ? 0 : 1);
})();
