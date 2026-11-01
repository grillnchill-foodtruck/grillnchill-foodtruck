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
 * zählt nur einmal, Wegwerf-Adressen zählen nicht. Dazu die einmalige
 * Korrektur der Zähler, die der Zählfehler vom 29.10. um eins erhöht hat.
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

  console.log('\n6) Einmalige Korrektur der Zähler vom Zählfehler (zaehler-korrektur.js)');
  {
    const korrektur = require(path.join(__dirname, '..', 'netlify', 'functions', 'zaehler-korrektur.js'));
    SPEICHER.vouchers = {}; SPEICHER.orders = {};
    const seit = '2026-07-20T00:00:00.000Z';
    const H = (mail) => sha(mail);
    const nach = Date.parse('2026-10-30T12:00:00+01:00');
    const vor = Date.parse('2026-09-10T12:00:00+01:00');
    const bestellt = (ms, email, gezaehlt = 'GRILL5') => { SPEICHER.orders['o:GNC-' + ms] = { status: 'completed', gutscheinGezaehlt: gezaehlt, order: { email, voucherCode: 'GRILL5' } }; };
    // usedBy und Zähler wie nach dem Fehler
    SPEICHER.vouchers['c:GRILL5'] = { code: 'GRILL5', maxPerCustomer: 3, createdAt: seit, uses: 9, usedBy: {
      [H('fehler@example.org')]: 1,          // Fall A: n=2, eindeutig zu hoch
      [H('richtig@example.org')]: 2,         // Fall B: n=2, stimmt
      [H('maxmuster@gmail.com')]: 1,         // Fall C: Schreibweisen gemischt
      [H('ohnebeleg@example.org')]: 1,       // Fall E: keine Bestellung im Archiv
      [H('weniger@example.org')]: 3,         // Fall F: n kleiner als usedBy
      [H('alt@example.org')]: 2,             // Fall G: andere Fassung des Codes
    } };
    const zSetzen = (mail, n, s2 = seit) => { SPEICHER.vouchers['n:GRILL5:' + H(mail)] = { seit: s2, n, zuletzt: '2026-10-30' }; };
    zSetzen('fehler@example.org', 2); bestellt(nach, 'Fehler@Example.org');
    zSetzen('richtig@example.org', 2); bestellt(nach + 1, 'richtig@example.org'); bestellt(vor, 'richtig@example.org', null);
    zSetzen('maxmuster@gmail.com', 2); bestellt(nach + 2, 'maxmuster@gmail.com'); bestellt(vor + 1, 'max.muster@gmail.com', null);
    zSetzen('ohneusedby@example.org', 2); bestellt(nach + 3, 'ohneusedby@example.org');
    zSetzen('ohnebeleg@example.org', 2);
    zSetzen('weniger@example.org', 2); bestellt(nach + 4, 'weniger@example.org');
    zSetzen('alt@example.org', 3, '2026-01-01T00:00:00.000Z'); bestellt(nach + 5, 'alt@example.org');
    const vorher = JSON.parse(JSON.stringify(SPEICHER.vouchers));

    const nachrichten = [];
    const fetchAlt = global.fetch;
    global.fetch = async (url, o) => { if (String(url).includes('api.telegram.org')) nachrichten.push(JSON.parse(o.body).text); return { ok: true, status: 200, json: async () => ({}), text: async () => '' }; };
    Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_CHAT_ID: '1' });
    const leise = console.log; console.log = () => {};
    const r1 = await korrektur.korrigieren();
    console.log = leise;
    const n = (mail) => SPEICHER.vouchers['n:GRILL5:' + H(mail)].n;
    pruefe('Eindeutig zu hoher Zähler wird um eins gesenkt', n('fehler@example.org') === 1 && r1.korrigiert === 1, 'n=' + n('fehler@example.org'));
    pruefe('Richtige Zähler bleiben', n('richtig@example.org') === 2 && r1.richtig === 1);
    pruefe('Gemischte Schreibweisen (Gmail-Punkte) bleiben unverändert', n('maxmuster@gmail.com') === 2);
    pruefe('Ohne usedBy oder ohne Bestellbeleg: unverändert', n('ohneusedby@example.org') === 2 && n('ohnebeleg@example.org') === 2 && r1.ohneQuelle === 2);
    pruefe('Nie erhöht: Zähler unter usedBy bleibt', n('weniger@example.org') === 2);
    pruefe('Zähler einer früheren Code-Fassung bleibt', n('alt@example.org') === 3 && r1.veraltet === 1);
    pruefe('Unklare Fälle werden gezählt', r1.mehrdeutig === 2, JSON.stringify(r1));
    pruefe('Kein Zähler höher als vorher', Object.keys(vorher).filter((k) => k.startsWith('n:')).every((k) => SPEICHER.vouchers[k].n <= vorher[k].n));
    pruefe('Telegram an Kubi: eine Nachricht, nur Anzahlen', nachrichten.length === 1 && /1 Kundenzähler/.test(nachrichten[0]) && !/@|[0-9a-f]{64}/.test(nachrichten[0]));
    const stand1 = JSON.stringify(SPEICHER.vouchers);
    console.log = () => {};
    const r2 = await korrektur.korrigieren();
    console.log = leise;
    pruefe('Zweiter Lauf ändert nichts und meldet nichts', r2.schon === true && JSON.stringify(SPEICHER.vouchers) === stand1 && nachrichten.length === 1);
    pruefe('Merker gesetzt', SPEICHER.vouchers[korrektur.MERKER].status === 'fertig');
    // Selbst ohne Merker fände ein neuer Lauf nichts mehr (Regel ist idempotent)
    delete SPEICHER.vouchers[korrektur.MERKER];
    console.log = () => {};
    const r3 = await korrektur.korrigieren();
    console.log = leise;
    pruefe('Auch ohne Merker: nichts mehr zu korrigieren', r3.korrigiert === 0 && n('fehler@example.org') === 1);
    // Zeit reicht nicht: nichts ändern
    delete SPEICHER.vouchers[korrektur.MERKER];
    zSetzen('fehler@example.org', 2);
    const warn = console.warn; console.warn = () => {};
    const r4 = await korrektur.korrigieren({ budgetMs: -1 });
    console.warn = warn;
    if (process.env.ZEIGEN) leise(nachrichten[0]);
    pruefe('Zu wenig Zeit: Abbruch ohne Änderung, Merker erlaubt neuen Versuch', r4.abgebrochen === true && n('fehler@example.org') === 2 && SPEICHER.vouchers[korrektur.MERKER].status === 'abgebrochen');
    global.fetch = fetchAlt; delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID;
  }

  console.log('\n' + '─'.repeat(74));
  console.log(fehler === 0
    ? gruen('ERGEBNIS: ✅ Jede Einlösung wird gezählt, Grenzen werden durchgesetzt.')
    : rot('ERGEBNIS: ❌ ' + fehler + ' Prüfung(en) fehlgeschlagen.'));
  process.exit(fehler === 0 ? 0 : 1);
})().catch((e) => { console.error(rot('Abbruch: ' + e.message)); process.exit(1); });
