#!/usr/bin/env node
/**
 * werkzeug/firmen-test.js
 * ----------------------------------------------------------------------------
 * Firmen-Mittag gegen die echten Handler, mit Blob-Speicher im Arbeitsspeicher:
 *
 *   node werkzeug/firmen-test.js
 *
 * Abgedeckt: Antrag (Honigtopf, Pflichtfelder, Telegram, Bremse), Admin nur
 * für Admins, Firmencode, E-Mail-Domain, Monatslimit, inaktive Firma,
 * serverseitige Ablehnung in send-email.js, keine Rabatte und keine
 * Stempelkarte auf Firmenrechnung, Umsatz zählt, Sammelrechnung enthält genau
 * die Firmenbestellungen des Monats, PDF und XRechnung gültig, Versand nur
 * auf Klick, Gruppenbestellung mit Annahmeschluss.
 * Die Steueraufstellung der Testbestellungen kommt aus den echten Funktionen
 * in index.html (splitVat, buildVatSummary), nicht aus einer Nachbildung.
 * Nach außen geht nichts: fetch ist abgefangen und protokolliert.
 * ----------------------------------------------------------------------------
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');

const W = path.join(__dirname, '..');
const FN = path.join(W, 'netlify', 'functions');

/* ---- Blob-Speicher im Arbeitsspeicher (mit onlyIfNew wie Netlify) ---- */
const daten = new Map();
const store = (name) => ({
  async get(k, o) { const v = daten.get(name + '|' + k); return v === undefined ? null : (o && o.type === 'json' ? JSON.parse(v) : v); },
  async setJSON(k, v, o) {
    if (o && o.onlyIfNew && daten.has(name + '|' + k)) return { modified: false };
    daten.set(name + '|' + k, JSON.stringify(v)); return { modified: true };
  },
  async set(k, v) { daten.set(name + '|' + k, String(v)); },
  async delete(k) { daten.delete(name + '|' + k); },
  async list({ prefix } = {}) { return { blobs: [...daten.keys()].filter((k) => k.startsWith(name + '|' + (prefix || ''))).map((k) => ({ key: k.slice(name.length + 1) })) }; },
});
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) { if (r === '@netlify/blobs') return '@netlify/blobs'; return orig.call(this, r, ...a); };
require.cache['@netlify/blobs'] = { id: '@netlify/blobs', exports: { getStore: (o) => store(typeof o === 'string' ? o : o.name) }, loaded: true };
const lies = (name, k) => { const v = daten.get(name + '|' + k); return v === undefined ? null : JSON.parse(v); };
const schreib = (name, k, v) => daten.set(name + '|' + k, JSON.stringify(v));
const schluessel = (name, prefix) => [...daten.keys()].filter((k) => k.startsWith(name + '|' + (prefix || ''))).map((k) => k.slice(name.length + 1));

/* ---- Umgebung: nur Platzhalter, nichts Echtes ---- */
process.env.ADMIN_PASSWORD = 'kubi-test-passwort';
delete process.env.ZWEI_FAKTOR;
delete process.env.INTERNAL_HOOK_SECRET;
delete process.env.TURNSTILE_SECRET;
Object.assign(process.env, {
  BREVO_API_KEY: 'test-nicht-echt', BREVO_SENDER_EMAIL: 'test@example.com', OWNER_EMAIL: 'inhaber@example.com',
  STATUS_UPDATE_SECRET: 'test-status-geheim', TELEGRAM_BOT_TOKEN: 'test-bot', TELEGRAM_CHAT_ID: '1',
  RECHNUNG_IBAN: 'DE02 1203 0000 0000 2020 51', RECHNUNG_BIC: 'BYLADEM1001',
});
const anrufe = [];
global.fetch = async (url, opt) => {
  anrufe.push({ url: String(url), body: opt && opt.body ? String(opt.body) : '' });
  const ok = (d) => ({ ok: true, status: 200, json: async () => d, text: async () => JSON.stringify(d) });
  if (/api\.brevo\.com/.test(url)) return ok({ messageId: 'test' });
  if (/api\.telegram\.org/.test(url)) return ok({ ok: true });
  return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
};
const LAUT = !!process.env.LAUT;
if (!LAUT) { console.warn = () => {}; console.error = () => {}; }

const sitzung = require(FN + '/lib/admin-sitzung.js');
const tp = require(FN + '/lib/team-passwort.js');
const L = require(FN + '/lib/firmen.js');
const { buildInvoicePdf, buildInvoiceXml } = require(FN + '/lib/invoice.js');
const firmenFn = require(FN + '/firmen.js');
const admin = require(FN + '/firmen-admin.js');
const mail = require(FN + '/send-email.js');
const gruppe = require(FN + '/group-order.js');
const pdfFn = require(FN + '/invoice-pdf.js');
const SK = require(path.join(W, 'speisekarte.js'));

