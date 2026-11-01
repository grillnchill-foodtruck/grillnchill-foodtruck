#!/usr/bin/env node
/**
 * werkzeug/gutschein-zaehlertest.js
 * ----------------------------------------------------------------------------
 * Prüft, ob eingelöste Gutscheine wirklich gezählt werden – und ob die
 * Mengenbegrenzung greift.
 *
 * Hintergrund: Die Umwandlung "Code -> Speicherschlüssel" stand viermal im
 * Code und lief auseinander. Anlegen, Prüfen und Nachrechnen erlaubten
 * Umlaute, das Zählen nicht. Ein Code wie "GRÜN10" lag als `c:GRÜN10` im
 * Speicher, wurde beim Einlösen gefunden (der Rabatt griff also), beim Zählen
 * aber als `c:GRN10` gesucht. Folge: der Zähler blieb auf "0 / 1 eingelöst",
 * und maxUses war für solche Codes nicht durchsetzbar – beliebig oft einlösbar.
 *
 * Der Test fährt die ECHTE send-email-Function gegen einen nachgebauten
 * Speicher. Kein Netz, keine Mails, keine Zugangsdaten nötig.
 *
 * Seit November 2026 auch: Zählung je Telefonnummer neben der E-Mail
 * (lib/gutschein-nutzung.js), Vereinheitlichung der Nummer, eine Bestellung
 * zählt nur einmal, Wegwerf-Adressen zählen nicht.
 *
 *   node werkzeug/gutschein-zaehlertest.js
 * ----------------------------------------------------------------------------
 */

const path = require('path');
const Module = require('module');
const originalLoad = Module._load;

/* --- Speicher und Netz nachbauen ------------------------------------------ */
const SPEICHER = {};
const ablage = (name) => ({
  get: async (k) => (SPEICHER[name] || {})[k] ? JSON.parse(JSON.stringify(SPEICHER[name][k])) : null,
  setJSON: async (k, v) => { (SPEICHER[name] ||= {})[k] = JSON.parse(JSON.stringify(v)); },
  set: async (k, v, o) => {
    SPEICHER[name] ||= {};
    if (o && o.onlyIfNew && SPEICHER[name][k]) return { modified: false };
    SPEICHER[name][k] = v; return { modified: true };
  },
  delete: async (k) => { delete (SPEICHER[name] || {})[k]; },
  list: async ({ prefix } = {}) => ({
    blobs: Object.keys(SPEICHER[name] || {})
      .filter((k) => !prefix || k.startsWith(prefix)).map((key) => ({ key })),
  }),
});
Module._load = function (anfrage, ...rest) {
  if (anfrage === '@netlify/blobs') {
    return { getStore: (o) => ablage(typeof o === 'string' ? o : o.name) };
  }
  if (anfrage === 'web-push') return { setVapidDetails() {}, sendNotification: async () => ({}) };
  return originalLoad.call(this, anfrage, ...rest);
};
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '' });

/* Die Function bricht ohne diese Werte vorzeitig ab – Platzhalter genügen. */
Object.assign(process.env, {
  BREVO_API_KEY: 'test', BREVO_SENDER_EMAIL: 'test@example.org',
  OWNER_EMAIL: 'inhaber@example.org', SITE_URL: 'https://example.org',
  STATUS_UPDATE_SECRET: 'test', STATUS_SECRET: 'test',
});

const { handler } = require(path.join(__dirname, '..', 'netlify', 'functions', 'send-email.js'));

/* --- Hilfen --------------------------------------------------------------- */
const gruen = (t) => '\x1b[32m' + t + '\x1b[0m';
const rot = (t) => '\x1b[31m' + t + '\x1b[0m';
let fehler = 0;
function pruefe(name, bestanden, detail) {
  if (!bestanden) fehler++;
  console.log('  ' + (bestanden ? gruen('✅') : rot('❌')) + ' ' + name.padEnd(46) + (detail || ''));
}

