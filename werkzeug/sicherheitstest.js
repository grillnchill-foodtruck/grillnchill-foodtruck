#!/usr/bin/env node
/**
 * werkzeug/sicherheitstest.js
 * ----------------------------------------------------------------------------
 * Prüft Anmeldung und Grundschutz gegen die echten Handler, mit einem
 * Blob-Speicher im Arbeitsspeicher und einem Test-Passwort:
 *
 *   node werkzeug/sicherheitstest.js
 *
 * Abgedeckt: Zwei-Faktor (lib/zweifaktor.js, team.js), Sitzungen
 * (lib/admin-sitzung.js), Bremse gegen Durchprobieren (lib/auth-guard.js,
 * 5 in 15 Minuten), Grundschutz je Endpunkt (lib/bremse.js), interne
 * Mail-Arten, Kundenkonto-Anmeldung, Bestellliste über den Schlüssel-Zeitstempel,
 * Team-Passwörter mit scrypt (lib/team-passwort.js). Seit November 2026
 * dazu: IPv6 je /64-Netz, Grenzen je Kennung (E-Mail, Telefon, Code,
 * Gastgeber) und die Notbremse je Endpunkt mit gedrosseltem Telegram-Hinweis.
 * Echte Mails gehen keine raus: fetch ist abgefangen.
 * ----------------------------------------------------------------------------
 */

const Module = require('module');
const path = require('path');
const crypto = require('crypto');

const F = path.join(__dirname, '..', 'netlify', 'functions');
const daten = new Map();
const lesen = [];
let stoerung = false;   // true: jeder Speicherzugriff scheitert (Störungsfall)
const store = (name) => ({
  async get(k, o) { if (stoerung) throw new Error('Speicher gestört'); lesen.push(name + '|' + k); const v = daten.get(name + '|' + k); return v === undefined ? null : (o && o.type === 'json' ? JSON.parse(v) : v); },
  async setJSON(k, v) { if (stoerung) throw new Error('Speicher gestört'); daten.set(name + '|' + k, JSON.stringify(v)); },
  async set(k, v) { daten.set(name + '|' + k, String(v)); },
  async delete(k) { daten.delete(name + '|' + k); },
  async list({ prefix } = {}) { return { blobs: [...daten.keys()].filter((k) => k.startsWith(name + '|' + (prefix || ''))).map((k) => ({ key: k.slice(name.length + 1) })) }; },
});
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) { if (r === '@netlify/blobs') return '@netlify/blobs'; return orig.call(this, r, ...a); };
require.cache['@netlify/blobs'] = { id: '@netlify/blobs', exports: { getStore: (o) => store(typeof o === 'string' ? o : o.name) }, loaded: true };
process.env.ADMIN_PASSWORD = 'kubi-test-passwort';
delete process.env.ZWEI_FAKTOR;
// Platzhalter, damit send-email bis zu den Prüfungen kommt. Nach außen geht
// nichts: fetch ist abgefangen und antwortet immer mit 503.
Object.assign(process.env, { BREVO_API_KEY: 'test-nicht-echt', BREVO_SENDER_EMAIL: 'test@example.com', OWNER_EMAIL: 'inhaber@example.com', STATUS_UPDATE_SECRET: 'test-status-geheim' });
delete process.env.TELEGRAM_BOT_TOKEN;
global.fetch = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });
const leise = console.warn; console.warn = () => {};
const leiseFehler = console.error; console.error = () => {};

const zf = require(F + '/lib/zweifaktor.js');
const sitzung = require(F + '/lib/admin-sitzung.js');
const bremse = require(F + '/lib/bremse.js');
const team = require(F + '/team.js');
const upload = require(F + '/geheim-upload.js');
const orders = require(F + '/orders-list.js');
const mail = require(F + '/send-email.js');
const kasse = require(F + '/sumup-checkout.js');
const gutschein = require(F + '/voucher-check.js');
const konto = require(F + '/account.js');
const laden = require(F + '/shop-status.js');
const gruppe = require(F + '/group-order.js');