/* ---- Echte Steuerfunktionen aus index.html (unverändert ausgeführt) ---- */
const html = fs.readFileSync(path.join(W, 'index.html'), 'utf8');
const sv = html.indexOf('const VAT_FOOD = 7;');
const sb = html.indexOf('/* ====', html.indexOf('function buildVatSummary'));
if (sv < 0 || sb < 0) { console.error('Steuerfunktionen in index.html nicht gefunden'); process.exit(2); }
const STEUER = new Function('MENU', 'entryUnitPrice', html.slice(sv, sb) + '\nreturn { splitVat, buildVatSummary };')(SK.MENU, SK.einzelpreis);

let fehler = 0, n = 0;
const ok = (name, b, info) => { n++; process.stdout.write((b ? '✅ ' : '❌ ') + name + (b || !info ? '' : '  → ' + info) + '\n'); if (!b) fehler++; };
let ip = 1;
const ev = (body, eigeneIp, methode) => ({ httpMethod: methode || 'POST', headers: { 'x-nf-client-connection-ip': eigeneIp || ('10.9.0.' + (ip++ % 250)) }, body: JSON.stringify(body) });
const call = async (h, body, eigeneIp) => { const r = await h.handler(ev(body, eigeneIp)); let d = {}; try { d = JSON.parse(r.body); } catch (e) {} return { s: r.statusCode, d, r }; };

/* Bestellung so, wie die Kasse sie für "Auf Firmenrechnung" baut */
let refZaehler = 0;
function bestellung({ korb, mode = 'delivery', fee = 2.5, email, code, ref, extra }) {
  const sub = SK.warenwert(korb);
  const gebuehr = mode === 'delivery' ? fee : 0;
  const items = Object.values(korb).map((e) => {
    const it = SK.MENU.find((m) => m.id === e.menuId);
    const up = SK.einzelpreis(e);
    return { name: it.name + (e.isMenu ? '-Menü' : ''), qty: e.qty, price: up, total: up * e.qty, double: !!e.double, isMenu: !!e.isMenu, vatSplit: STEUER.splitVat(e, up * e.qty) };
  });
  return {
    reference: ref || ('GNC-' + (Date.now() + (++refZaehler))),
    name: 'Lena Krüger', email, phone: '0151 1234567', note: '', mode, payment: 'firma',
    items, subtotal: sub, discount: 0, loyaltyDiscount: 0, loyaltyApplied: false, deliveryFee: gebuehr, tip: 0,
    total: SK.gesamtbetrag({ warenwert: sub, liefergebuehr: gebuehr }),
    cartSnapshot: korb, firmaCode: code,
    vat: STEUER.buildVatSummary(korb, 0, gebuehr, 0),
    deliveryAddress: mode === 'delivery' ? { street: 'Irgendwo 1', zip: '33602', city: 'Bielefeld', zone: 'Zone 1', distance: 2 } : null,
    ...(extra || {}),
  };
}
const KORB_KLEIN = { classic: { menuId: 'classic', qty: 2, double: false } };                      // 16,00
const KORB_MENU = { 'cheese__menu__pommes__fritz-kola__dip-mayo': { menuId: 'cheese', qty: 1, double: false, isMenu: true, side: 'pommes', drink: 'fritz-kola', dip: 'dip-mayo' }, sucuk: { menuId: 'sucuk', qty: 1, double: true } };
const bestellen = (o, eigeneIp) => call(mail, { type: 'order_confirmation', order: o }, eigeneIp);

