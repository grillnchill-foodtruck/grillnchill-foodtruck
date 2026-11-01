#!/usr/bin/env node
/**
 * werkzeug/bestellfluss-test.js
 * ----------------------------------------------------------------------------
 * Paket „bestellfluss" gegen die echten Handler, ohne Netlify:
 *
 *   node werkzeug/bestellfluss-test.js
 *
 *   1. Abholnummer (lib/abholnummer.js, send-email.js): je Tag ab 1, gleiche
 *      Bestellung gleiche Nummer, 40 gleichzeitige Vergaben ohne Doppel,
 *      Abholtag bei Vorbestellungen, Nummer in Mail, Telegram, Archiv,
 *      Antwort und Statusseite, Browserwert zählt nicht.
 *   2. Wartezeit (lib/wartezeit.js, shop-status.js, cockpit-data.js):
 *      Rechnung, Burger zählen, nur offene von heute, Öffnungszeit,
 *      Einstellungen überleben ein Speichern ohne die Felder (Cockpit).
 *   3. Feedback (feedback.js, order-status.js): erst nach Abschluss, nur mit
 *      dem Statusschlüssel, genau einmal (auch gleichzeitig), Telegram nur
 *      unter 4 Sternen und mit entschärftem Text, Liste nur für Admins.
 *   4. Interne Bestellung (bestellung-intern.js): Preis wie online, Felder
 *      fürs Admin-Tool, Cockpit und Umsatz, Lieferpflichtfelder, Mail nur mit
 *      Adresse, Kassieren, Storno mit Rückbuchung.
 *
 * Der Speicher liegt im Arbeitsspeicher und kann wie @netlify/blobs v10
 * bedingt schreiben (onlyIfNew, onlyIfMatch mit ETag). Zwischen Lesen und
 * Schreiben gibt er die Kontrolle ab, damit gleichzeitige Aufrufe sich
 * wirklich überholen können. fetch ist abgefangen: keine Mail, kein Telegram.
 * ----------------------------------------------------------------------------
 */

const Module = require('module');
const path = require('path');

const F = path.join(__dirname, '..', 'netlify', 'functions');

/* ---- Speicher mit ETag ---------------------------------------------------- */
const daten = new Map();   // "store|key" -> { v, etag }
let etagZaehler = 0;
const abgeben = () => new Promise((r) => setImmediate(r));
const ablage = (name) => ({
  async get(k, o) {
    await abgeben();
    const e = daten.get(name + '|' + k);
    if (!e) return null;
    return o && o.type === 'json' ? JSON.parse(e.v) : e.v;
  },
  async getWithMetadata(k, o) {
    await abgeben();
    const e = daten.get(name + '|' + k);
    if (!e) return null;
    return { data: o && o.type === 'json' ? JSON.parse(e.v) : e.v, etag: e.etag, metadata: {} };
  },
  async setJSON(k, v, o) {
    await abgeben();
    const id = name + '|' + k;
    const e = daten.get(id);
    if (o && o.onlyIfNew && e) return { modified: false };
    if (o && o.onlyIfMatch && (!e || e.etag !== o.onlyIfMatch)) return { modified: false };
    const etag = '"e' + (++etagZaehler) + '"';
    daten.set(id, { v: JSON.stringify(v), etag });
    return { modified: true, etag };
  },
  async set(k, v) { daten.set(name + '|' + k, { v: String(v), etag: '"e' + (++etagZaehler) + '"' }); return { modified: true }; },
  async delete(k) { daten.delete(name + '|' + k); },
  async list({ prefix } = {}) {
    return { blobs: [...daten.keys()].filter((k) => k.startsWith(name + '|' + (prefix || ''))).map((k) => ({ key: k.slice(name.length + 1) })) };
  },
});
const lies = (name, k) => { const e = daten.get(name + '|' + k); return e ? JSON.parse(e.v) : null; };
const lege = (name, k, v) => daten.set(name + '|' + k, { v: JSON.stringify(v), etag: '"e' + (++etagZaehler) + '"' });

const orig = Module._load;
Module._load = function (anfrage, ...rest) {
  if (anfrage === '@netlify/blobs') return { getStore: (o) => ablage(typeof o === 'string' ? o : o.name) };
  if (anfrage === 'web-push') return { setVapidDetails() {}, sendNotification: async () => ({}) };
  return orig.call(this, anfrage, ...rest);
};

