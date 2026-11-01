#!/usr/bin/env node
/**
 * werkzeug/bezahlen-test.js
 * ----------------------------------------------------------------------------
 * Paket „bezahlen“: Bezahlen ohne Umweg (SumUp-Widget) und Burger-Pass.
 *
 *   node werkzeug/bezahlen-test.js
 *
 * Fährt die ECHTEN Handler (shop-status, sumup-checkout, burger-pass,
 * sumup-webhook, orders-reconcile, send-email, loyalty-scan, account,
 * burger-pass-erinnerung) gegen einen Blob-Speicher im Arbeitsspeicher.
 * SumUp, Brevo und Telegram sind nachgebaut: fetch ist abgefangen, nichts
 * verlässt den Rechner, keine echte Zahlung, keine Mail.
 *
 * Geprüft:
 *   1. Schalter AUS verhindert den Widget-Weg und den Pass-Kauf im Server
 *   2. Einstellungen: nur Admins (mit Zwei-Faktor-Sitzung), Werte begrenzt
 *   3. Pass-Gutschrift nur nach bestätigter Zahlung und genau einmal
 *   4. Einlösen: frühester Ablauf zuerst, abgelaufen zählt nicht,
 *      kein Doppelverbrauch, getrennt von den Stempelkarten-Menüs
 *   5. Ablauf und Erinnerungsmails
 * ----------------------------------------------------------------------------
 */

const path = require('path');
const crypto = require('crypto');
const Module = require('module');

/* --- Speicher ------------------------------------------------------------- */
const DATEN = new Map();
const store = (name) => ({
  async get(k, o) {
    const v = DATEN.get(name + '|' + k);
    if (v === undefined) return null;
    return o && o.type === 'json' ? JSON.parse(v) : v;
  },
  async setJSON(k, v, o) {
    const key = name + '|' + k;
    if (o && o.onlyIfNew && DATEN.has(key)) return { modified: false };
    DATEN.set(key, JSON.stringify(v));
    return { modified: true, etag: String(Math.random()) };
  },
  async set(k, v, o) {
    const key = name + '|' + k;
    if (o && o.onlyIfNew && DATEN.has(key)) return { modified: false };
    DATEN.set(key, String(v)); return { modified: true };
  },
  async delete(k) { DATEN.delete(name + '|' + k); },
  async list({ prefix } = {}) {
    return { blobs: [...DATEN.keys()].filter((k) => k.startsWith(name + '|' + (prefix || ''))).map((k) => ({ key: k.slice(name.length + 1) })) };
  },
});
const lies = (name, k) => { const v = DATEN.get(name + '|' + k); return v === undefined ? null : JSON.parse(v); };
const schreib = (name, k, v) => DATEN.set(name + '|' + k, JSON.stringify(v));

const originalLoad = Module._load;
Module._load = function (anfrage, ...rest) {
  if (anfrage === '@netlify/blobs') return { getStore: (o) => store(typeof o === 'string' ? o : o.name) };
  if (anfrage === 'web-push') return { setVapidDetails() {}, sendNotification: async () => ({}) };
  return originalLoad.call(this, anfrage, ...rest);
};

/* --- Umgebung ------------------------------------------------------------- */
Object.assign(process.env, {
  ADMIN_PASSWORD: 'kubi-test-passwort-123', SUMUP_API_KEY: 'sup_sk_test', SUMUP_MERCHANT_CODE: 'MTEST',
  BREVO_API_KEY: 'test', BREVO_SENDER_EMAIL: 'test@example.org', OWNER_EMAIL: 'inhaber@example.org',
  STATUS_UPDATE_SECRET: 'status-test', INTERNAL_HOOK_SECRET: 'intern-test', SITE_URL: 'https://example.org',
  URL: 'https://example.org', TELEGRAM_BOT_TOKEN: 'tg', TELEGRAM_CHAT_ID: '1',
});
delete process.env.ZWEI_FAKTOR;            // Zwei-Faktor-Pflicht wie live
delete process.env.GOOGLE_PAY_MERCHANT_ID;
delete process.env.NETLIFY_BLOBS_SITE_ID;