let fehler = 0, n = 0;
const ok = (name, b) => { n++; console.log((b ? '✅ ' : '❌ ') + name); if (!b) fehler++; };
let ip = 1;
const ev = (body, eigeneIp, extra) => ({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': eigeneIp || ('10.0.0.' + ip), ...(extra || {}) }, body: JSON.stringify(body) });
const call = async (h, body, eigeneIp, extra) => { const r = await h.handler(ev(body, eigeneIp, extra)); let d = {}; try { d = JSON.parse(r.body); } catch (e) {} return { s: r.statusCode, d, h: r.headers || {} }; };
const codeJetzt = (geheim, d = 0) => zf.hotp(zf.base32lesen(geheim), zf.schrittVon(Date.now()) + d);
const guard = () => [...daten.keys()].filter((k) => k.startsWith('authguard|'));

(async () => {
  /* ---- Zwei-Faktor ------------------------------------------------------- */
  const k = Buffer.from('12345678901234567890');
  const v = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037']];
  ok('RFC-6238-Testwerte', v.every(([t, c]) => zf.hotp(k, Math.floor(t / 30), 8) === c));
  ok('Base32 hin und zurück', zf.base32lesen(zf.base32(k)).equals(k) && zf.base32(Buffer.from('foobar')) === 'MZXW6YTBOI');
  ok('Notfallcodes ohne verwechselbare Zeichen', zf.neueNotfallCodes().every((x) => /^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/.test(x)));

  let r = await call(team, { action: 'anmelden', password: 'kubi-test-passwort' });
  ok('Erste Anmeldung -> Einrichtung', r.s === 200 && r.d.schritt === 'einrichten' && /^[A-Z2-7]{32}$/.test(r.d.geheim));
  const geheim = r.d.geheim, einr = r.d.einrichtung;
  r = await call(team, { action: 'anmelden', password: 'kubi-test-passwort', einrichtung: einr, code: codeJetzt(geheim) });
  ok('Einrichtung mit richtigem Code -> Token + 8 Notfallcodes', r.s === 200 && /^gncs_/.test(r.d.token) && r.d.notfallCodes.length === 8);
  const tokenKubi = r.d.token, notfall = r.d.notfallCodes;
  ok('Token öffnet whoami', (await call(team, { action: 'whoami', password: tokenKubi })).s === 200);
  ok('Reines Passwort öffnet whoami nicht', (await call(team, { action: 'whoami', password: 'kubi-test-passwort' })).s === 401);
  ok('passwortAusSitzung(Passwort) liefert leer', (await sitzung.passwortAusSitzung('kubi-test-passwort')) === '');

  ip++;
  r = await call(team, { action: 'anmelden', password: 'kubi-test-passwort' });
  ok('Zweite Anmeldung -> Code', r.d.schritt === 'code');
  ok('Benutzter Code gilt kein zweites Mal', (await call(team, { action: 'anmelden', password: 'kubi-test-passwort', code: codeJetzt(geheim) })).s === 401);
  r = await call(team, { action: 'anmelden', password: 'kubi-test-passwort', code: codeJetzt(geheim, 1), merken: true });
  ok('Nächster Code + merken -> 30 Tage', r.s === 200 && (new Date(r.d.exp) - Date.now()) > 29 * 864e5);
  r = await call(team, { action: 'anmelden', password: 'kubi-test-passwort', code: notfall[0].toUpperCase() });
  ok('Notfallcode -> ok, noch 7, Sitzung 12 h', r.s === 200 && r.d.notfallRest === 7 && (new Date(r.d.exp) - Date.now()) < 13 * 36e5);
  ok('Notfallcode gilt nur einmal', (await call(team, { action: 'anmelden', password: 'kubi-test-passwort', code: notfall[0] })).s === 401);

  const alt = await sitzung.erstelle('kubi-test-passwort', { role: 'superadmin', name: 'Kubi' });
  ip++;
  const vorher = guard().length;
  ok('Alte Sitzung ohne Code -> 401, zählt nicht als Fehlversuch', (await call(team, { action: 'whoami', password: alt.token })).s === 401 && guard().length === vorher);

  /* ---- Bremse gegen Durchprobieren: 5 in 15 Minuten ------------------------ */
  for (let i = 0; i < 5; i++) await call(team, { action: 'anmelden', password: 'falsch-' + i }, '10.20.0.1');
  r = await call(team, { action: 'anmelden', password: 'kubi-test-passwort' }, '10.20.0.1');
  ok('Nach 5 falschen Passwörtern: Anschluss 15 Minuten gesperrt (429)', r.s === 429 && Number(r.h['Retry-After']) > 800);
  for (let i = 0; i < 9; i++) await call(team, { action: 'whoami', password: 'kubi-test-passwort' }, '10.20.0.2');
  ok('Richtiges Passwort ohne Code (alter Tab) sperrt nicht', (await call(team, { action: 'whoami', password: tokenKubi }, '10.20.0.2')).s === 200);
  for (let i = 0; i < 5; i++) await call(team, { action: 'anmelden', password: 'kubi-test-passwort', code: '123456' }, '172.16.0.' + i);
  ok('Nach 5 falschen Codes: Konto gesperrt, auch mit richtigem Code', (await call(team, { action: 'anmelden', password: 'kubi-test-passwort', code: codeJetzt(geheim, 1) }, '172.16.1.1')).s === 429);
  const rec = JSON.parse(daten.get('team|zf:superadmin')); rec.gesperrtBis = null; rec.fehl = 0; rec.letzterSchritt = zf.schrittVon(Date.now()) - 2; daten.set('team|zf:superadmin', JSON.stringify(rec));

  /* ---- Mitarbeiter --------------------------------------------------------- */
  ok('Mitarbeiter-Passwort unter 10 Zeichen abgelehnt', (await call(team, { action: 'add', password: tokenKubi, name: 'Kurz', staffPassword: 'kurz-123' })).s === 400);
  ok('Mitarbeiter anlegen', (await call(team, { action: 'add', password: tokenKubi, name: 'Kutluay Test', staffPassword: 'glut-sesam-truck-42' })).s === 200);
  ip++;
  r = await call(team, { action: 'anmelden', password: 'glut-sesam-truck-42' });
  r = await call(team, { action: 'anmelden', password: 'glut-sesam-truck-42', einrichtung: r.d.einrichtung, code: codeJetzt(r.d.geheim) });
  const tokenStaff = r.d.token;
  ok('Mitarbeiter eingerichtet, Rolle staff', r.s === 200 && r.d.role === 'staff');
  ok('Mitarbeiter darf andere nicht zurücksetzen', (await call(team, { action: 'zfzuruecksetzen', password: tokenStaff, name: 'Kutluay Test' })).s === 403);
  ok('Admin setzt Mitarbeiter zurück', (await call(team, { action: 'zfzuruecksetzen', password: tokenKubi, name: 'Kutluay Test' })).s === 200);

  /* ---- Geheimnis-Upload ---------------------------------------------------- */
  const pem = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----';
  ok('Upload ohne Code -> 401', (await call(upload, { password: 'kubi-test-passwort', name: 'apple-apns-key', wert: pem }, '10.9.9.1')).d.error === 'code_noetig');
  ok('Upload mit Code -> 200', (await call(upload, { password: 'kubi-test-passwort', code: codeJetzt(geheim), name: 'apple-apns-key', wert: pem }, '10.9.9.1')).s === 200);

  /* ---- Bestellliste: Sitzung im Header, alte Bestellungen ungelesen -------- */
  const jetzt = Date.now();
  daten.set('orders|o:GNC-' + (jetzt - 60 * 864e5), JSON.stringify({ status: 'completed', createdAt: new Date(jetzt - 60 * 864e5).toISOString(), order: { reference: 'alt' } }));
  daten.set('orders|o:GNC-' + (jetzt - 36e5), JSON.stringify({ status: 'completed', createdAt: new Date(jetzt - 36e5).toISOString(), order: { reference: 'neu' } }));
  lesen.length = 0;
  let o = await orders.handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': '10.30.0.1', 'x-gnc-sitzung': tokenKubi }, queryStringParameters: { days: '30' } });
  const liste = JSON.parse(o.body).orders || [];
  ok('Bestellliste mit Sitzung im Header -> 200', o.statusCode === 200);
  ok('… liefert nur die neue Bestellung', liste.length === 1 && liste[0].reference === 'neu');
  ok('… und liest die 60 Tage alte gar nicht erst', !lesen.some((x) => x === 'orders|o:GNC-' + (jetzt - 60 * 864e5)));
  o = await orders.handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': '10.30.0.2' }, queryStringParameters: { days: '30', password: 'kubi-test-passwort' } });
  ok('Bestellliste mit reinem Passwort in der Adresse -> 401', o.statusCode === 401);

  /* ---- Grundschutz (lib/bremse.js) ----------------------------------------- */
  const roh = (body, eigeneIp, extra, methode) => ({ httpMethod: methode || 'POST', headers: { 'x-nf-client-connection-ip': eigeneIp, ...(extra || {}) }, body });
  let erg = [];
  for (let i = 0; i < 4; i++) erg.push(await bremse.schutz(roh('{}', '10.40.0.1'), { name: 'probe', max: 3 }));
  ok('Bremse: 3 durch, die 4. bekommt 429 mit Retry-After', erg.slice(0, 3).every((x) => x === null) && erg[3] && erg[3].statusCode === 429 && erg[3].headers['Retry-After']);
  ok('Bremse: andere Adresse nicht betroffen', (await bremse.schutz(roh('{}', '10.40.0.2'), { name: 'probe', max: 3 })) === null);
  ok('Bremse: Vorab-Anfrage (OPTIONS) zählt nicht', (await bremse.schutz(roh('', '10.40.0.1', {}, 'OPTIONS'), { name: 'probe', max: 3 })) === null);
  ok('Bremse: interne Aufrufe zählen nicht', (await bremse.schutz(roh('{}', '10.40.0.1', bremse.internHeader()), { name: 'probe', max: 3 })) === null);
  ok('Bremse: falsches internes Kennzeichen hilft nicht', (await bremse.schutz(roh('{}', '10.40.0.1', { 'x-gnc-intern': 'f'.repeat(64) }), { name: 'probe', max: 3 })).statusCode === 429);
  ok('Bremse: zu große Anfrage -> 413', (await bremse.schutz(roh('x'.repeat(40 * 1024), '10.40.0.3'), { name: 'gross', max: 99, maxKB: 32 })).statusCode === 413);
  const s1 = bremse.saeubern({ name: 'Max\u0000‮ Muster', note: 'a'.repeat(5000), liste: Array(500).fill(1), ['__proto__']: { boese: 1 }, zahl: Infinity, zeile: 'a\nb' }, { maxText: 2000 });
  ok('Säubern: Steuerzeichen raus, Text gekürzt, Liste begrenzt', s1.name === 'Max Muster' && s1.note.length === 2000 && s1.liste.length === 200 && s1.zahl === 0 && s1.zeile === 'a\nb');
  ok('Säubern: __proto__ wird verworfen', !Object.prototype.hasOwnProperty.call(s1, '__proto__') && ({}).boese === undefined);

  /* ---- Mail-Arten nur intern, Statusseiten ohne Interna -------------------- */
  ok('Gutschein-Mail von außen -> 403', (await call(mail, { type: 'giftcard', gift: { email: 'opfer@example.com', code: 'FAKE' } }, '10.50.0.1')).s === 403);
  ok('Status-Mail von außen -> 403', (await call(mail, { type: 'status_update', status: 'ready', order: { email: 'opfer@example.com' } }, '10.50.0.1')).s === 403);
  ok('Gutschein-Mail intern -> nicht abgewiesen', (await call(mail, { type: 'giftcard', gift: { email: 'kunde@example.com', code: 'ECHT' } }, '10.50.0.1', bremse.internHeader())).s !== 403);
  const g1 = await mail.handler({ httpMethod: 'GET', headers: {} });
  ok('send-email GET verrät keine Adressen mehr', g1.statusCode === 200 && !/@/.test(g1.body));
  const g2 = await kasse.handler({ httpMethod: 'GET', headers: {} });
  ok('sumup-checkout GET zeigt keine Einrichtung mehr', g2.statusCode === 200 && g2.body.length < 40);
  let letzte;
  for (let i = 0; i < 41; i++) letzte = await call(gutschein, { code: 'RATEN' + i }, '10.60.0.1');
  ok('Gutschein prüfen: nach 40 Versuchen in 10 Minuten -> 429', letzte.s === 429);

  /* ---- Kundenkonto ---------------------------------------------------------- */
  for (let i = 0; i < 5; i++) {
    const email = 'kunde' + i + '@example.com';
    await call(konto, { action: 'request_code', email }, '10.70.0.' + i);
    await call(konto, { action: 'verify', email, code: '000000' }, '10.70.1.1');
  }
  ok('Kundenkonto: nach 5 falschen Codes von einer Adresse -> 429', (await call(konto, { action: 'verify', email: 'kunde0@example.com', code: '111111' }, '10.70.1.1')).s === 429);
  for (let i = 0; i < 10; i++) await call(konto, { action: 'request_code', email: 'serie' + i + '@example.com' }, '10.70.2.1');
  ok('Kundenkonto: nach 10 Code-Mails von einer Adresse in 15 Minuten -> 429', (await call(konto, { action: 'request_code', email: 'serie99@example.com' }, '10.70.2.1')).s === 429);

  /* ---- Ladenstatus im CDN-Zwischenspeicher ----------------------------------- */
  const ls = await laden.handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': '10.80.0.1' } });
  ok('Ladenstatus: CDN darf 10 s zwischenspeichern, Browser nicht', /s-maxage=10/.test(ls.headers['Netlify-CDN-Cache-Control'] || '') && /no-store/.test(ls.headers['Cache-Control'] || ''));

  /* ---- Team-Passwörter (lib/team-passwort.js) ------------------------------- */
  const tp = require(F + '/lib/team-passwort.js');
  const h1 = await tp.hashen('mitarbeiter-passwort-1');
  ok('scrypt-Hash mit Salz, zweimal verschieden', /^s1\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{44}$/.test(h1) && h1 !== await tp.hashen('mitarbeiter-passwort-1'));
  ok('scrypt-Hash: richtiges Passwort passt, falsches nicht', (await tp.stimmt('mitarbeiter-passwort-1', h1)) && !(await tp.stimmt('mitarbeiter-passwort-2', h1)));
  // Eintrag wie vor November 2026: sha256 ohne Salz
  daten.set('team|u:altfall', JSON.stringify({ name: 'Altfall', role: 'staff', pwHash: crypto.createHash('sha256').update('altes-passwort-123').digest('hex') }));
  process.env.ZWEI_FAKTOR = 'aus';
  r = await call(team, { action: 'whoami', password: 'altes-passwort-123' }, '10.90.0.1');
  ok('Alter sha256-Eintrag meldet sich an und wird dabei auf scrypt umgestellt', r.s === 200 && r.d.name === 'Altfall' && /^s1\$/.test(JSON.parse(daten.get('team|u:altfall')).pwHash));
  ok('Nach der Umstellung klappt die Anmeldung weiter', (await call(team, { action: 'whoami', password: 'altes-passwort-123' }, '10.90.0.1')).s === 200);
  ok('Andere Function (Bestellliste) erkennt den scrypt-Zugang', (await orders.handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': '10.90.0.2', 'x-gnc-sitzung': 'altes-passwort-123' }, queryStringParameters: {} })).statusCode === 200);
  ok('Falsches Passwort bleibt draußen', (await call(team, { action: 'whoami', password: 'altes-passwort-124' }, '10.90.0.3')).s === 401);
  delete process.env.ZWEI_FAKTOR;
  ok('Passwort eines scrypt-Zugangs lässt sich nicht doppelt vergeben', (await call(team, { action: 'add', password: tokenKubi, name: 'Neu Test', staffPassword: 'altes-passwort-123' })).s === 409);
  r = await call(team, { action: 'add', password: tokenKubi, name: 'Neu Test', staffPassword: 'ganz-neues-passwort-9' });
  ok('Neuer Zugang wird mit scrypt gespeichert', r.s === 200 && /^s1\$/.test(JSON.parse(daten.get('team|u:' + zf.slug('Neu Test'))).pwHash));

  /* ---- IPv6 je /64-Netz (lib/bremse.js, lib/auth-guard.js) ------------------- */
  ok('IPv6: Adressen im selben /64 ergeben dieselbe Kennung',
    bremse.ipNormalisieren('2a02:8108:1:2:aaaa::1') === '2a02:8108:1:2::/64'
    && bremse.ipNormalisieren('2A02:8108:0001:0002:ffff:1:2:3') === '2a02:8108:1:2::/64'
    && bremse.ipNormalisieren('[2a02:8108:1:2::9]') === '2a02:8108:1:2::/64');
  ok('IPv6: anderes /64 ist ein anderer Absender', bremse.ipNormalisieren('2a02:8108:1:3::1') !== bremse.ipNormalisieren('2a02:8108:1:2::1'));
  ok('IPv4 bleibt unverändert, auch in IPv6-Schreibweise (::ffff:)',
    bremse.ipNormalisieren('10.1.2.3') === '10.1.2.3' && bremse.ipNormalisieren('::ffff:10.1.2.3') === '10.1.2.3');
  ok('IPv4: gleicher Hash wie vor der Umstellung (laufende Sperren gelten weiter)',
    bremse.absender({ headers: { 'x-nf-client-connection-ip': '10.1.2.3' } }) === crypto.createHash('sha256').update('10.1.2.3').digest('hex').slice(0, 32));
  erg = [];
  for (let i = 1; i <= 4; i++) erg.push(await bremse.schutz(roh('{}', '2a02:8108:77:1::' + i.toString(16)), { name: 'probe6', max: 3 }));
  ok('Bremse: wer im eigenen /64 rotiert, zählt als einer (4. Adresse -> 429)', erg.slice(0, 3).every((x) => x === null) && erg[3] && erg[3].statusCode === 429);
  ok('Bremse: Nachbar-/64 ist nicht betroffen', (await bremse.schutz(roh('{}', '2a02:8108:77:2::1'), { name: 'probe6', max: 3 })) === null);
  for (let i = 1; i <= 5; i++) await call(team, { action: 'anmelden', password: 'falsch6-' + i }, '2a02:8108:99:1::' + i);
  r = await call(team, { action: 'anmelden', password: 'kubi-test-passwort' }, '2a02:8108:99:1:abcd::7');
  ok('Anmeldung: 5 falsche Passwörter aus einem /64 (5 Adressen) sperren das ganze /64', r.s === 429);

  /* ---- Grenzen je Kennung --------------------------------------------------- */
  const G = bremse.GRENZEN;
  const evIp = (n) => ({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '10.110.' + Math.floor(n / 250) + '.' + (n % 250 + 1) }, body: '{}' });
  ok('Kennung: E-Mail vereinheitlicht (Großschreibung, Gmail-Punkte, +Zusatz)',
    bremse.kennungVereinheitlichen('mail', 'Max.Muster+gnc@GoogleMail.com') === 'maxmuster@gmail.com'
    && bremse.kennungVereinheitlichen('mail', 'kein-at') === '');
  ok('Kennung: Telefon vereinheitlicht (+49, 0049, 0, Klammern, unter 8 Ziffern leer)',
    ['+49 170 1234567', '0049 (170) 123-4567', '0170/1234567', '+49 (0)170 1234567'].every((x) => bremse.kennungVereinheitlichen('tel', x) === '491701234567')
    && bremse.kennungVereinheitlichen('tel', '0521 12') === '');
  let gr = [];
  const maxCode = G['konto-code'].mail[0];
  for (let i = 0; i <= maxCode; i++) gr.push(await bremse.grenzen(evIp(i), 'konto-code', { mail: i % 2 ? 'Opfer@Example.com' : 'opfer+' + i + '@example.com' }));
  ok('Login-Code je E-Mail: ' + maxCode + ' von verschiedenen IPs durch, der nächste 429 (auch mit +Zusatz)',
    gr.slice(0, maxCode).every((x) => x === null) && gr[maxCode] && gr[maxCode].statusCode === 429);
  ok('Login-Code: andere E-Mail nicht betroffen', (await bremse.grenzen(evIp(99), 'konto-code', { mail: 'nachbar@example.com' })) === null);
  ok('Kennung: interne Aufrufe zählen nicht', (await bremse.grenzen({ ...evIp(98), headers: { ...evIp(98).headers, ...bremse.internHeader() } }, 'konto-code', { mail: 'opfer@example.com' })) === null);
  ok('Kennung: der Speicher hält nur Hashes, keine Adresse', ![...daten.keys()].some((k) => k.startsWith('bremse|') && /opfer|example/i.test(k + daten.get(k))));

  // Online-Kasse echt: gleiche Telefonnummer, wechselnde E-Mails und IPs
  Object.assign(process.env, { SUMUP_API_KEY: 'sup_sk_test_nicht_echt', SUMUP_MERCHANT_CODE: 'MTEST' });
  const maxKasse = G.kasse.tel[0];
  gr = [];
  for (let i = 0; i <= maxKasse; i++) {
    const tel = i % 2 ? '0170 5550001' : '+49 (0) 170 555 0001';
    gr.push(await call(kasse, { amount: 12, order: { email: 'k' + i + '@example.com', phone: tel, total: 12 } }, '10.120.0.' + (i + 1)));
  }
  ok('Kasse je Telefon: ' + maxKasse + ' Versuche durch, der nächste 429, egal wie die Nummer geschrieben ist',
    gr.slice(0, maxKasse).every((x) => x.s !== 429) && gr[maxKasse].s === 429);
  gr = [];
  for (let i = 0; i <= G.kasse.mail[0]; i++) gr.push(await call(kasse, { amount: 12, order: { email: 'Stamm.Kunde@gmail.com', total: 12 } }, '10.121.0.' + (i + 1)));
  ok('Kasse je E-Mail: ' + G.kasse.mail[0] + ' durch, der nächste 429', gr.slice(0, -1).every((x) => x.s !== 429) && gr[gr.length - 1].s === 429);
  ok('Kasse: Rückzieher (cancelOnly) zählt nicht', (await call(kasse, { cancelOnly: true, order: { email: 'Stamm.Kunde@gmail.com' } }, '10.121.1.1')).s === 200);

  // Gutscheinprüfung: je E-Mail, und je Code
  gr = [];
  for (let i = 0; i <= G.gutschein.mail[0]; i++) gr.push(await call(gutschein, { code: 'PROBE' + i, email: 'sammler@example.com' }, '10.130.' + Math.floor(i / 200) + '.' + (i % 200 + 1)));
  ok('Gutschein je E-Mail: ' + G.gutschein.mail[0] + ' in 10 Min durch, der nächste 429', gr.slice(0, -1).every((x) => x.s === 200) && gr[gr.length - 1].s === 429);
  for (let i = 0; i < G.gutschein.code[0]; i++) await bremse.schutzKennung(evIp(i), { name: 'gutschein', art: 'code', wert: 'LECK10', max: G.gutschein.code[0], fensterMin: G.gutschein.code[1] });
  ok('Gutschein je Code: ein einzelner Code ist nach ' + G.gutschein.code[0] + ' Prüfungen gesperrt', (await call(gutschein, { code: 'leck10' }, '10.131.0.1')).s === 429);
  ok('Gutschein je Code: andere Codes laufen weiter', (await call(gutschein, { code: 'ANDERS10' }, '10.131.0.2')).s === 200);

  // Gruppenbestellung anlegen je Gastgeber
  gr = [];
  for (let i = 0; i <= G['gruppe-neu'].gastgeber[0]; i++) gr.push(await call(gruppe, { action: 'create', host: i % 2 ? 'Büro  Nord' : 'büro nord' }, '10.140.0.' + (i + 1)));
  ok('Gruppe je Gastgeber: ' + G['gruppe-neu'].gastgeber[0] + ' angelegt, die nächste 429', gr.slice(0, -1).every((x) => x.s === 200) && gr[gr.length - 1].s === 429);
  ok('Gruppe: anderer Gastgeber legt weiter an', (await call(gruppe, { action: 'create', host: 'Werkstatt' }, '10.140.1.1')).s === 200);

  // Catering-Anfrage je E-Mail (send-email, Mailversand ist abgefangen)
  gr = [];
  for (let i = 0; i <= G.catering.mail[0]; i++) gr.push(await call(mail, { type: 'catering_request', catering: { name: 'Test', email: 'firma@example.com' } }, '10.150.0.' + (i + 1)));
  ok('Catering je E-Mail: ' + G.catering.mail[0] + ' Anfragen, die nächste 429', gr.slice(0, -1).every((x) => x.s === 200) && gr[gr.length - 1].s === 429);

  // Bestellweg (send-email) je E-Mail
  gr = [];
  for (let i = 0; i <= G.bestellung.mail[0]; i++) gr.push(await call(mail, { type: 'owner_notification', order: { reference: 'GNC-' + (1e12 + i), email: 'viel@example.com', name: 'T', items: [], total: 10 } }, '10.160.0.' + (i + 1)));
  ok('Bestellweg je E-Mail: ' + G.bestellung.mail[0] + ' durch, der nächste 429', gr.slice(0, -1).every((x) => x.s !== 429) && gr[gr.length - 1].s === 429);
  ok('Bestellweg: interner Aufruf (SumUp-Webhook) kommt trotzdem durch',
    (await call(mail, { type: 'owner_notification', order: { reference: 'GNC-1999', email: 'viel@example.com', name: 'T', items: [], total: 10 } }, '10.160.1.1', bremse.internHeader())).s !== 429);

  /* ---- Notbremse über alle Absender mit Telegram-Drossel -------------------- */
  const telegramm = [];
  const fetchVorher = global.fetch;
  global.fetch = async (url, o) => {
    if (String(url).includes('api.telegram.org')) telegramm.push(JSON.parse(o.body).text);
    return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
  };
  Object.assign(process.env, { TELEGRAM_BOT_TOKEN: 'test-bot', TELEGRAM_CHAT_ID: '1' });
  const notbremse = () => telegramm.filter((x) => /Notbremse/.test(x));
  const maxCat = G.catering.gesamt[0];
  for (let i = 0; i < maxCat; i++) await call(mail, { type: 'catering_request', catering: { name: 'V', email: 'verteilt' + i + '@example.com' } }, '10.170.' + Math.floor(i / 200) + '.' + (i % 200 + 1));
  r = await call(mail, { type: 'catering_request', catering: { name: 'Echt', email: 'echt@example.com' } }, '10.171.0.1');
  ok('Notbremse: nach ' + maxCat + ' Catering-Anfragen von ' + maxCat + ' Absendern ist Schluss (429 mit Retry-After)', r.s === 429 && Number(r.h['Retry-After']) > 0);
  ok('Notbremse: Kubi bekommt genau eine Telegram-Nachricht', notbremse().length === 1 && /Catering-Anfragen/.test(notbremse()[0]) && !/[–—!]/.test(notbremse()[0]));
  for (let i = 0; i < 5; i++) await call(mail, { type: 'catering_request', catering: { name: 'V', email: 'mehr' + i + '@example.com' } }, '10.172.0.' + (i + 1));
  ok('Notbremse: weitere Abweisungen schicken keine zweite Nachricht', notbremse().length === 1);
  ok('Notbremse: interne Aufrufe laufen weiter', (await bremse.gesamtGrenze({ httpMethod: 'POST', headers: bremse.internHeader() }, { name: 'catering', max: maxCat, fensterMin: 10 })) === null);
  ok('Notbremse: andere Endpunkte nicht betroffen', (await call(gruppe, { action: 'create', host: 'Nach der Bremse' }, '10.173.0.1')).s === 200);
  // 61 Minuten später: Fenster abgelaufen, neue Welle, neuer Hinweis
  const echtJetzt = Date.now;
  Date.now = () => echtJetzt() + 61 * 60 * 1000;
  for (let i = 0; i <= maxCat; i++) await bremse.gesamtGrenze(evIp(500 + i), { name: 'catering', max: maxCat, fensterMin: 10 });
  ok('Notbremse: nach einer Stunde darf wieder ein Hinweis kommen', notbremse().length === 2);
  Date.now = echtJetzt;
  delete process.env.TELEGRAM_BOT_TOKEN; delete process.env.TELEGRAM_CHAT_ID;
  global.fetch = fetchVorher;

  /* ---- Störungsfall: durchlassen -------------------------------------------- */
  stoerung = true;
  ok('Störung: Bremse, Kennung und Notbremse lassen durch',
    (await bremse.schutz(roh('{}', '10.180.0.1'), { name: 'probe', max: 1 })) === null
    && (await bremse.grenzen(evIp(700), 'kasse', { mail: 'x@example.com', tel: '01701234567' })) === null
    && (await bremse.gesamtGrenze(evIp(701), { name: 'kasse', max: 1 })) === null);
  stoerung = false;

  /* ---- Notschalter ---------------------------------------------------------- */
  process.env.ZWEI_FAKTOR = 'aus';
  ok('ZWEI_FAKTOR=aus: Passwort allein öffnet wieder', (await call(team, { action: 'whoami', password: 'kubi-test-passwort' }, '10.8.8.8')).s === 200);
  delete process.env.ZWEI_FAKTOR;

  console.warn = leise; console.error = leiseFehler;
  console.log('\n' + (n - fehler) + ' von ' + n + (fehler ? ' – ' + fehler + ' FEHLER' : ' grün'));
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