Object.assign(process.env, {
  ADMIN_PASSWORD: 'kubi-test-passwort',
  BREVO_API_KEY: 'test-nicht-echt', BREVO_SENDER_EMAIL: 'test@example.org',
  OWNER_EMAIL: 'inhaber@example.org', STATUS_UPDATE_SECRET: 'test-status-geheim',
  INTERNAL_HOOK_SECRET: 'test-intern-geheim',     // keine Treuegutschrift im Test
  SITE_URL: 'https://example.org', URL: 'https://example.org',
  TELEGRAM_BOT_TOKEN: 'test-bot', TELEGRAM_CHAT_ID: '42',
});
delete process.env.ZWEI_FAKTOR;
delete process.env.NETLIFY_BLOBS_SITE_ID;

/* ---- Netz abfangen -------------------------------------------------------- */
const netz = [];   // { url, body }
let mail = null;   // send-email-Handler, wird unten geladen
global.fetch = async (url, opts) => {
  const u = String(url);
  const body = (opts && opts.body) || '';
  netz.push({ url: u, body });
  if (u.includes('/.netlify/functions/send-email') && mail) {
    const headers = {};
    Object.entries((opts && opts.headers) || {}).forEach(([k, v]) => { headers[k.toLowerCase()] = v; });
    const r = await mail.handler({ httpMethod: 'POST', headers, body });
    return { ok: r.statusCode < 300, status: r.statusCode, json: async () => JSON.parse(r.body), text: async () => r.body };
  }
  return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
};
const telegramme = () => netz.filter((x) => x.url.includes('api.telegram.org')).map((x) => JSON.parse(x.body).text);
const brevo = () => netz.filter((x) => x.url.includes('api.brevo.com')).map((x) => JSON.parse(x.body));

const leiseFehler = console.error; console.error = () => {};
const leiseWarn = console.warn; console.warn = () => {};

const abhol = require(F + '/lib/abholnummer.js');
const wz = require(F + '/lib/wartezeit.js');
const sitzung = require(F + '/lib/admin-sitzung.js');
const tp = require(F + '/lib/team-passwort.js');
mail = require(F + '/send-email.js');
const status = require(F + '/order-status.js');
const laden = require(F + '/shop-status.js');
const cockpit = require(F + '/cockpit-data.js');
const liste = require(F + '/orders-list.js');
const feedback = require(F + '/feedback.js');
const intern = require(F + '/bestellung-intern.js');