/* --- SumUp, Brevo, Telegram nachbauen -------------------------------------- */
const SUMUP = {};          // id -> { status, checkout_reference, payload }
const SUMUP_POSTS = [];
const MAILS = [];
const TELEGRAM = [];
let ckNr = 0;
const antwort = (status, d) => ({ ok: status >= 200 && status < 300, status, json: async () => d, text: async () => JSON.stringify(d) });
const F = path.join(__dirname, '..', 'netlify', 'functions');
let H = {};
global.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith('https://api.sumup.com/v0.1/checkouts')) {
    if ((opts.method || 'GET') === 'POST') {
      const body = JSON.parse(opts.body);
      const id = 'ck_' + (++ckNr);
      SUMUP[id] = { status: 'PENDING', checkout_reference: body.checkout_reference, payload: body };
      SUMUP_POSTS.push(body);
      return antwort(201, { id, status: 'PENDING', ...(body.hosted_checkout ? { hosted_checkout_url: 'https://checkout.sumup.com/pay/' + id } : {}) });
    }
    const id = decodeURIComponent(url.split('/checkouts/')[1] || '');
    const c = SUMUP[id];
    return c ? antwort(200, { id, status: c.status, checkout_reference: c.checkout_reference, transactions: [] }) : antwort(404, {});
  }
  if (url.includes('api.brevo.com')) { MAILS.push(JSON.parse(opts.body)); return antwort(201, { messageId: 'm' }); }
  if (url.includes('api.telegram.org')) { TELEGRAM.push(JSON.parse(opts.body)); return antwort(200, { ok: true }); }
  const intern = (h) => async () => {
    const r = await H[h].handler({ httpMethod: 'POST', headers: opts.headers || {}, body: opts.body });
    return antwort(r.statusCode, JSON.parse(r.body || '{}'));
  };
  if (url.endsWith('/.netlify/functions/sumup-webhook')) return intern('webhook')();
  if (url.endsWith('/.netlify/functions/send-email')) return intern('mail')();
  return antwort(503, {});
};
const leiseWarn = console.warn, leiseFehler = console.error, leiseLog = console.log;
console.warn = () => {};
console.error = () => {};

H = {
  laden: require(F + '/shop-status.js'),
  kasse: require(F + '/sumup-checkout.js'),
  pass: require(F + '/burger-pass.js'),
  webhook: require(F + '/sumup-webhook.js'),
  abgleich: require(F + '/orders-reconcile.js'),
  mail: require(F + '/send-email.js'),
  scan: require(F + '/loyalty-scan.js'),
  konto: require(F + '/account.js'),
  erinnerung: require(F + '/burger-pass-erinnerung.js'),
};
const bp = require(F + '/lib/burger-pass.js');
const post = require(F + '/lib/burger-pass-post.js');
const sitzung = require(F + '/lib/admin-sitzung.js');
const { hashen } = require(F + '/lib/team-passwort.js');
const SK = require(path.join(__dirname, '..', 'speisekarte.js'));

/* --- Prüfhilfen ------------------------------------------------------------ */
const gruen = (t) => '\x1b[32m' + t + '\x1b[0m';
const rot = (t) => '\x1b[31m' + t + '\x1b[0m';
let fehler = 0, n = 0;
function ok(name, b, info) {
  n++;
  if (!b) fehler++;
  leiseLog('  ' + (b ? gruen('✅') : rot('❌')) + ' ' + name + (b || info === undefined ? '' : rot('   → ' + info)));
}
let ipNr = 1;
async function rufe(h, body, extra) {
  const r = await H[h].handler({ httpMethod: (extra && extra.method) || 'POST', headers: { 'x-nf-client-connection-ip': '10.1.0.' + (ipNr++ % 250) }, body: body === undefined ? '' : JSON.stringify(body), queryStringParameters: (extra && extra.query) || {} });
  let d = {}; try { d = JSON.parse(r.body); } catch (e) {}
  return { s: r.statusCode, d };
}
const kundeKey = (mail) => 'c:' + crypto.createHash('sha256').update(mail).digest('hex');
const TAG = 86400000;
const iso = (ms) => new Date(ms).toISOString();