function legeAn(code, extra = {}) {
  SPEICHER['vouchers'] ||= {};
  SPEICHER['vouchers']['c:' + code] = {
    code, type: 'fixed', value: 5, minOrder: 0, maxUses: 1,
    oncePerCustomer: false, combinable: false, mode: 'any',
    active: true, uses: 0, usedBy: {}, ...extra,
  };
}
const bestellung = (code) => ({
  reference: 'GNC-' + Math.floor(Math.random() * 1e9),
  name: 'Test', email: 'kunde@example.org', phone: '0170',
  mode: 'pickup', payment: 'cash',
  items: [{ name: 'Burger', qty: 1, price: 12.9, total: 12.9 }],
  subtotal: 12.9, discount: 5, loyaltyDiscount: 0, deliveryFee: 0, tip: 0, total: 7.9,
  voucherCode: code, promo: { code }, cartSnapshot: {}, isTest: false,
});
const einloesen = (code) => handler({
  httpMethod: 'POST', headers: {},
  body: JSON.stringify({ type: 'order_confirmation', order: bestellung(code) }),
});
const stand = (code) => SPEICHER['vouchers']['c:' + code];

/* --- Durchlauf ------------------------------------------------------------ */
(async () => {
  console.log('\nGutschein-Zähler\n' + '─'.repeat(74) + '\n');

  console.log('1) Einlösung wird gezählt');
  for (const [code, was] of [
    ['GNCK7M2PQR', 'Geschenkgutschein (GNC + 6 Zeichen)'],
    ['SOMMER20', 'Aktionscode ohne Umlaut'],
    ['GRÜN10', 'Aktionscode mit Umlaut'],
    ['ŞENLIK', 'Aktionscode mit türkischem Zeichen'],
  ]) {
    legeAn(code);
    await einloesen(code);
    const v = stand(code);
    pruefe(was, v.uses === 1, 'uses=' + v.uses);
  }

  console.log('\n2) Mengenbegrenzung wird durchgesetzt');
  for (const code of ['SOMMER20', 'GRÜN10']) {
    legeAn(code, { maxUses: 1 });
    for (let i = 0; i < 4; i++) await einloesen(code);
    const v = stand(code);
    pruefe('maxUses=1 trotz 4 Bestellungen · ' + code,
      v.uses === 1 && v.active === false, 'uses=' + v.uses + ', aktiv=' + v.active);
  }

  console.log('\n3) Ein Kunde, Begrenzung pro Kunde');
  legeAn('EINMAL', { maxUses: 0, oncePerCustomer: true });
  for (let i = 0; i < 3; i++) await einloesen('EINMAL');
  const e = stand('EINMAL');
  pruefe('oncePerCustomer greift', e.uses === 1, 'uses=' + e.uses);

  console.log('\n4) Telefonnummer zählt mit (GRILL5-Regel: max. 3 pro Kunde)');
  const crypto = require('crypto');
  const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
  const zaehler = (k) => (SPEICHER.vouchers[k] || {}).n || 0;
  const mitKunde = (code, email, phone, ref) => handler({
    httpMethod: 'POST', headers: {},
    body: JSON.stringify({ type: 'order_confirmation', order: { ...bestellung(code), email, phone, reference: ref || bestellung(code).reference } }),
  });
  legeAn('TELTEST', { maxUses: 0, maxPerCustomer: 3, createdAt: '2026-11-01T00:00:00.000Z' });
  await mitKunde('TELTEST', 'erste@example.org', '+49 170 1112223');
  pruefe('Eine Einlösung zählt unter E-Mail UND Telefon',
    zaehler('n:TELTEST:' + sha('erste@example.org')) === 1 && zaehler('t:TELTEST:' + sha('491701112223')) === 1);
  await mitKunde('TELTEST', 'zweite@example.org', '0170 111 22 23');
  await mitKunde('TELTEST', 'dritte@example.org', '0049 (170) 111-2223');
  pruefe('Andere Schreibweisen derselben Nummer zählen zusammen', zaehler('t:TELTEST:' + sha('491701112223')) === 3, 't=' + zaehler('t:TELTEST:' + sha('491701112223')));
  await mitKunde('TELTEST', 'vierte@example.org', '+49 (0) 170 1112223');
  const tt = stand('TELTEST');
  pruefe('4. Bestellung mit neuer E-Mail, gleicher Nummer: nicht gezählt', tt.uses === 3 && zaehler('n:TELTEST:' + sha('vierte@example.org')) === 0, 'uses=' + tt.uses);

  legeAn('DREIMAL', { maxUses: 0, maxPerCustomer: 3, createdAt: '2026-11-01T00:00:00.000Z' });
  for (let i = 0; i < 3; i++) await mitKunde('DREIMAL', 'stamm@example.org', '');
  pruefe('Neuer Kunde: drei Einlösungen ergeben Zähler 3 (nicht doppelt)', zaehler('n:DREIMAL:' + sha('stamm@example.org')) === 3 && stand('DREIMAL').uses === 3, 'n=' + zaehler('n:DREIMAL:' + sha('stamm@example.org')));
  legeAn('ALTSTAND', { maxUses: 0, maxPerCustomer: 3, createdAt: '2026-11-01T00:00:00.000Z', usedBy: { [sha('alt@example.org')]: 2 } });
  await mitKunde('ALTSTAND', 'alt@example.org', '01705556667');
  pruefe('Altkunde mit 2 Einlösungen in usedBy: Zähler danach 3', zaehler('n:ALTSTAND:' + sha('alt@example.org')) === 3 && zaehler('t:ALTSTAND:' + sha('491705556667')) === 1);

  const ref = 'GNC-EINMAL-' + Date.now();
  legeAn('DOPPELT', { maxUses: 0, maxPerCustomer: 3, createdAt: '2026-11-01T00:00:00.000Z' });
  await mitKunde('DOPPELT', 'doppelt@example.org', '01702223334', ref);
  await mitKunde('DOPPELT', 'doppelt@example.org', '01702223334', ref);
  pruefe('Dieselbe Bestellung zweimal gemeldet: zählt einmal',
    stand('DOPPELT').uses === 1 && zaehler('t:DOPPELT:' + sha('491702223334')) === 1 && zaehler('n:DOPPELT:' + sha('doppelt@example.org')) === 1);

  legeAn('KURZ', { maxUses: 0, maxPerCustomer: 3, createdAt: '2026-11-01T00:00:00.000Z' });
  await mitKunde('KURZ', 'kurz@example.org', '0521 12');
  pruefe('Nummer unter 8 Ziffern wird ignoriert', !Object.keys(SPEICHER.vouchers).some((k) => k.startsWith('t:KURZ:')) && stand('KURZ').uses === 1);

  legeAn('OHNELIMIT', { maxUses: 0, maxPerCustomer: 0 });
  await mitKunde('OHNELIMIT', 'frei@example.org', '01703334445');
  pruefe('Code ohne Kundenlimit legt keine Kundenzähler an', !Object.keys(SPEICHER.vouchers).some((k) => /^[nt]:OHNELIMIT:/.test(k)) && stand('OHNELIMIT').uses === 1);

  console.log('\n5) Wegwerf-Adressen');
  legeAn('WEGWERF5', { maxUses: 0, maxPerCustomer: 3, createdAt: '2026-11-01T00:00:00.000Z' });
  await mitKunde('WEGWERF5', 'trick@mailinator.com', '01704445556');
  await mitKunde('WEGWERF5', 'trick@abc.yopmail.com', '01704445557');
  pruefe('Wegwerf-Adresse (auch Subdomain): keine Einlösung gezählt',
    stand('WEGWERF5').uses === 0 && !Object.keys(SPEICHER.vouchers).some((k) => /^[nt]:WEGWERF5:/.test(k)), 'uses=' + stand('WEGWERF5').uses);

  console.log('\n' + '─'.repeat(74));
  console.log(fehler === 0
    ? gruen('ERGEBNIS: ✅ Jede Einlösung wird gezählt, Grenzen werden durchgesetzt.')
    : rot('ERGEBNIS: ❌ ' + fehler + ' Prüfung(en) fehlgeschlagen.'));
  process.exit(fehler === 0 ? 0 : 1);
})().catch((e) => { console.error(rot('Abbruch: ' + e.message)); process.exit(1); });