(async () => {
  /* ---------------- Grundbausteine ---------------- */
  ok('Code-Format FIRMA-XXXXXX ohne 0/O/1/I', Array.from({ length: 50 }, L.neuerCode).every((c) => /^FIRMA-[A-HJ-NP-Z2-9]{6}$/.test(c)));
  ok('Code: Kleinschrift, Leerzeichen und ohne Bindestrich werden erkannt',
    L.codeNormalisieren(' firma-7kq2xm ') === 'FIRMA-7KQ2XM' && L.codeNormalisieren('FIRMA7KQ2XM') === 'FIRMA-7KQ2XM' && L.codeNormalisieren('7kq2xm') === 'FIRMA-7KQ2XM');
  ok('Code: falsche Länge und verbotene Zeichen abgelehnt', L.codeNormalisieren('FIRMA-7KQ2') === '' && L.codeNormalisieren('FIRMA-OOOOOO') === '');
  ok('Domains: aus Eingabe gelesen und bereinigt', JSON.stringify(L.domainsLesen('@Beispiel-GmbH.de, https://www.werk.example.org/x')) === '["beispiel-gmbh.de","werk.example.org"]');
  ok('Domain passt exakt und als Unterdomain, sonst nicht',
    L.domainPasst({ domains: ['firma.de'] }, 'a@firma.de') && L.domainPasst({ domains: ['firma.de'] }, 'a@team.firma.de')
    && !L.domainPasst({ domains: ['firma.de'] }, 'a@nichtfirma.de') && !L.domainPasst({ domains: ['firma.de'] }, '') && L.domainPasst({ domains: [] }, 'x@y.de'));
  // Termin: 02.11.2026 ist ein Montag
  const t1 = L.mittagTermin(new Date('2026-11-02T08:00:00Z'));    // 09:00 Berlin
  const t2 = L.mittagTermin(new Date('2026-11-02T10:30:00Z'));    // 11:30 Berlin
  const t3 = L.mittagTermin(new Date('2026-11-05T11:00:00Z'));    // Donnerstag 12:00
  const t4 = L.mittagTermin(new Date('2026-11-07T11:00:00Z'));    // Samstag 12:00
  ok('Firmen-Mittag: vor 11:00 heute, Schluss 11:00 und Lieferung 12:00 Berliner Zeit',
    t1.datum === '2026-11-02' && t1.schluss === '2026-11-02T10:00:00.000Z' && t1.lieferung === '2026-11-02T11:00:00.000Z');
  ok('Firmen-Mittag: nach 11:00 der nächste Tag', t2.datum === '2026-11-03');
  ok('Firmen-Mittag: Freitag übersprungen (Lieferung erst ab 14:30)', t3.datum === '2026-11-07');
  ok('Firmen-Mittag: Sonntag übersprungen', t4.datum === '2026-11-09');

  const echt = STEUER.buildVatSummary(KORB_MENU, 0, 2.5, 0);
  const proOrder = { vat: echt, total: SK.gesamtbetrag({ warenwert: SK.warenwert(KORB_MENU), liefergebuehr: 2.5 }) };
  ok('Steueraufstellung aus index.html gilt als stimmig', L.vatStimmig(proOrder));
  ok('Steueraufstellung mit falschem Gesamtbetrag fällt auf', !L.vatStimmig({ ...proOrder, total: proOrder.total - 3 }));
  ok('Steueraufstellung mit erfundenem Satz fällt auf', !L.vatStimmig({ vat: [{ satz: 0, brutto: proOrder.total, netto: proOrder.total, steuer: 0 }], total: proOrder.total }));

  /* ---------------- Antrag ---------------- */
  const antrag = {
    action: 'antrag', firma: 'Beispiel <b>GmbH</b>', ansprechperson: 'Mara Sommer', email: 'mara@beispiel-gmbh.de', telefon: '0521 123456',
    lieferadresse: { street: 'Artur-Ladebeck-Str. 10', zip: '33647', city: 'Bielefeld' },
    rechnungsadresse: { street: 'Postfach 1', zip: '33602', city: 'Bielefeld' },
    ustId: 'de 123 456 789', domain: 'beispiel-gmbh.de', personen: 25, gebiet: { km: 2.4, zone: 1, fee: 2.5 }, lang: 'de',
  };
  let r = await call(firmenFn, { ...antrag, website: 'http://spam' }, '10.50.0.1');
  ok('Antrag: Honigtopf bekommt ok, gespeichert wird nichts', r.s === 200 && r.d.ok && schluessel('firmen', 'antrag:').length === 0);
  r = await call(firmenFn, { ...antrag, email: 'kaputt', lieferadresse: { street: 'X', zip: '12', city: '' } }, '10.50.0.2');
  ok('Antrag: fehlende Pflichtfelder → 400 mit Liste', r.s === 400 && r.d.felder.includes('email') && r.d.felder.includes('lieferadresse'));
  r = await call(firmenFn, { ...antrag, gebiet: { km: 20, zone: 0, fee: 0 } }, '10.50.0.3');
  ok('Antrag: außerhalb des Liefergebiets abgelehnt', r.s === 400 && r.d.error === 'gebiet');
  const tgVorher = anrufe.filter((a) => /telegram/.test(a.url)).length;
  r = await call(firmenFn, antrag, '10.50.0.4');
  const antraege = schluessel('firmen', 'antrag:');
  const a1 = antraege.length && lies('firmen', antraege[0]);
  ok('Antrag gespeichert als antrag:<id>, Status neu, USt-IdNr. bereinigt', r.s === 200 && antraege.length === 1 && a1.status === 'neu' && a1.ustId === 'DE123456789' && a1.gebiet.quelle === 'browser');
  const tg = anrufe.filter((a) => /telegram/.test(a.url));
  ok('Antrag: Telegram an Kubi, ohne HTML aus dem Formular', tg.length === tgVorher + 1 && /Beispiel/.test(tg[tg.length - 1].body) && !/<b>GmbH/.test(tg[tg.length - 1].body));
  for (let i = 0; i < 5; i++) await call(firmenFn, { ...antrag, firma: 'Spam ' + i }, '10.50.0.9');
  r = await call(firmenFn, { ...antrag, firma: 'Spam 5' }, '10.50.0.9');
  ok('Antrag: Bremse nach 5 je Stunde und Anschluss (429)', r.s === 429);
  for (const k of schluessel('firmen', 'antrag:')) { if (lies('firmen', k).firma.startsWith('Spam')) daten.delete('firmen|' + k); }

  /* ---------------- Admin: Anmeldung ---------------- */
  const kubi = (await sitzung.erstelle('kubi-test-passwort', { role: 'superadmin', name: 'Kubi' }, { zweiFaktor: true })).token;
  schreib('team', 'u:kutluay', { name: 'Kutluay', role: 'staff', pwHash: await tp.hashen('glut-sesam-truck-42') });
  const staff = (await sitzung.erstelle('glut-sesam-truck-42', { role: 'staff', name: 'Kutluay' }, { zweiFaktor: true })).token;
  ok('Admin: ohne Anmeldung 401', (await call(admin, { action: 'uebersicht' })).s === 401);
  ok('Admin: Mitarbeiter 403', (await call(admin, { action: 'uebersicht', password: staff })).s === 403);
  ok('Admin: reines Passwort ohne Code 401', (await call(admin, { action: 'uebersicht', password: 'kubi-test-passwort' })).s === 401);
  r = await call(admin, { action: 'uebersicht', password: kubi });
  ok('Admin: Übersicht zeigt den Antrag', r.s === 200 && r.d.antraege.length === 1 && r.d.iban === true);

  r = await call(admin, { action: 'antrag_annehmen', password: kubi, id: a1.id, limit: 60 });
  const firma = r.d.firma;
  ok('Antrag annehmen: Firma mit Code, aktiv, Limit 60, Ziel 14 Tage, Domain aus dem Antrag',
    r.s === 200 && /^FIRMA-[A-HJ-NP-Z2-9]{6}$/.test(firma.code) && firma.aktiv && firma.limit === 60 && firma.zahlungsziel === 14
    && firma.domains[0] === 'beispiel-gmbh.de' && lies('firmen', 'code:' + firma.code).id === firma.id && lies('firmen', 'antrag:' + a1.id).status === 'angenommen');
  r = await call(admin, { action: 'antrag_annehmen', password: kubi, id: a1.id });
  ok('Antrag zweimal annehmen: dieselbe Firma, kein zweiter Code', r.s === 200 && r.d.firma.code === firma.code && schluessel('firmen', 'code:').length === 1);

  /* ---------------- Prüfung für die Kasse ---------------- */
  const pr = (body) => call(firmenFn, { action: 'pruefen', ...body });
  ok('Prüfen: falscher Code', (await pr({ code: 'FIRMA-ZZZZZZ', email: 'lena@beispiel-gmbh.de', betrag: 10 })).d.grund === 'code');
  r = await pr({ code: firma.code.toLowerCase().replace('-', ' '), email: 'lena@beispiel-gmbh.de', betrag: 10 });
  ok('Prüfen: richtiger Code (klein geschrieben) → Firma, Adresse, Rest 60', r.d.ok && r.d.firma.name === firma.name && r.d.firma.lieferadresse.zip === '33647' && r.d.rest === 60 && !r.d.firma.code);
  ok('Prüfen: fremde E-Mail-Domain', (await pr({ code: firma.code, email: 'lena@gmail.com', betrag: 10 })).d.grund === 'domain');
  ok('Prüfen: Unterdomain der Firma passt', (await pr({ code: firma.code, email: 'lena@team.beispiel-gmbh.de', betrag: 10 })).d.ok);
  r = await pr({ code: firma.code, email: 'lena@beispiel-gmbh.de', betrag: 61 });
  ok('Prüfen: Betrag über dem Monatslimit', r.d.grund === 'limit' && r.d.rest === 60);
  await call(admin, { action: 'firma_speichern', password: kubi, id: firma.id, firma: { aktiv: false } });
  ok('Prüfen: inaktive Firma', (await pr({ code: firma.code, email: 'lena@beispiel-gmbh.de', betrag: 10 })).d.grund === 'inaktiv');

  /* ---------------- Bestellen: serverseitige Prüfung ---------------- */
  let o = bestellung({ korb: KORB_KLEIN, email: 'lena@beispiel-gmbh.de', code: firma.code });
  r = await bestellen(o);
  ok('Bestellung bei inaktiver Firma: 403, nichts im Archiv', r.s === 403 && r.d.grund === 'inaktiv' && !lies('orders', 'o:' + o.reference));
  await call(admin, { action: 'firma_speichern', password: kubi, id: firma.id, firma: { aktiv: true, rechnungsEmail: 'buchhaltung@beispiel-gmbh.de' } });

  o = bestellung({ korb: KORB_KLEIN, email: 'lena@beispiel-gmbh.de', code: 'FIRMA-ZZZZZZ' });
  r = await bestellen(o);
  ok('Bestellung ohne gültigen Code: 403, nichts im Archiv, keine Mail', r.s === 403 && r.d.grund === 'code' && !lies('orders', 'o:' + o.reference));
  o = bestellung({ korb: KORB_KLEIN, email: 'lena@beispiel-gmbh.de' });
  ok('Bestellung ganz ohne Code: 403', (await bestellen(o)).s === 403);
  o = bestellung({ korb: KORB_KLEIN, email: 'lena@gmail.com', code: firma.code });
  ok('Bestellung mit fremder Domain: 403 domain', (await bestellen(o)).d.grund === 'domain');
  o = bestellung({ korb: KORB_KLEIN, email: 'lena@beispiel-gmbh.de', code: firma.code, ref: 'GNC-1' });
  ok('Bestellung mit erfundener Bestellnummer: 403', (await bestellen(o)).d.grund === 'pruefung');
  r = await call(mail, { type: 'owner_notification', order: bestellung({ korb: KORB_KLEIN, email: 'lena@beispiel-gmbh.de', code: firma.code }) });
  ok('Firmenrechnung über owner_notification: 400', r.s === 400 && r.d.error === 'firma');

  // Gutschein, Stempelkarte, Trinkgeld und ein zu niedriger Betrag aus dem Browser
  o = bestellung({ korb: KORB_KLEIN, email: 'lena@beispiel-gmbh.de', code: firma.code });
  const manip = { ...o, voucherCode: 'GRILL5', promo: { code: 'GRILL5' }, discount: 5, loyaltyApplied: true, loyaltyDiscount: 5, tip: 2, total: o.total - 10, vat: STEUER.buildVatSummary(KORB_KLEIN, 10, 2.5, 0) };
  r = await bestellen(manip);
  ok('Rabatte auf Firmenrechnung: gestrichen, unstimmige Steuer → 403', r.s === 403 && r.d.grund === 'pruefung');

  const anrufeVorher = anrufe.length;
  const kundenVorher = schluessel('customers').length;
  const heute = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
  const revVorher = lies('orders', 'rev:' + heute) || { oCount: 0, oTotal: 0 };
  o = bestellung({ korb: KORB_KLEIN, email: 'lena@beispiel-gmbh.de', code: firma.code, extra: { voucherCode: 'GRILL5' } });
  r = await bestellen(o);
  const rec1 = lies('orders', 'o:' + o.reference);
  ok('Ehrliche Firmenbestellung: 200, im Archiv mit firma und Zahlart firma', r.s === 200 && rec1 && rec1.status === 'completed' && rec1.order.firma === firma.id && rec1.order.payment === 'firma' && rec1.order.firmaName === firma.name);
  ok('Archiv: kein Firmencode, kein Gutscheincode, Lieferadresse der Firma', !('firmaCode' in rec1.order) && !rec1.order.voucherCode && rec1.order.deliveryAddress.street === 'Artur-Ladebeck-Str. 10');
  ok('Keine Einzelrechnung (kein company, keine Rechnungsnummer)', !rec1.order.company && !rec1.order.invoiceNo && schluessel('invoices', 'inv:').length === 0);
  const neueAnrufe = anrufe.slice(anrufeVorher);
  ok('Telegram und Inhaber-Mail sagen "nicht kassieren"', neueAnrufe.some((a) => /telegram/.test(a.url) && /nicht kassieren/.test(a.body)) && neueAnrufe.some((a) => /brevo/.test(a.url) && /nicht kassieren/.test(a.body)));
  ok('Kundenmail nennt die Firmenrechnung', neueAnrufe.some((a) => /brevo/.test(a.url) && /Auf Firmenrechnung/.test(a.body)));
  ok('Keine Stempelkarte, keine Rückhol-Mail', schluessel('customers').length === kundenVorher && !schluessel('retarget').length);
  const revNach = lies('orders', 'rev:' + heute);
  ok('Umsatzübersicht zählt die Bestellung (rev:<Tag>)', revNach && revNach.oCount === revVorher.oCount + 1 && Math.abs(revNach.oTotal - revVorher.oTotal - o.total) < 0.001);
  const monatJetzt = L.monatVon(Date.now());
  let nutz = lies('firmen', 'nutzung:' + firma.id + ':' + monatJetzt);
  ok('Monatsnutzung: 18,50 € vermerkt', nutz && nutz.summe === 18.5 && nutz.eintraege[o.reference]);
  r = await bestellen(o);
  nutz = lies('firmen', 'nutzung:' + firma.id + ':' + monatJetzt);
  ok('Dieselbe Bestellung erneut: duplicate, nicht doppelt gezählt', r.s === 200 && r.d.duplicate && Object.keys(nutz.eintraege).length === 1 && nutz.summe === 18.5);

  const o2 = bestellung({ korb: KORB_MENU, email: 'tom@beispiel-gmbh.de', code: firma.code });
  r = await bestellen(o2);
  ok('Zweite Bestellung (Menü, 7 % und 19 %) im Limit: 200', r.s === 200);
  nutz = lies('firmen', 'nutzung:' + firma.id + ':' + monatJetzt);
  const o3 = bestellung({ korb: { nug20: { menuId: 'nug20', qty: 3 } }, email: 'tom@beispiel-gmbh.de', code: firma.code });
  r = await bestellen(o3);
  ok('Bestellung über dem Monatslimit: 403 limit mit Rest', r.s === 403 && r.d.grund === 'limit' && Math.abs(r.d.rest - (60 - nutz.summe)) < 0.001);

  o = bestellung({ korb: KORB_KLEIN, email: 'gast@example.com', extra: { payment: 'cash', firma: firma.id, firmaName: 'Geklaut' } });
  delete o.firmaCode;
  r = await bestellen(o);
  const recBar = lies('orders', 'o:' + o.reference);
  ok('Barbestellung mit untergeschobenem firma-Feld: Feld entfernt', r.s === 200 && recBar && !recBar.order.firma && !recBar.order.firmaName);

  /* ---------------- Sammelrechnung ---------------- */
  // Vormonat: zwei Bestellungen der Firma, eine davon erstattet, dazu eine fremde Firma
  const vm = L.vormonat(monatJetzt);
  const vmZeit = (tag) => new Date(vm + '-' + String(tag).padStart(2, '0') + 'T11:00:00Z').toISOString();
  const fremd = { ...firma, id: 'fremd1', name: 'Andere AG', code: 'FIRMA-ABCDEF' };
  schreib('firmen', 'firma:fremd1', fremd);
  const vmOrders = [
    { o: bestellung({ korb: KORB_KLEIN, email: 'a@beispiel-gmbh.de', ref: 'GNC-1700000000001' }), firma: firma.id, tag: 3, status: 'completed' },
    { o: bestellung({ korb: KORB_MENU, email: 'b@beispiel-gmbh.de', ref: 'GNC-1700000000002' }), firma: firma.id, tag: 12, status: 'completed' },
    { o: bestellung({ korb: KORB_MENU, email: 'c@beispiel-gmbh.de', ref: 'GNC-1700000000003' }), firma: firma.id, tag: 20, status: 'refunded' },
    { o: bestellung({ korb: KORB_KLEIN, email: 'd@andere.de', ref: 'GNC-1700000000004' }), firma: 'fremd1', tag: 5, status: 'completed' },
  ];
  for (const v of vmOrders) {
    v.o.firma = v.firma; v.o.firmaName = 'x';
    await L.bestellungVermerken(v.o, { at: vmZeit(v.tag) });
    schreib('orders', 'o:' + v.o.reference, { status: v.status, completedAt: vmZeit(v.tag), order: v.o });
  }
  // Archiv-Eintrag ohne Vermerk (Vermerken war gescheitert) → Abgleich holt ihn
  const verloren = bestellung({ korb: KORB_KLEIN, email: 'e@beispiel-gmbh.de', ref: 'GNC-' + (Date.now() - 5000) });
  verloren.firma = firma.id;
  schreib('orders', 'o:' + verloren.reference, { status: 'completed', completedAt: new Date().toISOString(), order: verloren });
  r = await call(admin, { action: 'abgleich', password: kubi, id: firma.id });
  ok('Abgleich trägt die fehlende Bestellung nach', r.s === 200 && r.d.neu === 1 && lies('firmen', 'nutzung:' + firma.id + ':' + monatJetzt).eintraege[verloren.reference]);
  r = await call(admin, { action: 'abgleich', password: kubi, id: firma.id });
  ok('Abgleich ein zweites Mal: nichts doppelt', r.d.neu === 0);

  r = await call(admin, { action: 'bestellungen', password: kubi, id: firma.id });
  const mAkt = r.d.monate && r.d.monate[0], mVor = r.d.monate && r.d.monate[1];
  ok('Übersicht: laufender Monat mit Summe', r.s === 200 && mAkt.monat === monatJetzt && mAkt.anzahl === 3 && Math.abs(mAkt.summe - (18.5 + o2.total + 18.5)) < 0.001);
  ok('Übersicht: Vormonat zählt die Erstattung nicht', mVor.monat === vm && mVor.anzahl === 2 && mVor.bestellungen.length === 3 && mVor.abgeschlossen);

  r = await call(admin, { action: 'rechnung_erstellen', password: kubi, id: firma.id, monat: monatJetzt });
  ok('Laufender Monat lässt sich nicht abrechnen (409)', r.s === 409 && r.d.error === 'monat_offen');
  r = await call(admin, { action: 'rechnung_erstellen', password: kubi, id: firma.id, monat: vm });
  const meta = r.d.rechnung;
  const inv = meta && lies('invoices', 'inv:' + meta.invoiceNo);
  const soll = [vmOrders[0].o, vmOrders[1].o];
  const sollSumme = L.r2(soll.reduce((a, x) => a + x.total, 0));
  ok('Sammelrechnung erstellt, Status erstellt, Nummer aus dem gemeinsamen Kreis', r.s === 200 && /^GNC-\d{4}-\d{4}$/.test(meta.invoiceNo) && meta.status === 'erstellt' && !!inv && !inv.platzhalter);
  ok('Sammelrechnung enthält genau die Firmenbestellungen des Monats (ohne Erstattung, ohne fremde Firma)',
    JSON.stringify(inv.sammel.refs) === JSON.stringify(soll.map((x) => x.reference)) && inv.sammel.anzahl === 2);
  ok('Summe, Liefergebühr und Positionen stimmen', inv.total === sollSumme && inv.deliveryFee === 5 && inv.items.length === soll.reduce((a, x) => a + x.items.length, 0));
  ok('Steuer je Satz = Summe der Einzelaufstellungen, Brutto = Gesamt', Math.abs(inv.vat.reduce((a, v) => a + v.brutto, 0) - inv.total) < 0.011
    && inv.vat.find((v) => v.satz === 19).steuer === L.r2(soll.reduce((a, x) => a + ((x.vat.find((v) => v.satz === 19) || {}).steuer || 0), 0)));
  ok('Rechnung an die Rechnungsadresse, mit USt-IdNr., Zahlungsziel 14 Tage', inv.invoiceAddress.street === 'Postfach 1' && inv.ustIdKunde === 'DE123456789' && inv.zahlungsziel === 14 && /^\d{2}\.\d{2}\.\d{4}$/.test(inv.faelligAm));
  ok('Positionen nennen Tag und Besteller', /^03\.\d{2}\. Lena K\.: /.test(inv.items[0].name));
  r = await call(admin, { action: 'rechnung_erstellen', password: kubi, id: firma.id, monat: vm });
  ok('Zweiter Klick: dieselbe Rechnung, keine neue Nummer', r.s === 200 && r.d.schon && r.d.rechnung.invoiceNo === meta.invoiceNo && schluessel('invoices', 'inv:').length === 1);

  const pdf = await buildInvoicePdf(inv);
  ok('PDF gültig (%PDF-Kopf, %%EOF am Ende)', pdf.slice(0, 5).toString() === '%PDF-' && /%%EOF\s*$/.test(pdf.slice(-32).toString()) && pdf.length > 1500);
  const xml = buildInvoiceXml(inv);
  const gesamtXml = Number((/<ram:GrandTotalAmount>([\d.]+)</.exec(xml) || [])[1]);
  ok('XRechnung: Überweisung (58), IBAN, Fälligkeit, Zeitraum, Endbetrag = Gesamt',
    /<ram:TypeCode>58<\/ram:TypeCode>/.test(xml) && /<ram:IBANID>DE02120300000000202051</.test(xml) && /<ram:DueDateDateTime>/.test(xml)
    && /<ram:BillingSpecifiedPeriod>/.test(xml) && Math.abs(gesamtXml - inv.total) < 0.005 && /schemeID="VA">DE123456789</.test(xml));
  const lang = { ...inv, items: Array.from({ length: 60 }, (_, i) => ({ ...inv.items[0], name: inv.items[0].name + ' Nr. ' + i })) };
  const pdfLang = await buildInvoicePdf(lang);
  ok('PDF mit 60 Positionen (mehrere Seiten) bleibt gültig', /%%EOF\s*$/.test(pdfLang.slice(-32).toString()) && (pdfLang.toString('latin1').match(/\/Type \/Page\b/g) || []).length >= 2);
  const einzel = await pdfFn.handler({ httpMethod: 'GET', headers: { 'x-gnc-sitzung': kubi, 'x-nf-client-connection-ip': '10.70.0.1' }, queryStringParameters: { no: meta.invoiceNo } });
  ok('Vorhandener PDF-Abruf (invoice-pdf.js) liefert die Sammelrechnung', einzel.statusCode === 200 && Buffer.from(einzel.body, 'base64').slice(0, 5).toString() === '%PDF-');

  ok('Erstellen schickt keine Mail an die Firma', !anrufe.some((a) => /brevo/.test(a.url) && /buchhaltung@beispiel-gmbh\.de/.test(a.body)));
  r = await call(admin, { action: 'rechnung_senden', password: staff, id: firma.id, monat: vm });
  ok('Versand durch Mitarbeiter: 403', r.s === 403);
  r = await call(admin, { action: 'rechnung_senden', password: kubi, id: firma.id, monat: vm });
  const versand = anrufe.filter((a) => /brevo/.test(a.url) && /buchhaltung@beispiel-gmbh\.de/.test(a.body));
  ok('Versand auf Klick: an die Rechnungsadresse, PDF und XML im Anhang, Status versendet',
    r.s === 200 && r.d.rechnung.status === 'versendet' && versand.length === 1 && versand[0].body.includes('Rechnung-' + meta.invoiceNo + '.pdf') && versand[0].body.includes('Rechnung-' + meta.invoiceNo + '.xml'));
  r = await call(admin, { action: 'rechnung_status', password: kubi, id: firma.id, monat: vm, status: 'bezahlt' });
  ok('Status bezahlt', r.s === 200 && r.d.rechnung.status === 'bezahlt' && lies('firmen', 'rechnung:' + firma.id + ':' + vm).bezahltAm);

  /* ---------------- Code neu, alter Code tot ---------------- */
  const alterCode = firma.code;
  r = await call(admin, { action: 'firma_speichern', password: kubi, id: firma.id, firma: { limit: 500 } });
  ok('Limit lässt sich anheben', r.s === 200 && r.d.firma.limit === 500);
  r = await call(admin, { action: 'code_neu', password: kubi, id: firma.id });
  ok('Neuer Code: alter gilt nicht mehr, neuer schon', r.s === 200 && r.d.firma.code !== alterCode
    && (await pr({ code: alterCode, email: 'lena@beispiel-gmbh.de', betrag: 1 })).d.grund === 'code'
    && (await pr({ code: r.d.firma.code, email: 'lena@beispiel-gmbh.de', betrag: 1 })).d.ok);
  const code2 = r.d.firma.code;

  /* ---------------- Gruppenbestellung als Firmen-Mittag ---------------- */
  r = await call(gruppe, { action: 'create', host: 'Mara', firmaCode: 'FIRMA-ZZZZZZ' });
  ok('Gruppe mit falschem Firmencode: 400', r.s === 400 && r.d.grund === 'code');
  r = await call(gruppe, { action: 'create', host: 'Mara', firmaCode: code2 });
  const gid = r.d.id;
  ok('Gruppe mit Firmencode: Firmen-Mittag mit Termin, Code nicht in der Gruppe',
    r.s === 200 && r.d.group.firmenMittag && r.d.group.firmenMittag.firma === firma.name && r.d.group.firmenMittag.lieferZeit === '12:00'
    && !JSON.stringify(r.d.group).includes(code2) && !JSON.stringify(lies('groups', 'g:' + gid)).includes(code2));
  const beitrag = { action: 'add', id: gid, person: 'Tom', entries: KORB_KLEIN, lines: [{ name: 'Classic Burger', qty: 2 }], total: 16 };
  ok('Beitrag vor 11:00 angenommen', (await call(gruppe, beitrag)).s === 200);
  const g = lies('groups', 'g:' + gid); g.firmenMittag.schluss = new Date(Date.now() - 60000).toISOString(); schreib('groups', 'g:' + gid, g);
  r = await call(gruppe, beitrag);
  ok('Beitrag nach Annahmeschluss: 409 schluss', r.s === 409 && r.d.error === 'schluss');
  r = await call(gruppe, { action: 'create', host: 'Privat' });
  ok('Normale Gruppe bleibt wie bisher', r.s === 200 && !r.d.group.firmenMittag);

  console.log('\n' + (fehler ? '❌ ' + fehler + ' von ' + n + ' Prüfungen fehlgeschlagen' : '✅ Alle ' + n + ' Prüfungen grün'));
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.log('Absturz:', e && e.stack); process.exit(1); });