/* --- Ablauf ---------------------------------------------------------------- */
(async () => {
  leiseLog('\nPaket bezahlen: Bezahlen ohne Umweg und Burger-Pass\n' + '─'.repeat(74));

  // Zugänge: Kubi (Hauptpasswort) und eine Mitarbeiterin, beide mit 2FA-Sitzung
  const kubi = (await sitzung.erstelle(process.env.ADMIN_PASSWORD, { name: 'Kubi', role: 'admin' }, { zweiFaktor: true })).token;
  schreib('team', 'u:anna', { name: 'Anna', role: 'staff', pwHash: await hashen('anna-passwort-123') });
  const anna = (await sitzung.erstelle('anna-passwort-123', { name: 'Anna', role: 'staff' }, { zweiFaktor: true })).token;

  // Kunde mit Konto
  const MAIL = 'kunde@example.org';
  const TOK = 'a1'.repeat(24);
  const QR = 'b2c3'.repeat(5);
  schreib('customers', kundeKey(MAIL), { email: MAIL, name: 'Ali Test', tokens: { [TOK]: new Date().toISOString() }, spent: 40, rewards: 0, menus: 1, qrToken: QR });
  schreib('customers', 'qr:' + QR, { key: kundeKey(MAIL) });

  /* ======================================================================= */
  leiseLog('\n1) Schalter im Werkszustand AUS');
  let r = await rufe('laden', undefined, { method: 'GET' });
  ok('GET /shop-status: direkt aus, kein Pass sichtbar', r.s === 200 && r.d.zahlung && r.d.zahlung.direkt === false && r.d.zahlung.pass === null, JSON.stringify(r.d.zahlung));

  const bestellung = (ref, extra) => ({
    reference: ref, name: 'Ali Test', email: MAIL, phone: '0170', mode: 'pickup', payment: 'sumup',
    items: [], cartSnapshot: { a: { menuId: 'cheese', qty: 2, isMenu: true, side: 'pommes', drink: 'fritz-kola', dip: 'dip-mayo' } },
    subtotal: 27, discount: 0, loyaltyDiscount: 0, deliveryFee: 0, tip: 0, total: 27, ...(extra || {}),
  });
  r = await rufe('kasse', { amount: 27, zahlweg: 'widget', reference: 'GNC-W1', order: bestellung('GNC-W1') });
  let pl = SUMUP_POSTS[SUMUP_POSTS.length - 1];
  ok('Widget gewünscht, Schalter aus: Server antwortet mit Weiterleitung', r.s === 200 && r.d.zahlweg === 'weiterleitung' && /checkout\.sumup\.com/.test(r.d.hosted_checkout_url || ''), JSON.stringify(r.d));
  ok('… und legt eine gehostete Kasse mit redirect_url an', pl && pl.hosted_checkout && pl.hosted_checkout.enabled === true && /payment=return/.test(pl.redirect_url || ''));
  ok('… Archiv merkt zahlweg weiterleitung', (lies('orders', 'o:GNC-W1') || {}).zahlweg === 'weiterleitung');

  const postsVorher = SUMUP_POSTS.length;
  r = await rufe('pass', { action: 'kaufen', email: MAIL, token: TOK });
  ok('Pass-Kauf bei Schalter aus: 403 pass_aus', r.s === 403 && r.d.error === 'pass_aus', JSON.stringify(r.d));
  ok('… und keine SumUp-Kasse angelegt', SUMUP_POSTS.length === postsVorher);

  /* ======================================================================= */
  leiseLog('\n2) Einstellungen: nur Admin, Werte begrenzt');
  r = await rufe('laden', { bereich: 'zahlung', zahlung: { direktZahlung: true } });
  ok('Ohne Anmeldung: 401', r.s === 401);
  r = await rufe('laden', { password: process.env.ADMIN_PASSWORD, bereich: 'zahlung', zahlung: { direktZahlung: true } });
  ok('Hauptpasswort ohne Zwei-Faktor-Sitzung: 401', r.s === 401);
  r = await rufe('laden', { password: anna, bereich: 'zahlung', zahlung: { direktZahlung: true } });
  ok('Mitarbeiterin (staff): 403', r.s === 403);
  r = await rufe('laden', { password: kubi, bereich: 'zahlung', zahlung: { direktZahlung: true, pass: { aktiv: false, name: '<b>Burger-Pass</b>', preis: 1000, menus: 0, tage: 3 } } });
  ok('Admin speichert', r.s === 200 && r.d.zahlung && r.d.zahlung.direktZahlung === true, JSON.stringify(r.d));
  const z = r.d.zahlung || { pass: {} };
  ok('Werte begrenzt: Preis 200 €, mind. 1 Menü, mind. 7 Tage, Name ohne <>', z.pass.preis === 200 && z.pass.menus === 1 && z.pass.tage === 7 && !/[<>]/.test(z.pass.name), JSON.stringify(z.pass));
  ok('Tagesstatus bleibt unberührt', lies('shop-status', 'status') === null);
  r = await rufe('laden', undefined, { method: 'GET' });
  ok('Öffentlich: direkt an, Pass-Entwurf bleibt unsichtbar', r.d.zahlung.direkt === true && r.d.zahlung.pass === null);
  r = await rufe('laden', { password: kubi, bereich: 'zahlung', lesen: true });
  ok('Admin liest die vollständigen Einstellungen', r.s === 200 && r.d.zahlung.pass.preis === 200);
  // Normales Speichern im Reiter „Heute" lässt die Bezahl-Einstellungen stehen
  r = await rufe('laden', { password: kubi, paused: false, soldOut: [] });
  r = await rufe('laden', undefined, { method: 'GET' });
  ok('Speichern im Reiter „Heute" überschreibt sie nicht', r.d.zahlung.direkt === true);

  /* ======================================================================= */
  leiseLog('\n3) Bezahlen ohne Umweg (Schalter an)');
  r = await rufe('kasse', { amount: 27, zahlweg: 'widget', reference: 'GNC-W2', order: bestellung('GNC-W2') });
  pl = SUMUP_POSTS[SUMUP_POSTS.length - 1];
  ok('Widget-Weg: zahlweg widget, Checkout-ID, keine Weiterleitungs-URL', r.s === 200 && r.d.zahlweg === 'widget' && /^ck_/.test(r.d.id) && !r.d.hosted_checkout_url, JSON.stringify(r.d));
  ok('… SumUp-Kasse ohne hosted_checkout und ohne redirect_url (3-D Secure im Rahmen)', pl && !pl.hosted_checkout && !pl.redirect_url);
  ok('… Webhook-Adresse bleibt gesetzt', /sumup-webhook$/.test(pl.return_url || ''));
  ok('… Betrag nachgerechnet (2 Menüs = 27 €)', pl.amount === 27);
  ok('… Archiv: pending mit zahlweg widget', (lies('orders', 'o:GNC-W2') || {}).status === 'pending' && lies('orders', 'o:GNC-W2').zahlweg === 'widget');
  r = await rufe('kasse', { amount: 27, reference: 'GNC-W3', order: bestellung('GNC-W3') });
  ok('Ohne Wunsch bleibt es bei der Weiterleitung', r.d.zahlweg === 'weiterleitung' && !!r.d.hosted_checkout_url);
  process.env.GOOGLE_PAY_MERCHANT_ID = 'BCR2DN4TEST';
  r = await rufe('kasse', { amount: 27, zahlweg: 'widget', reference: 'GNC-W4', order: bestellung('GNC-W4') });
  ok('Google-Pay-Händler-ID geht ans Widget, wenn gesetzt', r.d.googlePay && r.d.googlePay.merchantId === 'BCR2DN4TEST');
  delete process.env.GOOGLE_PAY_MERCHANT_ID;
  // Abschluss wie bisher: Webhook prüft bei SumUp und löst die Bestätigung aus
  SUMUP[lies('orders', 'o:GNC-W2').checkoutId].status = 'PAID';
  r = await rufe('webhook', { id: lies('orders', 'o:GNC-W2').checkoutId });
  ok('Widget-Zahlung: Webhook schließt die Bestellung ab', r.d.action === 'notified' && lies('orders', 'o:GNC-W2').status === 'completed', JSON.stringify(r.d));
  // Abbruch im Widget: wie der Rückzieher von der SumUp-Seite
  const ckW4 = lies('orders', 'o:GNC-W4').checkoutId;
  r = await rufe('kasse', { cancelOnly: true, supersedes: { reference: 'GNC-W4', checkoutId: 'falsch' } });
  ok('Abbruch mit falscher Checkout-ID storniert nichts', r.d.cancelled === false && lies('orders', 'o:GNC-W4').status === 'pending');
  r = await rufe('kasse', { cancelOnly: true, supersedes: { reference: 'GNC-W4', checkoutId: ckW4 } });
  ok('Abbruch mit Checkout-ID storniert den Vorgang', r.d.cancelled === true && lies('orders', 'o:GNC-W4').status === 'cancelled');
  // Schalter wieder aus: Widget-Wunsch wird abgelehnt
  await rufe('laden', { password: kubi, bereich: 'zahlung', zahlung: { direktZahlung: false } });
  r = await rufe('kasse', { amount: 27, zahlweg: 'widget', reference: 'GNC-W5', order: bestellung('GNC-W5') });
  ok('Schalter wieder aus: sofort zurück zur Weiterleitung', r.d.zahlweg === 'weiterleitung');

  /* ======================================================================= */
  leiseLog('\n4) Burger-Pass kaufen: Gutschrift nur nach Zahlung, genau einmal');
  await rufe('laden', { password: kubi, bereich: 'zahlung', zahlung: { direktZahlung: false, pass: { aktiv: true, name: 'Burger-Pass', preis: 39, menus: 4, tage: 60 } } });
  r = await rufe('laden', undefined, { method: 'GET' });
  ok('Öffentlich: Pass sichtbar mit Preis, Menüs, Tagen', r.d.zahlung.pass && r.d.zahlung.pass.preis === 39 && r.d.zahlung.pass.menus === 4 && r.d.zahlung.pass.tage === 60);
  r = await rufe('pass', { action: 'kaufen', email: MAIL });
  ok('Ohne Anmeldung: 401', r.s === 401);
  r = await rufe('pass', { action: 'kaufen', email: MAIL, token: 'c3'.repeat(24) });
  ok('Falscher Token: 401', r.s === 401);
  r = await rufe('pass', { action: 'kaufen', email: MAIL, token: TOK, preis: 1, menus: 99, lang: 'tr', appMode: 1 });
  pl = SUMUP_POSTS[SUMUP_POSTS.length - 1];
  const kauf = r.d;
  ok('Kauf angelegt (gehostete SumUp-Kasse)', r.s === 200 && /^GNC-BP-/.test(kauf.reference) && !!kauf.hosted_checkout_url, JSON.stringify(r.d));
  ok('Preis aus den Einstellungen, nicht aus der Anfrage (39 €)', pl.amount === 39);
  ok('Rückkehr-Adresse mit pass=return und app=1', /pass=return/.test(pl.redirect_url) && /app=1/.test(pl.redirect_url));
  const kaufKey = 'o:' + kauf.reference;
  let arch = lies('orders', kaufKey);
  ok('Archiv: pending, kind burgerpass, 4 Menüs, 60 Tage, Sprache tr', arch.status === 'pending' && arch.kind === 'burgerpass' && arch.bp.menus === 4 && arch.bp.tage === 60 && arch.bp.lang === 'tr');
  const passMenusJetzt = () => bp.gueltigePassMenus(lies('customers', kundeKey(MAIL)));
  ok('Vor der Zahlung: 0 Pass-Menüs', passMenusJetzt() === 0);

  r = await rufe('pass', { action: 'pruefen', reference: kauf.reference, checkoutId: 'ck_falsch' });
  ok('Prüfen mit falscher Checkout-ID: 404', r.s === 404);
  r = await rufe('pass', { action: 'pruefen', reference: kauf.reference, checkoutId: kauf.id });
  ok('Prüfen, SumUp sagt PENDING: kein Pass', r.d.status === 'PENDING' && passMenusJetzt() === 0);
  r = await rufe('webhook', { id: kauf.id });
  ok('Webhook bei PENDING: kein Pass', passMenusJetzt() === 0 && !lies('paesse', 'p:' + kauf.reference));
  // Ein Angreifer schickt dem Webhook eine erfundene Erfolgsmeldung
  r = await rufe('webhook', { id: kauf.id, status: 'PAID', event_type: 'CHECKOUT_STATUS_CHANGED' });
  ok('Erfundenes PAID im Webhook-Inhalt zählt nicht (Server fragt SumUp)', passMenusJetzt() === 0);

  SUMUP[kauf.id].status = 'PAID';
  const mailsVorher = MAILS.length;
  r = await rufe('webhook', { id: kauf.id });
  ok('Nach PAID: Webhook stellt den Pass aus', r.d.action === 'pass_issued', JSON.stringify(r.d));
  ok('… 4 Pass-Menüs im Konto', passMenusJetzt() === 4);
  const pass1 = lies('paesse', 'p:' + kauf.reference);
  ok('… Pass-Datensatz: Käufer, 4 gesamt, 4 übrig, gültig bis, Bestellnummer', pass1 && pass1.kaeufer.email === MAIL && pass1.menusGesamt === 4 && pass1.menusUebrig === 4 && !!pass1.gueltigBis && pass1.bestellnummer === kauf.reference);
  const tageBis = (new Date(pass1.gueltigBis) - Date.now()) / TAG;
  ok('… gültig bis Ende des 60. Tages (Berlin)', tageBis > 59.9 && tageBis < 61.1 && /T2[12]:59:59/.test(pass1.gueltigBis), pass1.gueltigBis);
  ok('… Stempelkarten-Menüs unverändert (1)', lies('customers', kundeKey(MAIL)).menus === 1);
  ok('… Kaufmail auf Türkisch, genau eine', MAILS.length - mailsVorher === 1 && /aktif/.test(MAILS[MAILS.length - 1].subject), MAILS.slice(mailsVorher).map((m) => m.subject).join(' | '));
  ok('… Telegram an Kubi', TELEGRAM.some((t) => /Burger-Pass verkauft/.test(t.text)));

  r = await rufe('webhook', { id: kauf.id });
  ok('Zweiter Webhook: nichts doppelt', passMenusJetzt() === 4 && MAILS.length - mailsVorher === 1);
  r = await rufe('pass', { action: 'pruefen', reference: kauf.reference, checkoutId: kauf.id });
  ok('Rückkehr des Kunden (pruefen): PAID, nichts doppelt', r.d.status === 'PAID' && passMenusJetzt() === 4);
  arch = lies('orders', kaufKey);
  arch.status = 'pending'; arch.createdAt = iso(Date.now() - 10 * 60000);
  schreib('orders', kaufKey, arch);   // als hinge der Vorgang noch
  await H.abgleich.handler({});
  ok('5-Minuten-Abgleich auf denselben Kauf: nichts doppelt', passMenusJetzt() === 4 && lies('orders', kaufKey).status === 'completed');

  // Gleichzeitige Abschlüsse: genau ein Topf
  r = await rufe('pass', { action: 'kaufen', email: MAIL, token: TOK });
  const kauf2 = r.d;
  SUMUP[kauf2.id].status = 'PAID';
  const rec2 = lies('orders', 'o:' + kauf2.reference);
  await Promise.all([1, 2, 3].map(() => bp.kaufAbschliessen(store('orders'), 'o:' + kauf2.reference, { ...rec2 })));
  const toepfe2 = (lies('customers', kundeKey(MAIL)).passMenus || []).filter((b) => b.pass === kauf2.reference);
  ok('Drei gleichzeitige Abschlüsse: genau ein Topf mit 4 Menüs', toepfe2.length === 1 && toepfe2[0].menus === 4 && passMenusJetzt() === 8);

  // Fehlgeschlagene Zahlung: kein Pass
  r = await rufe('pass', { action: 'kaufen', email: MAIL, token: TOK });
  const kauf3 = r.d;
  SUMUP[kauf3.id].status = 'FAILED';
  await rufe('webhook', { id: kauf3.id });
  ok('FAILED: Vorgang abgebrochen, kein Pass', lies('orders', 'o:' + kauf3.reference).status === 'abandoned' && !lies('paesse', 'p:' + kauf3.reference) && passMenusJetzt() === 8);
  // Abbrechen auf der SumUp-Seite
  r = await rufe('pass', { action: 'kaufen', email: MAIL, token: TOK });
  const kauf4 = r.d;
  r = await rufe('pass', { action: 'abbrechen', supersedes: { reference: kauf4.reference, checkoutId: kauf4.id } });
  ok('Zurück ohne Zahlung: storniert', r.d.cancelled === true && lies('orders', 'o:' + kauf4.reference).status === 'cancelled');
  SUMUP[kauf4.id].status = 'PAID';   // zahlt doch noch (zweiter Tab)
  await rufe('webhook', { id: kauf4.id });
  ok('Zahlung kommt doch noch: Webhook belebt und stellt aus', lies('orders', 'o:' + kauf4.reference).status === 'completed' && passMenusJetzt() === 12);

  r = await rufe('pass', { action: 'liste', password: anna });
  ok('Verkaufsliste: Mitarbeiterin 403', r.s === 403);
  r = await rufe('pass', { action: 'liste', password: kubi });
  ok('Verkaufsliste: Admin sieht 3 Pässe', r.s === 200 && r.d.liste.length === 3, JSON.stringify(r.d).slice(0, 200));

  /* ======================================================================= */
  leiseLog('\n5) Einlösen: frühester Ablauf zuerst, kein Doppelverbrauch, getrennt');
  // Saubere Ausgangslage: Kunde B mit drei Pässen und 1 Stempelkarten-Menü
  const MAIL_B = 'b@example.org', TOK_B = 'd4'.repeat(24), QR_B = 'e5f6'.repeat(5);
  const jetzt = Date.now();
  const toepfe = [
    { pass: 'GNC-BP-SPAET', name: 'Burger-Pass', menus: 4, gesamt: 4, bis: iso(jetzt + 40 * TAG) },
    { pass: 'GNC-BP-ALT', name: 'Burger-Pass', menus: 3, gesamt: 4, bis: iso(jetzt - TAG) },
    { pass: 'GNC-BP-FRUEH', name: 'Burger-Pass', menus: 2, gesamt: 4, bis: iso(jetzt + 10 * TAG) },
  ];
  schreib('customers', kundeKey(MAIL_B), { email: MAIL_B, name: 'Berna', tokens: { [TOK_B]: new Date().toISOString() }, spent: 0, rewards: 0, menus: 1, qrToken: QR_B, passMenus: toepfe });
  schreib('customers', 'qr:' + QR_B, { key: kundeKey(MAIL_B) });
  for (const t of toepfe) schreib('paesse', 'p:' + t.pass, { id: t.pass, name: t.name, kaeufer: { email: MAIL_B, name: 'Berna' }, menusGesamt: 4, menusUebrig: t.menus, gueltigBis: t.bis, bestellnummer: t.pass, status: 'aktiv', gutgeschrieben: true, einloesungen: [], erinnert: {}, lang: 'de', gekauftAm: iso(jetzt - 30 * TAG) });
  const kb = () => lies('customers', kundeKey(MAIL_B));
  const topf = (id) => (kb().passMenus || []).find((b) => b.pass === id);
  ok('Abgelaufener Pass zählt nicht: 6 gültige Pass-Menüs', bp.gueltigePassMenus(kb()) === 6);
  r = await rufe('konto', { action: 'get', email: MAIL_B, token: TOK_B });
  ok('Konto zeigt Pass-Menüs getrennt: 6 Pass, 1 Menü aufs Haus', r.d.profile.loyalty.passMenus === 6 && r.d.profile.loyalty.menus === 1, JSON.stringify(r.d.profile && r.d.profile.loyalty));
  ok('Konto listet je Pass „übrig von gesamt, gültig bis", frühester zuerst', r.d.profile.paesse.length === 2 && r.d.profile.paesse[0].id === 'GNC-BP-FRUEH' && r.d.profile.paesse[0].menus === 2 && r.d.profile.paesse[0].gesamt === 4);

  const korb = { a: { menuId: 'cheese', qty: 1, isMenu: true, side: 'pommes', drink: 'fritz-kola', dip: 'dip-mayo' } };
  const w = SK.warenwert(korb), g = SK.gratisMenuWert(korb);
  const menuBestellung = (ref, tok) => ({
    reference: ref, name: 'Berna', email: MAIL_B, phone: '0171', mode: 'pickup', payment: 'cash', items: [{ name: 'Cheeseburger-Menü', qty: 1, price: w, total: w }],
    cartSnapshot: korb, subtotal: w, discount: 0, loyaltyDiscount: g, loyaltyApplied: true, loyaltyType: 'menu',
    kontoToken: tok, deliveryFee: 0, tip: 0, total: w - g,
  });
  const tgVorher = TELEGRAM.length;
  r = await rufe('mail', { type: 'order_confirmation', order: menuBestellung('GNC-M1', TOK_B) });
  ok('Bestellung 1 mit Menü (bar): angenommen', r.s === 200, JSON.stringify(r.d));
  ok('… Pass mit frühestem Ablauf verbraucht (2 → 1)', topf('GNC-BP-FRUEH') && topf('GNC-BP-FRUEH').menus === 1 && topf('GNC-BP-SPAET').menus === 4);
  ok('… Stempelkarten-Menü bleibt (1)', kb().menus === 1);
  const a1 = lies('orders', 'o:GNC-M1');
  ok('… Bestellung trägt `pass` mit Bezug (id, Menü 3 von 4)', a1 && a1.order.pass && a1.order.pass.id === 'GNC-BP-FRUEH' && a1.order.pass.nr === 3 && a1.order.pass.gesamt === 4, JSON.stringify(a1 && a1.order.pass));
  ok('… Ticket nennt das Burger-Pass-Menü', TELEGRAM.slice(tgVorher).some((t) => /Burger-Pass-Menü/.test(t.text)));
  ok('… Pass-Datensatz: 1 übrig, Einlösung online vermerkt', lies('paesse', 'p:GNC-BP-FRUEH').menusUebrig === 1 && lies('paesse', 'p:GNC-BP-FRUEH').einloesungen[0].wo === 'online');
  ok('… nichts vom kassierten Betrag weg (Menüwert abgezogen)', a1.order.total === Math.round((w - g) * 100) / 100);

  r = await rufe('mail', { type: 'order_confirmation', order: menuBestellung('GNC-M1', TOK_B) });
  ok('Dieselbe Bestellung noch einmal: kein Doppelverbrauch', r.d.duplicate === true && topf('GNC-BP-FRUEH').menus === 1);

  await rufe('mail', { type: 'order_confirmation', order: menuBestellung('GNC-M2', TOK_B) });
  ok('Bestellung 2: früher Pass leer und entfernt', !topf('GNC-BP-FRUEH') && lies('paesse', 'p:GNC-BP-FRUEH').status === 'verbraucht');
  await rufe('mail', { type: 'order_confirmation', order: menuBestellung('GNC-M3', TOK_B) });
  ok('Bestellung 3: nächster Pass (4 → 3), Stempelkarte weiter 1', topf('GNC-BP-SPAET').menus === 3 && kb().menus === 1);
  ok('Abgelaufener Topf beim Schreiben entfernt (verfallen)', !topf('GNC-BP-ALT'));

  // Ohne gültige Anmeldung: kein Menü, voller Preis
  r = await rufe('mail', { type: 'order_confirmation', order: menuBestellung('GNC-M4', 'f7'.repeat(24)) });
  const a4 = lies('orders', 'o:GNC-M4');
  ok('Falscher Token: kein Gratis-Menü, voller Preis, kein Verbrauch', a4.order.total === w && !a4.order.pass && topf('GNC-BP-SPAET').menus === 3);

  // Truck
  r = await rufe('scan', { password: anna, action: 'lookup', token: QR_B });
  ok('Truck-Scan zeigt Pass-Menüs getrennt (3) und Menüs aufs Haus (1)', r.d.card && r.d.card.passMenus === 3 && r.d.card.menus === 1 && r.d.card.paesse.length === 1);
  r = await rufe('scan', { password: anna, action: 'redeem', token: QR_B, kind: 'pass' });
  ok('Truck: Pass-Menü einlösen (3 → 2), Stempelkarte bleibt', r.s === 200 && topf('GNC-BP-SPAET').menus === 2 && kb().menus === 1);
  ok('… Einlösung am Truck mit Namen vermerkt', lies('paesse', 'p:GNC-BP-SPAET').einloesungen.some((e) => e.wo === 'truck' && e.wer === 'Anna'));
  r = await rufe('scan', { password: anna, action: 'redeem', token: QR_B, kind: 'menu' });
  ok('Truck: Menü aufs Haus nimmt die Stempelkarte, nicht den Pass', r.s === 200 && kb().menus === 0 && topf('GNC-BP-SPAET').menus === 2);
  r = await rufe('scan', { password: anna, action: 'redeem', token: QR_B, kind: 'menu' });
  ok('Truck: kein Stempelkarten-Menü mehr: 409, Pass bleibt', r.s === 409 && topf('GNC-BP-SPAET').menus === 2);
  await rufe('scan', { password: anna, action: 'redeem', token: QR_B, kind: 'pass' });
  await rufe('scan', { password: anna, action: 'redeem', token: QR_B, kind: 'pass' });
  r = await rufe('scan', { password: anna, action: 'redeem', token: QR_B, kind: 'pass' });
  ok('Truck: Pass leer: 409 no_pass, nichts negativ', r.s === 409 && r.d.error === 'no_pass' && bp.gueltigePassMenus(kb()) === 0);

  // Gesammelte Stempel landen nie auf dem Pass-Zähler
  r = await rufe('scan', { password: anna, action: 'credit', token: QR_B, amount: 120 });
  ok('Umsatz am Truck füllt die Stempelkarte, nicht den Pass', kb().menus === 1 && bp.gueltigePassMenus(kb()) === 0);

  // Nur abgelaufener Pass, keine Stempel: online kein Gratis-Menü
  const MAIL_C = 'c@example.org', TOK_C = 'a9'.repeat(24);
  schreib('customers', kundeKey(MAIL_C), { email: MAIL_C, tokens: { [TOK_C]: new Date().toISOString() }, menus: 0, passMenus: [{ pass: 'GNC-BP-X', name: 'Burger-Pass', menus: 2, gesamt: 4, bis: iso(jetzt - 60000) }] });
  const mc = menuBestellung('GNC-M5', TOK_C); mc.email = MAIL_C;
  await rufe('mail', { type: 'order_confirmation', order: mc });
  ok('Abgelaufener Pass online: kein Gratis-Menü, voller Preis', lies('orders', 'o:GNC-M5').order.total === w);

  /* ======================================================================= */
  leiseLog('\n6) Ablauf und Erinnerungen (täglicher Lauf)');
  const MAIL_D = 'd@example.org';
  const mk = (id, menus, bisMs, extra) => {
    schreib('paesse', 'p:' + id, { id, name: 'Burger-Pass', kaeufer: { email: MAIL_D, name: 'Deniz' }, menusGesamt: 4, menusUebrig: menus, gueltigBis: iso(bisMs), bestellnummer: id, status: 'aktiv', gutgeschrieben: true, einloesungen: [], erinnert: {}, lang: 'de', gekauftAm: iso(jetzt - 20 * TAG), ...(extra || {}) });
    return { pass: id, name: 'Burger-Pass', menus, gesamt: 4, bis: iso(bisMs) };
  };
  schreib('customers', kundeKey(MAIL_D), { email: MAIL_D, name: 'Deniz', menus: 0, passMenus: [
    mk('GNC-BP-D1', 1, jetzt + 30 * TAG),   // nur noch 1 Menü
    mk('GNC-BP-D2', 3, jetzt + 5 * TAG),    // läuft in 5 Tagen ab
    mk('GNC-BP-D3', 3, jetzt - 3600000),    // seit einer Stunde abgelaufen
  ] });
  const mVorher = MAILS.length;
  let lauf = JSON.parse((await H.erinnerung.handler({})).body);
  const neu = MAILS.slice(mVorher);
  ok('Erinnerung „noch 1 Menü" mit Link zum Neukauf', neu.some((m) => /Noch 1 Menü/.test(m.subject) && /Neuen Pass holen/.test(m.htmlContent) && /pass=konto/.test(m.htmlContent)), neu.map((m) => m.subject).join(' | '));
  ok('Erinnerung 7 Tage vor Ablauf', neu.some((m) => /läuft am .* ab/.test(m.subject)));
  ok('Genau zwei Mails', neu.length === 2, String(neu.length));
  ok('Abgelaufen: Status abgelaufen, 3 Menüs verfallen', lies('paesse', 'p:GNC-BP-D3').status === 'abgelaufen' && lies('paesse', 'p:GNC-BP-D3').verfallen === 3);
  ok('… Topf aus dem Kundendatensatz entfernt', !lies('customers', kundeKey(MAIL_D)).passMenus.some((b) => b.pass === 'GNC-BP-D3'));
  lauf = JSON.parse((await H.erinnerung.handler({})).body);
  ok('Zweiter Lauf: keine Mail doppelt', MAILS.length - mVorher === 2 && lauf.mailAblauf === 0 && lauf.mailLetztes === 0);
  // Verkauf aus: Erinnerung ohne Neukauf-Link
  await rufe('laden', { password: kubi, bereich: 'zahlung', zahlung: { pass: { aktiv: false } } });
  schreib('customers', kundeKey('e@example.org'), { email: 'e@example.org', passMenus: [{ pass: 'GNC-BP-E1', name: 'Burger-Pass', menus: 1, gesamt: 4, bis: iso(jetzt + 20 * TAG) }] });
  schreib('paesse', 'p:GNC-BP-E1', { id: 'GNC-BP-E1', name: 'Burger-Pass', kaeufer: { email: 'e@example.org', name: '' }, menusGesamt: 4, menusUebrig: 1, gueltigBis: iso(jetzt + 20 * TAG), status: 'aktiv', gutgeschrieben: true, erinnert: {}, lang: 'en', gekauftAm: iso(jetzt - 5 * TAG) });
  const m2 = MAILS.length;
  await H.erinnerung.handler({});
  const em = MAILS[m2];
  ok('Verkauf aus: Erinnerung auf Englisch, ohne Neukauf-Knopf', em && /1 meal left/.test(em.subject) && !/Get a new pass/.test(em.htmlContent) && /Go to my account/.test(em.htmlContent));
  // Bestehende Pässe bleiben einlösbar, auch wenn der Verkauf aus ist
  ok('Verkauf aus: gekaufte Pass-Menüs gelten weiter', bp.gueltigePassMenus(lies('customers', kundeKey('e@example.org'))) === 1);

  /* ======================================================================= */
  leiseLog('\n7) Texte');
  for (const l of post.SPRACHEN) {
    const m = post.mailBauen('kauf', { name: 'Burger-Pass', kaeufer: { name: 'X' }, menusGesamt: 4, menusUebrig: 4, gueltigBis: iso(jetzt + 60 * TAG), bestellnummer: 'GNC-BP-1', lang: l });
    const roh = m.betreff + m.html.replace(/<[^>]+>/g, ' ');
    if (/[–—!]/.test(roh)) { ok('Mailtext ' + l + ' ohne Gedankenstrich und Ausrufezeichen', false, roh.match(/.{0,30}[–—!].{0,30}/)[0]); }
  }
  ok('Mails in 8 Sprachen ohne Gedankenstrich und Ausrufezeichen', true);

  leiseLog('\n' + '─'.repeat(74));
  leiseLog(fehler === 0 ? gruen('ERGEBNIS: ✅ ' + n + ' von ' + n + ' Prüfungen grün.') : rot('ERGEBNIS: ❌ ' + fehler + ' von ' + n + ' Prüfungen fehlgeschlagen.'));
  process.exit(fehler === 0 ? 0 : 1);
})().catch((e) => { console.error = leiseFehler; leiseFehler(rot('Abbruch: ' + (e && e.stack || e))); process.exit(1); });