let fehler = 0, n = 0;
const ok = (name, b, info) => { n++; console.log((b ? '✅ ' : '❌ ') + name + (b || info === undefined ? '' : '\n   ' + info)); if (!b) fehler++; };
let ipZ = 1;
const ev = (body, ip, headers) => ({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': ip || ('10.1.0.' + (ipZ++ % 250)), ...(headers || {}) }, body: JSON.stringify(body) });
const call = async (h, body, ip, headers) => { const r = await h.handler(ev(body, ip, headers)); let d = {}; try { d = JSON.parse(r.body); } catch (e) {} return { s: r.statusCode, d }; };
const crypto = require('crypto');
const statusKey = (ref) => crypto.createHash('sha256').update(ref + '|' + process.env.STATUS_UPDATE_SECRET).digest('hex').slice(0, 20);

/* Feste Zeitpunkte (November = MEZ, UTC+1). 01.11.2026 ist ein Sonntag. */
const MO_1300 = Date.UTC(2026, 10, 2, 12, 0);    // Montag 13:00 Berlin
const MO_2100 = Date.UTC(2026, 10, 2, 20, 0);    // Montag 21:00 (zu)
const MO_1000 = Date.UTC(2026, 10, 2, 9, 0);     // Montag 10:00 (noch zu)
const SA_2200 = Date.UTC(2026, 10, 7, 21, 0);    // Samstag 22:00 -> Montag
const SO_1300 = Date.UTC(2026, 10, 1, 12, 0);    // Sonntag 13:00 (Ruhetag)

const echteZeit = Date.now;
function uhr(ms) { Date.now = () => ms; }
function uhrZurueck() { Date.now = echteZeit; }

(async () => {
  const kubi = (await sitzung.erstelle('kubi-test-passwort', { role: 'superadmin', name: 'Kubi' }, { zweiFaktor: true })).token;
  lege('team', 'u:test-mitarbeiter', { name: 'Test Mitarbeiter', role: 'staff', pwHash: await tp.hashen('mitarbeiter-passwort-77') });
  const staff = (await sitzung.erstelle('mitarbeiter-passwort-77', { role: 'staff', name: 'Test Mitarbeiter' }, { zweiFaktor: true })).token;

  /* ======================= 1. Abholnummer ============================== */
  console.log('\n— Abholnummer —');
  let a = await abhol.vergebeAbholnr('GNC-1000000000001', '2026-11-02');
  let b = await abhol.vergebeAbholnr('GNC-1000000000002', '2026-11-02');
  ok('Erste Nummer des Tages ist 1, die zweite 2', a.nr === 1 && b.nr === 2);
  ok('Gleiche Bestellung bekommt dieselbe Nummer', (await abhol.vergebeAbholnr('GNC-1000000000001', '2026-11-02')).nr === 1);
  ok('Neuer Tag fängt wieder bei 1 an', (await abhol.vergebeAbholnr('GNC-1000000000003', '2026-11-03')).nr === 1);

  const refs = Array.from({ length: 40 }, (_, i) => 'GNC-20000000000' + String(i).padStart(2, '0'));
  const parallel = await Promise.all(refs.map((r) => abhol.vergebeAbholnr(r, '2026-11-04')));
  const nummern = parallel.map((x) => x.nr).sort((x, y) => x - y);
  ok('40 gleichzeitige Bestellungen: 40 verschiedene Nummern 1 bis 40', new Set(nummern).size === 40 && nummern[0] === 1 && nummern[39] === 40,
    JSON.stringify(nummern));
  ok('Zähler steht danach auf 40, jede Bestellung zugeordnet', lies('abholnr', 't:2026-11-04').n === 40 && Object.keys(lies('abholnr', 't:2026-11-04').refs).length === 40);
  const doppelt = await Promise.all([abhol.vergebeAbholnr('GNC-3000000000001', '2026-11-05'), abhol.vergebeAbholnr('GNC-3000000000001', '2026-11-05'), abhol.vergebeAbholnr('GNC-3000000000002', '2026-11-05')]);
  ok('Webhook und Rückkehr gleichzeitig: dieselbe Bestellung behält eine Nummer', doppelt[0].nr === doppelt[1].nr && doppelt[2].nr !== doppelt[0].nr
    && lies('abholnr', 't:2026-11-05').refs['GNC-3000000000001'] === doppelt[0].nr, JSON.stringify(doppelt));

  ok('Abholtag Sofortbestellung = heute', abhol.abholTagFuer({}, MO_1300) === '2026-11-02');
  ok('Abholtag Vorbestellung Montag 21:00 = Dienstag', abhol.abholTagFuer({ isPreorder: true }, MO_2100) === '2026-11-03');
  ok('Abholtag Vorbestellung Montag 10:00 = Montag', abhol.abholTagFuer({ isPreorder: true }, MO_1000) === '2026-11-02');
  ok('Abholtag Vorbestellung Samstag 22:00 = Montag (Sonntag Ruhetag)', abhol.abholTagFuer({ scheduledFor: 'Montag ab 12:15 Uhr' }, SA_2200) === '2026-11-09');

  // send-email: Vergabe beim Abschluss
  const heute = abhol.berlinTag();
  const refOnline = 'GNC-' + (Date.now() - 5000);
  const bestellung = (ref, extra) => ({
    reference: ref, name: 'Lena Test', email: 'lena@example.org', phone: '0170 1234567',
    mode: 'pickup', payment: 'cash', items: [{ name: 'Classic Burger', qty: 2, price: 8, total: 16 }],
    cartSnapshot: { classic: { menuId: 'classic', qty: 2, double: false } }, subtotal: 16, total: 16, ...(extra || {}),
  });
  netz.length = 0;
  let r = await call(mail, { type: 'order_confirmation', order: bestellung(refOnline, { abholnr: 999, quelle: 'telefon' }) });
  const tagesStand = lies('abholnr', 't:' + heute);
  const nrOnline = tagesStand && tagesStand.refs[refOnline];
  ok('Bestätigung: Antwort trägt die Abholnummer des Servers', r.s === 200 && Number.isInteger(r.d.abholnr) && r.d.abholnr === nrOnline && r.d.abholnr !== 999, JSON.stringify(r));
  const recOnline = lies('orders', 'o:' + refOnline);
  ok('Archiv: abholnr, abholTag, quelle online am Datensatz', recOnline.abholnr === nrOnline && recOnline.abholTag === heute && recOnline.quelle === 'online' && recOnline.order.abholnr === nrOnline);
  const mails = brevo();
  ok('Kundenmail und Inhabermail zeigen „Nr. ' + nrOnline + '"', mails.length === 2 && mails.every((m) => m.htmlContent.includes('Nr. ' + nrOnline)));
  ok('Telegram zur neuen Bestellung nennt die Nummer', telegramme().some((t) => t.includes('NEUE BESTELLUNG') && t.includes('Nr. ' + nrOnline)));
  r = await call(mail, { type: 'order_confirmation', order: bestellung(refOnline) });
  ok('Zweiter Aufruf (Rückkehr nach Webhook): doppelt, gleiche Nummer', r.s === 200 && r.d.duplicate === true && r.d.abholnr === nrOnline);
  let g = await status.handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': '10.2.0.1' }, queryStringParameters: { ref: refOnline, k: statusKey(refOnline) } });
  ok('Statusseite (order-status) liefert die Nummer', g.statusCode === 200 && JSON.parse(g.body).abholnr === nrOnline);
  netz.length = 0;
  r = await call(mail, { type: 'status_update', status: 'delivered', order: { ...recOnline.order } }, null, require(F + '/lib/bremse.js').internHeader());
  const sm = brevo()[0];
  ok('Status-Mail „Geliefert" mit Nummer und Link „Wie war\'s?" zur Statusseite', r.s === 200 && sm && sm.htmlContent.includes('Wie war') && sm.htmlContent.includes('/s/' + refOnline + '?k=' + statusKey(refOnline)) && sm.htmlContent.includes('Nr. ' + nrOnline));

  /* ======================= 2. Wartezeit ================================= */
  console.log('\n— Wartezeit —');
  ok('Rechnung: 10 + 5 × 3 = 25', wz.berechne({ waitBase: 10, waitPerBurger: 3, waitMax: 60 }, 5) === 25);
  ok('Rechnung: auf 5 gerundet (10 + 1 × 3 = 13 → 15)', wz.berechne({ waitBase: 10, waitPerBurger: 3, waitMax: 60 }, 1) === 15);
  ok('Rechnung: begrenzt auf waitMax', wz.berechne({ waitBase: 10, waitPerBurger: 3, waitMax: 45 }, 40) === 45);
  ok('Standard: aus, 10, 3, 60', JSON.stringify(wz.einstellungen({})) === JSON.stringify({ waitAuto: false, waitBase: 10, waitPerBurger: 3, waitMax: 60 }));
  ok('Burger zählen: Menü + Burger zählen, Nuggets und Getränke nicht', wz.burgerInBestellung({ cartSnapshot: {
    a: { menuId: 'classic', qty: 2, isMenu: true }, b: { menuId: 'kubis', qty: 1 }, c: { menuId: 'nug9', qty: 3 }, d: { menuId: 'fritz-kola', qty: 2 } } }) === 3);
  ok('Burger zählen ohne Warenkorb über die Namen', wz.burgerInBestellung({ items: [{ name: 'Cheeseburger-Menü (Double Patty) [Pommes, Fritz Kola, Mayo]', qty: 2 }, { name: 'Pommes [Mayo]', qty: 1 }] }) === 2);

  // Bestellungen eines Montags um 13:00
  for (const k of [...daten.keys()].filter((x) => x.startsWith('orders|o:'))) daten.delete(k);
  const T = MO_1300;
  const rec = (ms, fstate, korb, extra) => lege('orders', 'o:GNC-' + ms, { status: 'completed', createdAt: new Date(ms).toISOString(), completedAt: new Date(ms).toISOString(), fstate, abholTag: abhol.berlinTag(ms), order: { cartSnapshot: korb, mode: 'pickup' }, ...(extra || {}) });
  rec(T - 60000, 'confirmed', { a: { menuId: 'classic', qty: 2, isMenu: true } });
  rec(T - 120000, 'preparing', { a: { menuId: 'cheese', qty: 1 }, b: { menuId: 'pommes', qty: 2, dip: 'dip-mayo' } });
  rec(T - 180000, 'ready_for_pickup', { a: { menuId: 'sucuk', qty: 5 } });
  rec(T - 20 * 3600000, 'confirmed', { a: { menuId: 'sucuk', qty: 7 } });   // gestern liegen geblieben
  rec(T - 240000, 'confirmed', { a: { menuId: 'sucuk', qty: 4 } }, { order: { isTest: true, cartSnapshot: { a: { menuId: 'sucuk', qty: 4 } } } });
  rec(T - 300000, 'confirmed', { a: { menuId: 'sucuk', qty: 6 } }, { status: 'pending' });
  rec(T - 20 * 3600000 + 1, 'confirmed', { a: { menuId: 'crispy', qty: 2 } }, { abholTag: '2026-11-02' });   // Vorbestellung von gestern für heute
  // dayKey nach der echten Uhr: shop-status setzt Tageswerte sonst um Mitternacht zurück
  lege('shop-status', 'status', { paused: false, soldOut: [], waitTime: 20, dayKey: abhol.berlinTag(echteZeit()), waitAuto: true, waitBase: 10, waitPerBurger: 3, waitMax: 60 });
  uhr(T); wz.memoLeeren();
  g = await laden.handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': '10.3.0.1' } });
  let st = JSON.parse(g.body);
  ok('Offene Burger heute: 2 + 1 + 2 (Vorbestellung für heute) = 5, ohne Fertige, Gestrige, Tests, Unbezahlte', st.offeneBurger === 5, 'offeneBurger=' + st.offeneBurger);
  ok('Automatik an: waitTime = 25, waitManual = 20', st.waitAuto === true && st.waitTime === 25 && st.waitManual === 20, JSON.stringify(st));
  ok('CDN-Cache von 10 s bleibt', /s-maxage=10/.test(g.headers['Netlify-CDN-Cache-Control'] || ''));
  uhr(SO_1300); wz.memoLeeren();
  st = JSON.parse((await laden.handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': '10.3.0.1' } })).body);
  ok('Außerhalb der Öffnungszeit (Sonntag): waitTime 0', st.waitTime === 0);
  uhr(T); wz.memoLeeren();
  let c = await call(cockpit, { password: kubi }, '10.3.0.2');
  ok('Cockpit: Wartezeit automatisch mit 25 Min.', c.s === 200 && c.d.status.waitAuto === true && c.d.status.waitTime === 25, JSON.stringify(c.d.status));
  // Speichern wie das Cockpit (ohne Automatik-Felder) lässt die Einstellung stehen
  r = await call(laden, { password: kubi, paused: true, waitTime: 15, soldOut: [] }, '10.3.0.3');
  let gespeichert = lies('shop-status', 'status');
  ok('Speichern ohne Automatik-Felder (Cockpit): Automatik bleibt an', r.s === 200 && gespeichert.waitAuto === true && gespeichert.waitBase === 10 && gespeichert.waitTime === 15);
  r = await call(laden, { password: kubi, paused: false, waitTime: 15, soldOut: [], waitAuto: false, waitBase: 5, waitPerBurger: 2, waitMax: 30 }, '10.3.0.3');
  gespeichert = lies('shop-status', 'status');
  wz.memoLeeren();
  st = JSON.parse((await laden.handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': '10.3.0.1' } })).body);
  ok('Automatik aus: Kundenseite bekommt den Wert von Hand (15)', gespeichert.waitAuto === false && gespeichert.waitMax === 30 && st.waitTime === 15 && st.offeneBurger === undefined);
  ok('Vorschau ohne Anmeldung: 401', (await call(laden, { action: 'vorschau' }, '10.3.0.4')).s === 401);
  r = await call(laden, { password: staff, action: 'vorschau' }, '10.3.0.4');
  ok('Vorschau mit Anmeldung: offene Burger auch bei AUS, schreibt nichts', r.s === 200 && r.d.offeneBurger === 5 && JSON.stringify(lies('shop-status', 'status')) === JSON.stringify(gespeichert));
  uhrZurueck(); wz.memoLeeren();

  /* ======================= 3. Feedback ================================== */
  console.log('\n— Feedback —');
  const refFb = 'GNC-' + (Date.now() - 3600000);
  const refFb2 = 'GNC-' + (Date.now() - 3500000);
  lege('orders', 'o:' + refFb, { status: 'completed', fstate: 'preparing', abholnr: 7, createdAt: new Date().toISOString(), order: { mode: 'pickup', name: 'Ali' } });
  lege('orders', 'o:' + refFb2, { status: 'completed', fstate: 'delivered', abholnr: 8, createdAt: new Date().toISOString(), order: { mode: 'delivery', name: 'Mia' } });
  const fb = (ref, extra, ip) => call(feedback, { action: 'senden', reference: ref, k: statusKey(ref), stars: 5, text: '', lang: 'it', ...(extra || {}) }, ip);
  ok('Vor dem Abschluss: 409', (await fb(refFb)).s === 409);
  ok('Falscher Schlüssel: 403', (await call(feedback, { action: 'senden', reference: refFb2, k: 'falsch', stars: 5 })).s === 403);
  ok('Sterne 0, 6 und 2,5: 400', (await fb(refFb2, { stars: 0 })).s === 400 && (await fb(refFb2, { stars: 6 })).s === 400 && (await fb(refFb2, { stars: 2.5 })).s === 400);
  lege('orders', 'o:' + refFb, { ...lies('orders', 'o:' + refFb), fstate: 'picked_up' });
  netz.length = 0;
  r = await fb(refFb, { stars: 5, text: 'Sehr gut' });
  let gespeichertFb = lies('feedback', 'f:' + refFb);
  ok('Nach Abholung, 5 Sterne: gespeichert wie im Datenvertrag', r.s === 200 && gespeichertFb.ref === refFb && gespeichertFb.stars === 5 && gespeichertFb.text === 'Sehr gut'
    && gespeichertFb.lang === 'it' && gespeichertFb.art === 'pickup' && !isNaN(Date.parse(gespeichertFb.at)) && Object.keys(gespeichertFb).sort().join() === 'art,at,lang,ref,stars,text');
  ok('5 Sterne: kein Telegram', telegramme().length === 0);
  ok('Zweite Bewertung derselben Bestellung: 409, die erste bleibt', (await fb(refFb, { stars: 1 })).s === 409 && lies('feedback', 'f:' + refFb).stars === 5);
  g = await status.handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': '10.2.0.1' }, queryStringParameters: { ref: refFb, k: statusKey(refFb) } });
  ok('Statusseite weiß: schon bewertet (feedback.stars 5)', JSON.parse(g.body).feedback && JSON.parse(g.body).feedback.stars === 5);
  netz.length = 0;
  const lang = 'x'.repeat(480) + ' <script>alert(1)</script> & mehr Text danach';
  const gleichzeitig = await Promise.all([fb(refFb2, { stars: 2, text: lang }, '10.4.0.1'), fb(refFb2, { stars: 2, text: lang }, '10.4.0.2')]);
  ok('Gleichzeitig zweimal abgeschickt: eine 200, eine 409', gleichzeitig.map((x) => x.s).sort().join() === '200,409');
  gespeichertFb = lies('feedback', 'f:' + refFb2);
  ok('Text auf 500 Zeichen gekürzt, Lieferung erkannt', gespeichertFb.text.length === 500 && gespeichertFb.art === 'delivery');
  const tg = telegramme();
  ok('2 Sterne: genau ein Telegram mit Bestellnummer, Nr. 8, Sternen', tg.length === 1 && tg[0].includes(refFb2) && tg[0].includes('Nr. 8') && tg[0].includes('2 von 5'), JSON.stringify(tg));
  ok('Telegram-Text ist entschärft (kein rohes <script>)', tg.length === 1 && !tg[0].includes('<script>') && tg[0].includes('&lt;script'));
  ok('Unbekannte Bestellung: 404', (await fb('GNC-1111111111111')).s === 404);
  let bremseR;
  for (let i = 0; i < 9; i++) bremseR = await fb(refFb, {}, '10.4.9.9');
  ok('Bremse: nach 8 Versuchen in 10 Minuten 429', bremseR.s === 429);
  ok('Liste: Mitarbeiter 403', (await call(feedback, { action: 'liste', password: staff }, '10.4.1.1')).s === 403);
  r = await call(feedback, { action: 'liste', password: kubi }, '10.4.1.1');
  ok('Liste: Inhaber sieht 2 Bewertungen, Schnitt 3,5, neueste zuerst', r.s === 200 && r.d.gesamt === 2 && r.d.schnitt === 3.5 && r.d.liste.length === 2 && r.d.liste[0].ref === refFb2, JSON.stringify(r.d).slice(0, 200));

  /* ======================= 4. Interne Bestellung ======================== */
  console.log('\n— Telefon und Laufkundschaft —');
  const korb = [
    { menuId: 'classic', qty: 2, double: true, isMenu: true, side: 'spommes', drink: 'fritz-zero', dip: 'dip-ket' },
    { menuId: 'pommes', qty: 1, dip: 'dip-mayo' },
    { menuId: 'fritz-kola', qty: 1 },
    { menuId: 'kubis', qty: 1, double: true },
  ];
  const neu = (bst, pw, ip) => call(intern, { password: pw === undefined ? staff : pw, action: 'anlegen', bestellung: bst }, ip);
  ok('Ohne Anmeldung: 401', (await neu({ quelle: 'telefon', korb, mode: 'pickup', zahlart: 'bar' }, '')).s === 401);
  const revVorher = lies('orders', 'rev:' + heute) || { oCount: 0, oTotal: 0 };
  netz.length = 0;
  r = await neu({ quelle: 'telefon', korb, mode: 'pickup', zahlart: 'bar', name: 'Herr Yilmaz', phone: '0521 123456', note: 'Ohne Zwiebeln' });
  // 2 × (8 + 2,50 + 5 + 1) + 4 + 2,50 + 11 (Kubis ohne Double) = 33 + 17,50 = 50,50
  ok('Telefonbestellung: 200, Preis wie online (50,50 €)', r.s === 200 && r.d.total === 50.5, JSON.stringify(r.d));
  const refIntern = r.d.reference;
  const ri = lies('orders', 'o:' + refIntern);
  ok('Abholnummer läuft im Tageszähler mit den Online-Bestellungen weiter', ri.abholnr === nrOnline + 1 && r.d.abholnr === ri.abholnr, ri.abholnr + ' vs ' + nrOnline);
  ok('Datensatz: completed, confirmed, quelle telefon, abholTag, angelegt von', ri.status === 'completed' && ri.fstate === 'confirmed' && ri.quelle === 'telefon' && ri.abholTag === heute && ri.angelegtVon === 'Test Mitarbeiter' && ri.accrued === true);
  ok('Zahlung: payment cash (vor Ort), zahlart bar, bezahlt', ri.order.payment === 'cash' && ri.order.zahlart === 'bar' && ri.order.bezahlt === true && ri.order.paidWith === 'Bar');
  ok('Warenkorb-Schlüssel wie im Browser', ['classic__double__menu__spommes__fritz-zero__dip-ket', 'pommes__dip-dip-mayo', 'fritz-kola', 'kubis'].every((k) => ri.order.cartSnapshot[k]));
  ok('Positionen mit Namen und Preisen wie online', ri.order.items[0].name === 'Classic Burger-Menü (Double Patty) [Süßkartoffelpommes, Fritz Kola Super Zero, Ketchup]' && ri.order.items[0].price === 16.5 && ri.order.items[0].total === 33
    && ri.order.items[1].name === 'Pommes [Mayo]' && ri.order.items[3].name === 'Kubis Special', JSON.stringify(ri.order.items.map((x) => x.name)));
  ok('Ohne Mailadresse: keine Mail', brevo().length === 0 && r.d.mailed === false);
  const revNach = lies('orders', 'rev:' + heute);
  ok('Tagesumsatz: +1 Bestellung, +50,50 €, telefonCount', revNach.oCount === (revVorher.oCount || 0) + 1 && Math.abs(revNach.oTotal - (revVorher.oTotal || 0) - 50.5) < 0.001 && revNach.telefonCount === 1);
  c = await call(cockpit, { password: kubi }, '10.3.0.2');
  ok('Cockpit zählt sie als offen, mit Nummer und Quelle', c.s === 200 && c.d.openList.some((x) => x.nr === ri.abholnr && x.quelle === 'telefon'));
  const ol = await liste.handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': '10.5.0.1', 'x-gnc-sitzung': staff }, queryStringParameters: { days: '2' } });
  const olEintrag = (JSON.parse(ol.body).orders || []).find((x) => x.reference === refIntern);
  ok('Admin-Liste: abholnr und quelle', olEintrag && olEintrag.abholnr === ri.abholnr && olEintrag.quelle === 'telefon' && olEintrag.status === 'completed');

  ok('Lieferung ohne Adresse: 400', (await neu({ quelle: 'telefon', korb, mode: 'delivery', zahlart: 'offen', phone: '0521 1' })).d.error === 'adresse_fehlt');
  ok('Lieferung ohne Telefon: 400', (await neu({ quelle: 'telefon', korb, mode: 'delivery', zahlart: 'offen', zone: 0, adresse: { street: 'Hauptstr. 1', zip: '33649', city: 'Bielefeld' } })).d.error === 'telefon_fehlt');
  ok('Unbekannter Artikel: 400', (await neu({ quelle: 'truck', korb: [{ menuId: 'kaviar', qty: 1 }], mode: 'pickup', zahlart: 'bar' })).s === 400);
  ok('Menge 0: 400', (await neu({ quelle: 'truck', korb: [{ menuId: 'classic', qty: 0 }], mode: 'pickup', zahlart: 'bar' })).s === 400);
  ok('Ohne Quelle oder Zahlart: 400', (await neu({ korb, mode: 'pickup', zahlart: 'bar' })).s === 400 && (await neu({ quelle: 'truck', korb, mode: 'pickup' })).s === 400);
  netz.length = 0;
  r = await neu({ quelle: 'telefon', korb: [{ menuId: 'cheese', qty: 2 }], mode: 'delivery', zone: 1, zahlart: 'offen', phone: '0521 654321', email: 'Gast@Example.org',
    adresse: { street: 'Gütersloher Str. 1', zip: '33649', city: 'Bielefeld' } });
  const rl = lies('orders', 'o:' + r.d.reference);
  ok('Lieferung Zone 2: 2 × 8,50 + 3,50 = 20,50 €, Adresse und Zone am Datensatz', r.s === 200 && r.d.total === 20.5 && rl.order.deliveryFee === 3.5 && rl.order.deliveryAddress.zone === 'Zone 2: 3 bis 5 km' && rl.order.mode === 'delivery');
  const mailIntern = brevo();
  ok('Mit Mailadresse: genau eine Bestätigung an den Gast, mit Nummer und Statuslink', r.d.mailed === true && mailIntern.length === 1 && mailIntern[0].to[0].email === 'gast@example.org'
    && mailIntern[0].htmlContent.includes('Nr. ' + rl.abholnr) && mailIntern[0].htmlContent.includes('/s/' + r.d.reference));
  ok('Zahlung offen: bezahlt false', rl.order.zahlart === 'offen' && rl.order.bezahlt === false && rl.order.paidWith === null);
  ok('Interne Mailart von außen: 403', (await call(mail, { type: 'intern_bestaetigung', order: { email: 'opfer@example.org', reference: 'GNC-1' } })).s === 403);
  r = await call(intern, { password: staff, action: 'bezahlt', reference: rl.order.reference, zahlart: 'karte' });
  ok('Kassieren: offen → Karte', r.s === 200 && lies('orders', 'o:' + rl.order.reference).order.zahlart === 'karte' && lies('orders', 'o:' + rl.order.reference).order.bezahlt === true);
  ok('Zweites Kassieren: 409', (await call(intern, { password: staff, action: 'bezahlt', reference: rl.order.reference, zahlart: 'bar' })).s === 409);
  r = await neu({ quelle: 'truck', korb: [{ menuId: 'nug9', qty: 1 }], mode: 'pickup', zahlart: 'karte' });
  ok('Laufkundschaft am Truck: Nummer, quelle truck, zahlart karte', r.s === 200 && lies('orders', 'o:' + r.d.reference).quelle === 'truck' && lies('orders', 'o:' + r.d.reference).order.zahlart === 'karte');
  const vorStorno = lies('orders', 'rev:' + heute);
  r = await call(intern, { password: staff, action: 'stornieren', reference: r.d.reference });
  const nachStorno = lies('orders', 'rev:' + heute);
  ok('Storno: status cancelled, Umsatz −5 € und −1 Bestellung zurückgebucht', r.s === 200 && nachStorno.oCount === vorStorno.oCount - 1 && Math.abs(vorStorno.oTotal - nachStorno.oTotal - 5) < 0.001 && nachStorno.truckCount === 0);
  lege('orders', 'o:' + refOnline, recOnline);
  ok('Storno einer Online-Bestellung: 409', (await call(intern, { password: staff, action: 'stornieren', reference: refOnline })).s === 409);

  console.error = leiseFehler; console.warn = leiseWarn;
  console.log('\n' + (n - fehler) + ' von ' + n + (fehler ? ' – ' + fehler + ' FEHLER' : ' grün'));
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.error = leiseFehler; console.error(e); process.exit(1); });
