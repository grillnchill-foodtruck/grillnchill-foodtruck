#!/usr/bin/env node
/**
 * werkzeug/catering-angebot-test.js
 * ----------------------------------------------------------------------------
 * Catering-Angebot mit einem Klick, gegen die echten Handler:
 *
 *   node werkzeug/catering-angebot-test.js
 *
 * Blob-Speicher im Arbeitsspeicher (mit onlyIfNew wie @netlify/blobs),
 * fetch abgefangen: Brevo, Telegram und SumUp antworten aus dem Test, nach
 * außen geht nichts. Anmeldung über eine echte Sitzung mit Zwei-Faktor-Vermerk.
 *
 * Abgedeckt: Nummernvergabe (fortlaufend, gleichzeitig, verklemmter Zähler),
 * Token-Prüfung, Annahme nur einmal (auch gleichzeitig), Erinnerung genau
 * einmal nach 3 Tagen, Ablauf, Schalter "Anzahlung online" AUS verhindert die
 * Kasse, Zahlung über Webhook und Rückkehr, PDF ist ein gültiges PDF, Rechte,
 * Duplikat ersetzt Vorgänger, Status von Hand.
 * ----------------------------------------------------------------------------
 */

const Module = require('module');
const path = require('path');

const F = path.join(__dirname, '..', 'netlify', 'functions');
const daten = new Map();
const store = (name) => ({
  async get(k, o) { const v = daten.get(name + '|' + k); return v === undefined ? null : (o && o.type === 'json' ? JSON.parse(v) : v); },
  async setJSON(k, v, o) {
    // kurze Pause, damit gleichzeitige Aufrufe sich wirklich überholen können
    await new Promise((r) => setImmediate(r));
    if (o && o.onlyIfNew && daten.has(name + '|' + k)) return { modified: false };
    daten.set(name + '|' + k, JSON.stringify(v));
    return { modified: true, etag: 'x' };
  },
  async set(k, v) { daten.set(name + '|' + k, String(v)); },
  async delete(k) { daten.delete(name + '|' + k); },
  async list({ prefix } = {}) { return { blobs: [...daten.keys()].filter((k) => k.startsWith(name + '|' + (prefix || ''))).map((k) => ({ key: k.slice(name.length + 1) })) }; },
});
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) { if (r === '@netlify/blobs') return '@netlify/blobs'; return orig.call(this, r, ...a); };
require.cache['@netlify/blobs'] = { id: '@netlify/blobs', exports: { getStore: (o) => store(typeof o === 'string' ? o : o.name) }, loaded: true };

Object.assign(process.env, {
  ADMIN_PASSWORD: 'kubi-test-passwort',
  BREVO_API_KEY: 'test-nicht-echt', BREVO_SENDER_EMAIL: 'test@example.com', OWNER_EMAIL: 'inhaber@example.com',
  TELEGRAM_BOT_TOKEN: 'test-bot', TELEGRAM_CHAT_ID: '1',
  SUMUP_API_KEY: 'test-sumup', SUMUP_MERCHANT_CODE: 'MTEST',
  SITE_URL: 'https://test.example',
});
delete process.env.ZWEI_FAKTOR;
delete process.env.URL;

/* ---- fetch abfangen --------------------------------------------------------- */
const mails = [], telegramm = [], kassen = [];
const checkouts = new Map();
let brevoKaputt = false;
global.fetch = async (url, opt = {}) => {
  const u = String(url);
  const antwort = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (u.startsWith('https://api.brevo.com/')) {
    if (brevoKaputt) return antwort(500, { message: 'kaputt' });
    mails.push(JSON.parse(opt.body));
    return antwort(201, { messageId: 'm' + mails.length });
  }
  if (u.startsWith('https://api.telegram.org/')) { telegramm.push(JSON.parse(opt.body).text); return antwort(200, { ok: true }); }
  if (u === 'https://api.sumup.com/v0.1/checkouts' && opt.method === 'POST') {
    const b = JSON.parse(opt.body);
    const id = 'chk_' + (kassen.length + 1);
    kassen.push(b);
    checkouts.set(id, { id, status: 'PENDING', checkout_reference: b.checkout_reference, amount: b.amount, transactions: [] });
    return antwort(200, { id, hosted_checkout_url: 'https://checkout.sumup.example/' + id });
  }
  const m = /^https:\/\/api\.sumup\.com\/v0\.1\/checkouts\/([^/?]+)$/.exec(u);
  if (m) { const c = checkouts.get(decodeURIComponent(m[1])); return c ? antwort(200, c) : antwort(404, {}); }
  return antwort(503, {});
};
const leise = console.error; console.error = () => {};
console.log = ((log) => (...a) => { if (!String(a[0]).startsWith('catering-angebot-taeglich')) log(...a); })(console.log);

const sitzung = require(F + '/lib/admin-sitzung.js');
const { hashen } = require(F + '/lib/team-passwort.js');
const L = require(F + '/lib/catering-angebot.js');
const admin = require(F + '/catering-angebot.js');
const kunde = require(F + '/angebot.js');
const webhook = require(F + '/sumup-webhook.js');
const taeglich = require(F + '/catering-angebot-taeglich.js');

let fehler = 0, n = 0;
const ok = (name, b, info) => { n++; console.log((b ? '✅ ' : '❌ ') + name + (b || info === undefined ? '' : '\n   ' + JSON.stringify(info))); if (!b) fehler++; };
let ipZahl = 1;
const neueIp = () => '10.77.' + Math.floor(ipZahl / 250) + '.' + (ipZahl++ % 250);
const antwort = (r) => { let d = {}; try { d = JSON.parse(r.body); } catch (e) {} return { s: r.statusCode, d, r }; };

let TOKEN = '';
const adminPost = async (body, tok) => antwort(await admin.handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '10.1.1.1' }, body: JSON.stringify({ password: tok || TOKEN, ...body }) }));
const adminGet = async (q, tok) => antwort(await admin.handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': '10.1.1.1', 'x-gnc-sitzung': tok || TOKEN }, queryStringParameters: q }));
const kundeGet = async (q) => antwort(await kunde.handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': neueIp() }, queryStringParameters: q }));
const kundePost = async (body, ip) => antwort(await kunde.handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': ip || neueIp() }, body: JSON.stringify(body) }));
const angebotRoh = (id) => JSON.parse(daten.get('catering|angebot:' + id));
const tokenVon = (id) => angebotRoh(id).token;
const TAG = 864e5;

(async () => {
  const jetzt = new Date();
  const inTagen = (t) => L.plusTage(L.heute(jetzt), t);
  const jahr = L.heute(jetzt).slice(0, 4);

  /* ---- Anmeldung ----------------------------------------------------------- */
  TOKEN = (await sitzung.erstelle('kubi-test-passwort', { role: 'superadmin', name: 'Kubi' }, { zweiFaktor: true })).token;
  daten.set('team|u:mia', JSON.stringify({ name: 'Mia', role: 'staff', pwHash: await hashen('mia-truck-passwort-1') }));
  const tokenStaff = (await sitzung.erstelle('mia-truck-passwort-1', { role: 'staff', name: 'Mia' }, { zweiFaktor: true })).token;

  ok('Ohne Anmeldung -> 401', (await adminGet({ liste: '1' }, 'falsch')).s === 401);
  ok('Mitarbeiter -> 403 (keine Preise für Staff)', (await adminGet({ liste: '1' }, tokenStaff)).s === 403);
  ok('Reines Passwort ohne Zwei-Faktor-Sitzung -> 401', (await adminGet({ liste: '1' }, 'kubi-test-passwort')).s === 401);
  let r = await adminGet({ liste: '1' });
  ok('Admin-Liste leer, Standardpreise 21/26/32, Anzahlung 30 %, Schalter AUS',
    r.s === 200 && r.d.angebote.length === 0 && r.d.einstellungen.pakete.classic.preis === 21 && r.d.einstellungen.pakete.gnc.preis === 26
    && r.d.einstellungen.pakete.flat.preis === 32 && r.d.einstellungen.anzahlungProzent === 30 && r.d.einstellungen.gueltigTage === 14
    && r.d.einstellungen.anzahlungOnline === false, r.d);

  /* ---- Entwurf aus Anfrage ------------------------------------------------- */
  const evDatum = inTagen(60);
  daten.set('catering|c:1700000000000-abc123', JSON.stringify({
    name: 'Ayşe Yılmaz', email: 'Ayse@Example.com', phone: '0151 1234567', date: evDatum, guests: '50 – 100',
    location: 'Bielefeld-Sennestadt', package: "Grill'n Chill (26 €/P)", msg: 'Hochzeit, 10 vegan', contactPref: 'E-Mail',
    receivedAt: jetzt.toISOString(), emailSent: true, done: false,
  }));
  r = await adminPost({ action: 'neu', anfrage: 'c:1700000000000-abc123' });
  const a1 = r.d.angebot;
  const wt = new Date(evDatum + 'T12:00:00Z').getUTCDay();
  ok('Entwurf vorbefüllt: Kontakt, Datum, Ort, Paket gnc, 50 Personen',
    r.s === 200 && a1.status === 'entwurf' && a1.kunde.email === 'ayse@example.com' && a1.event.datum === evDatum
    && a1.event.ort === 'Bielefeld-Sennestadt' && a1.event.paket === 'gnc' && a1.event.personen === 50, a1);
  ok('Positionen: Paket 50 x 26 €, Event-Pauschale nach Wochentag, Anfahrt mit 0 km',
    a1.zeilen[0].menge === 50 && a1.zeilen[0].einzel === 26 && a1.zeilen[0].standard
    && a1.zeilen[1].einzel === (wt === 5 || wt === 6 ? 450 : 300) && a1.zeilen[2].art === 'anfahrt' && a1.zeilen[2].menge === 0, a1.zeilen);
  ok('Nummer A-' + jahr + '-0001, Token nicht im Admin-Datensatz', a1.nummer === 'A-' + jahr + '-0001' && !('token' in a1) && a1.link === null, a1);
  ok('Anfrage-Info fürs Admin (Gäste, Nachricht)', a1.anfrageInfo && a1.anfrageInfo.gaeste === '50 – 100' && a1.anfrageInfo.nachricht === 'Hochzeit, 10 vegan');

  /* ---- Nummernvergabe ------------------------------------------------------ */
  r = await adminPost({ action: 'neu' });
  ok('Zweites Angebot: A-' + jahr + '-0002', r.d.angebot.nummer === 'A-' + jahr + '-0002');
  const gleichzeitig = await Promise.all([1, 2, 3, 4, 5].map(() => L.anlegen({ wer: 'Test' })));
  const nummern = gleichzeitig.map((a) => a.nummer).sort();
  ok('5 gleichzeitig angelegt: 5 verschiedene, lückenlose Nummern 0003 bis 0007',
    new Set(nummern).size === 5 && nummern[0] === 'A-' + jahr + '-0003' && nummern[4] === 'A-' + jahr + '-0007', nummern);
  daten.set('catering|angebot-zaehler:' + jahr, JSON.stringify({ n: 3 }));   // Zähler hängt hinterher
  const nachHaenger = await L.anlegen({ wer: 'Test' });
  ok('Verklemmter Zähler: überspringt vergebene Nummern (0008)', nachHaenger.nummer === 'A-' + jahr + '-0008', nachHaenger.nummer);
  const z = L.heute(new Date(jetzt.getFullYear() + 1, 1, 1));
  ok('Neues Jahr beginnt bei 0001', (await L.naechsteNummer(L.store(), 'ffffffffffff', new Date(z + 'T12:00:00Z'))) === 'A-' + z.slice(0, 4) + '-0001');
  for (const a of gleichzeitig.concat([nachHaenger])) ok('Entwurf ' + a.nummer + ' löschen', (await adminPost({ action: 'loeschen', id: a.id })).s === 200);

  /* ---- Rechnen und Speichern ----------------------------------------------- */
  const roh = {
    kunde: { name: 'Ayşe Yılmaz', firma: '', email: 'ayse@example.com', telefon: '0151 1234567' },
    event: { datum: evDatum, zeit: '18 bis 21 Uhr', ort: 'Bielefeld-Sennestadt', personen: 60, paket: 'gnc' },
    zeilen: [
      { art: 'paket', paket: 'gnc', text: a1.zeilen[0].text, menge: 60, einzel: 26 },
      { art: 'pauschale', text: a1.zeilen[1].text, menge: 1, einzel: 450 },
      { art: 'anfahrt', text: a1.zeilen[2].text, menge: 12.5, einzel: 1 },
      { art: 'extra', text: 'Vegane Patties', menge: 10, einzel: 2.5 },
      { art: 'extra', text: '<script>x</script>', menge: 1, einzel: 0 },
    ],
    rabatt: { art: 'prozent', wert: 5 },
    gueltigTage: 14, anzahlungProzent: 30, hinweis: 'Stehtische bringen wir mit.',
  };
  r = await adminPost({ action: 'speichern', id: a1.id, angebot: roh });
  const g = r.d.angebot;
  // 60*26=1560 + 450 + 12,50 + 25 = 2047,50; 5 % = 102,38 (102,375 kaufmännisch); 1945,12; 30 % = 583,54 (583,536)
  ok('Rechnen in Cent: Summe 2047,50, Rabatt 102,38, Gesamt 1945,12, Anzahlung 583,54, Rest 1361,58',
    g.summe === 2047.5 && g.rabattBetrag === 102.38 && g.gesamt === 1945.12 && g.anzahlung === 583.54 && g.rest === 1361.58, g);
  ok('Selbst geschriebener Text gilt nicht als Standard, Vorgabetext schon', g.zeilen[0].standard === true && g.zeilen[3].standard === false);
  ok('Rabatt als Betrag wird auf die Summe gedeckelt',
    L.rechnen({ zeilen: [{ menge: 1, einzel: 100 }], rabatt: { art: 'betrag', wert: 500 }, anzahlungProzent: 30 }).gesamt === 0);

  /* ---- PDF ----------------------------------------------------------------- */
  r = await adminGet({ pdf: a1.id });
  const pdf = Buffer.from(r.r.body || '', 'base64');
  ok('Admin-PDF-Vorschau: 200, application/pdf, beginnt mit %PDF-, endet mit %%EOF',
    r.s === 200 && r.r.isBase64Encoded && r.r.headers['Content-Type'] === 'application/pdf'
    && pdf.slice(0, 5).toString() === '%PDF-' && pdf.slice(-8).toString().includes('%%EOF'), { s: r.s, kopf: pdf.slice(0, 8).toString() });
  ok('PDF hat Seiten und Nummer im Titel', /\/Type \/Page\b/.test(pdf.toString('latin1')) && pdf.toString('latin1').includes('A-' + jahr + '-0001'));
  ok('Kunde sieht Entwurf nicht (PDF und Ansicht -> 404)',
    (await kundeGet({ id: a1.id, t: tokenVon(a1.id), pdf: '1' })).s === 404 && (await kundeGet({ id: a1.id, t: tokenVon(a1.id) })).s === 404);

  /* ---- Senden -------------------------------------------------------------- */
  brevoKaputt = true;
  r = await adminPost({ action: 'senden', id: a1.id });
  ok('Mail scheitert -> 502, Angebot bleibt Entwurf', r.s === 502 && angebotRoh(a1.id).status === 'entwurf', r);
  brevoKaputt = false;
  mails.length = 0;
  r = await adminPost({ action: 'senden', id: a1.id });
  const gesendet = r.d.angebot;
  const mail = mails[0] || {};
  const anhang = (mail.attachment || [])[0] || {};
  ok('Senden -> gesendet, gültig bis heute + 14 Tage', r.s === 200 && gesendet.status === 'gesendet' && gesendet.gueltigBis === inTagen(14), gesendet);
  ok('Mail an den Kunden mit PDF-Anhang', mails.length === 1 && mail.to[0].email === 'ayse@example.com'
    && anhang.name === 'Angebot-A-' + jahr + '-0001.pdf' && Buffer.from(anhang.content || '', 'base64').slice(0, 5).toString() === '%PDF-');
  const link = 'https://test.example/angebot?id=' + a1.id + '&amp;t=' + tokenVon(a1.id);
  ok('Mail hat Knopf "Angebot ansehen und annehmen" mit Kundenlink', mail.htmlContent.includes(link) && mail.htmlContent.includes('Angebot ansehen und annehmen'));
  ok('Mailtexte ohne Gedankenstrich und Ausrufezeichen', !/[–—!]/.test(mail.htmlContent.replace(/<!DOCTYPE[^>]*>/, '')) && !/[–—!]/.test(mail.subject));
  ok('Antworten gehen an Kubi (replyTo)', mail.replyTo && mail.replyTo.email === 'inhaber@example.com');
  ok('Gesendetes Angebot lässt sich nicht mehr bearbeiten (409)', (await adminPost({ action: 'speichern', id: a1.id, angebot: roh })).s === 409);
  ok('Gesendetes Angebot lässt sich nicht löschen (409)', (await adminPost({ action: 'loeschen', id: a1.id })).s === 409);
  ok('Admin sieht jetzt den Kundenlink', gesendet.link === 'https://test.example/angebot?id=' + a1.id + '&t=' + tokenVon(a1.id));

  /* ---- Token-Prüfung ------------------------------------------------------- */
  const t1 = tokenVon(a1.id);
  r = await kundeGet({ id: a1.id, t: t1 });
  const ans = r.d.angebot || {};
  ok('Richtiger Token -> 200, Kundenansicht', r.s === 200 && ans.nummer === 'A-' + jahr + '-0001' && ans.status === 'gesendet' && ans.gesamt === 1945.12);
  ok('Kundenansicht ohne Mail, Telefon, Token und Verlauf', !JSON.stringify(ans).includes('ayse@example.com') && !JSON.stringify(ans).includes('0151')
    && !JSON.stringify(ans).includes(t1) && !ans.verlauf && ans.vorname === 'Ayşe');
  ok('Kundenansicht ohne Positionen mit Menge 0, mit Standard-Markierung', ans.zeilen.every((zz) => zz.menge > 0) && ans.zeilen[0].standard === true);
  const falsch = t1.slice(0, -1) + (t1.slice(-1) === 'A' ? 'B' : 'A');
  ok('Falscher Token -> 404', (await kundeGet({ id: a1.id, t: falsch })).s === 404);
  ok('Token in falscher Form -> 404', (await kundeGet({ id: a1.id, t: 'abc' })).s === 404);
  ok('Unbekannte ID -> 404 (gleiche Antwort wie falscher Token)', (await kundeGet({ id: '0123456789ab', t: t1 })).s === 404);
  ok('ID in falscher Form -> 404', (await kundeGet({ id: '../angebot', t: t1 })).s === 404);
  ok('Annehmen mit falschem Token -> 404', (await kundePost({ id: a1.id, t: falsch, aktion: 'annehmen', haken: true })).s === 404);
  r = await kundeGet({ id: a1.id, t: t1, pdf: '1' });
  ok('Kunden-PDF mit Token -> gültiges PDF', r.s === 200 && Buffer.from(r.r.body, 'base64').slice(0, 5).toString() === '%PDF-');
  let gebremst = false;
  for (let i = 0; i < 62; i++) { const x = await kunde.handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': '10.99.9.9' }, queryStringParameters: { id: a1.id, t: falsch } }); if (x.statusCode === 429) { gebremst = true; break; } }
  ok('Bremse: Durchprobieren von einer Adresse endet mit 429', gebremst);

  /* ---- Annahme nur einmal -------------------------------------------------- */
  ok('Ohne Haken -> 400', (await kundePost({ id: a1.id, t: t1, aktion: 'annehmen', haken: false })).s === 400);
  telegramm.length = 0; mails.length = 0;
  r = await kundePost({ id: a1.id, t: t1, aktion: 'annehmen', haken: true, lang: 'tr' });
  ok('Annehmen -> 200, Status angenommen', r.s === 200 && r.d.angebot.status === 'angenommen' && angebotRoh(a1.id).annahme.lang === 'tr', r.d);
  ok('Telegram an Kubi: angenommen, Hinweis Anzahlung online aus', telegramm.length === 1 && telegramm[0].includes('Catering-Angebot angenommen')
    && telegramm[0].includes('A-' + jahr + '-0001') && telegramm[0].includes('Anzahlung online ist aus'), telegramm);
  ok('Bestätigungsmail an den Kunden (ohne Zahlknopf)', mails.length === 1 && mails[0].to[0].email === 'ayse@example.com'
    && mails[0].subject.startsWith('Danke für deine Zusage') && !mails[0].htmlContent.includes('Anzahlung zahlen'));
  r = await kundePost({ id: a1.id, t: t1, aktion: 'annehmen', haken: true });
  ok('Zweites Annehmen -> 409 schon_angenommen, kein zweites Telegram', r.s === 409 && r.d.error === 'schon_angenommen' && telegramm.length === 1);

  // Gleichzeitig: zweites Angebot senden und fünfmal parallel annehmen
  const b = (await adminPost({ action: 'neu', anfrage: 'c:1700000000000-abc123' })).d.angebot;
  await adminPost({ action: 'senden', id: b.id });
  const tb = tokenVon(b.id);
  telegramm.length = 0;
  const parallel = await Promise.all([1, 2, 3, 4, 5].map(() => kundePost({ id: b.id, t: tb, aktion: 'annehmen', haken: true })));
  ok('5 gleichzeitige Annahmen: genau eine 200, vier 409, ein Telegram',
    parallel.filter((x) => x.s === 200).length === 1 && parallel.filter((x) => x.s === 409).length === 4 && telegramm.length === 1,
    parallel.map((x) => x.s));

  /* ---- Schalter Anzahlung online AUS --------------------------------------- */
  const kassenVorher = kassen.length;
  r = await kundePost({ id: a1.id, t: t1, aktion: 'zahlen' });
  ok('Schalter AUS: Zahlen -> 403 anzahlung_aus, keine Kasse bei SumUp', r.s === 403 && r.d.error === 'anzahlung_aus' && kassen.length === kassenVorher);
  ok('Schalter AUS: Kundenansicht zeigt keinen Zahlknopf', (await kundeGet({ id: a1.id, t: t1 })).d.angebot.anzahlungOnline === false);

  /* ---- Schalter AN: Kasse, Webhook, Rückkehr ------------------------------- */
  r = await adminPost({ action: 'einstellungen', einstellungen: { anzahlungOnline: true, pakete: { flat: { name: 'All-in Flat', preis: 33, ab: 40 } } } });
  ok('Einstellungen speichern: Schalter an, Flat 33 €, Rest bleibt Standard', r.s === 200 && r.d.einstellungen.anzahlungOnline === true
    && r.d.einstellungen.pakete.flat.preis === 33 && r.d.einstellungen.pakete.classic.preis === 21);
  ok('Kundenansicht: Zahlknopf erlaubt', (await kundeGet({ id: a1.id, t: t1 })).d.angebot.anzahlungOnline === true);
  r = await kundePost({ id: a1.id, t: t1, aktion: 'zahlen' });
  const k1 = kassen[kassen.length - 1] || {};
  ok('Schalter AN: Kasse angelegt mit Anzahlung 583,54 €', r.s === 200 && /checkout\.sumup/.test(r.d.url) && k1.amount === 583.54
    && /^GNC-AN-[a-f0-9]{12}-/.test(k1.checkout_reference) && k1.redirect_url.endsWith('&zahlung=zurueck'), k1);
  ok('Rücksprung auf die Angebotsseite, Webhook wie bei Bestellungen', k1.redirect_url.startsWith('https://test.example/angebot?id=' + a1.id)
    && k1.return_url === 'https://test.example/.netlify/functions/sumup-webhook');
  r = await kundeGet({ id: a1.id, t: t1, pruefen: '1' });
  ok('Rückkehr ohne Zahlung: weiter angenommen, Zahlung läuft', r.d.angebot.status === 'angenommen' && r.d.angebot.zahlungLaeuft === true);

  const chk = 'chk_' + kassen.length;
  checkouts.get(chk).status = 'PAID';
  checkouts.get(chk).transactions = [{ transaction_code: 'TX42' }];
  telegramm.length = 0; mails.length = 0;
  r = antwort(await webhook.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ id: chk }) }));
  ok('Webhook (bei SumUp nachgesehen) -> bezahlt', r.s === 200 && r.d.aktion === 'bezahlt' && angebotRoh(a1.id).status === 'bezahlt'
    && angebotRoh(a1.id).zahlung.transaktion === 'TX42', r.d);
  ok('Telegram an Kubi: Anzahlung bezahlt, Mail an den Kunden', telegramm.length === 1 && telegramm[0].includes('Anzahlung bezahlt')
    && mails.length === 1 && mails[0].subject.startsWith('Anzahlung erhalten'));
  r = antwort(await webhook.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ id: chk }) }));
  const r2 = await kundeGet({ id: a1.id, t: t1, pruefen: '1' });
  ok('Webhook doppelt und Rückkehr danach: nichts doppelt', r.d.ignoriert === 'schon_bezahlt' && telegramm.length === 1 && r2.d.angebot.status === 'bezahlt');
  ok('Bezahlt: kein weiterer Zahlknopf', r2.d.angebot.anzahlungOnline === false && (await kundePost({ id: a1.id, t: t1, aktion: 'zahlen' })).s === 409);
  ok('Online bezahlt lässt sich nicht von Hand zurücknehmen', (await adminPost({ action: 'status', id: a1.id, status: 'angenommen' })).s === 409);

  // Zahlung über die Rückkehr des Kunden (Webhook kam nicht an)
  await kundePost({ id: b.id, t: tb, aktion: 'zahlen' });
  const chkB = 'chk_' + kassen.length;
  checkouts.get(chkB).status = 'PAID';
  r = await kundeGet({ id: b.id, t: tb, pruefen: '1' });
  ok('Rückkehr mit Zahlung: Seite prüft bei SumUp -> bezahlt', r.d.angebot.status === 'bezahlt' && angebotRoh(b.id).zahlung.quelle === 'rueckkehr');
  // Bestellungen bleiben unberührt
  ok('Webhook für normale Bestellungen unverändert (unbekannte Bestellung)', antwort(await webhook.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ id: 'chk_fremd' }) })).s === 200);

  /* ---- Erinnerung genau einmal nach 3 Tagen, Ablauf ------------------------ */
  await adminPost({ action: 'einstellungen', einstellungen: { anzahlungOnline: false } });
  const c = (await adminPost({ action: 'neu', anfrage: 'c:1700000000000-abc123' })).d.angebot;
  await adminPost({ action: 'senden', id: c.id });
  const gesendetAm = new Date(angebotRoh(c.id).gesendetAm);
  mails.length = 0; telegramm.length = 0;
  let lauf = await L.taeglicherLauf(new Date(gesendetAm.getTime() + 2 * TAG));
  ok('Nach 2 Tagen: keine Erinnerung', lauf.erinnert.length === 0 && mails.length === 0, lauf);
  lauf = await L.taeglicherLauf(new Date(gesendetAm.getTime() + 3 * TAG));
  ok('Nach 3 Tagen: genau eine Erinnerung', lauf.erinnert.length === 1 && lauf.erinnert[0] === c.nummer && mails.length === 1
    && mails[0].subject.startsWith('Kurze Erinnerung') && angebotRoh(c.id).erinnertAm, lauf);
  ok('Erinnerungsmail mit Kundenlink, Telegram-Zeile an Kubi', mails[0].htmlContent.includes('angebot?id=' + c.id) && telegramm.some((x) => x.includes('Erinnerung an')));
  lauf = await L.taeglicherLauf(new Date(gesendetAm.getTime() + 4 * TAG));
  const lauf2 = await L.taeglicherLauf(new Date(gesendetAm.getTime() + 5 * TAG));
  ok('Tag 4 und 5: keine zweite Erinnerung', lauf.erinnert.length === 0 && lauf2.erinnert.length === 0 && mails.length === 1);
  // Erinnerung, deren Mail scheitert, wird am nächsten Tag nachgeholt (und dann genau einmal)
  const d = (await adminPost({ action: 'neu', anfrage: 'c:1700000000000-abc123' })).d.angebot;
  await adminPost({ action: 'senden', id: d.id });
  const dAm = new Date(angebotRoh(d.id).gesendetAm);
  mails.length = 0;
  brevoKaputt = true;
  lauf = await L.taeglicherLauf(new Date(dAm.getTime() + 3 * TAG));
  brevoKaputt = false;
  ok('Erinnerung mit Mailfehler: nicht als erinnert vermerkt', lauf.erinnert.length === 0 && !angebotRoh(d.id).erinnertAm && lauf.fehler >= 1);
  lauf = await L.taeglicherLauf(new Date(dAm.getTime() + 4 * TAG));
  ok('… am nächsten Tag nachgeholt, genau einmal', lauf.erinnert.includes(d.nummer) && mails.filter((m) => m.subject.includes(d.nummer)).length === 1);
  // Gleichzeitig laufender Zeitplan (Netlify wiederholt): trotzdem nur eine Mail
  const e2 = (await adminPost({ action: 'neu', anfrage: 'c:1700000000000-abc123' })).d.angebot;
  await adminPost({ action: 'senden', id: e2.id });
  const eAm = new Date(angebotRoh(e2.id).gesendetAm);
  mails.length = 0;
  await Promise.all([L.taeglicherLauf(new Date(eAm.getTime() + 3 * TAG)), L.taeglicherLauf(new Date(eAm.getTime() + 3 * TAG))]);
  ok('Zwei Läufe gleichzeitig: genau eine Erinnerung', mails.filter((m) => m.subject.includes(e2.nummer)).length === 1);

  ok('Vor dem Zeitplan gilt ein überfälliges Angebot schon als abgelaufen',
    L.wirksamerStatus(angebotRoh(c.id), new Date(gesendetAm.getTime() + 15 * TAG)) === 'abgelaufen');
  lauf = await L.taeglicherLauf(new Date(gesendetAm.getTime() + 14 * TAG));
  ok('Am letzten Gültigkeitstag noch gesendet', !lauf.abgelaufen.includes(c.nummer) && angebotRoh(c.id).status === 'gesendet');
  telegramm.length = 0;
  lauf = await L.taeglicherLauf(new Date(gesendetAm.getTime() + 15 * TAG));
  ok('Tag danach: abgelaufen, Telegram-Zeile', lauf.abgelaufen.includes(c.nummer) && angebotRoh(c.id).status === 'abgelaufen'
    && telegramm.some((x) => x.includes('Abgelaufen: ' + c.nummer)));
  r = await kundePost({ id: c.id, t: tokenVon(c.id), aktion: 'annehmen', haken: true });
  ok('Abgelaufenes Angebot lässt sich nicht annehmen (409 abgelaufen)', r.s === 409 && r.d.error === 'abgelaufen');
  // Ablauf ohne Zeitplan: Kunde klickt nach Ablauf, Zeitplan lief noch nicht
  const roh2 = angebotRoh(d.id); roh2.gueltigBis = L.plusTage(L.heute(), -1); daten.set('catering|angebot:' + d.id, JSON.stringify(roh2));
  r = await kundePost({ id: d.id, t: tokenVon(d.id), aktion: 'annehmen', haken: true });
  ok('Gültigkeit vorbei, Zeitplan noch nicht gelaufen: trotzdem 409 abgelaufen', r.s === 409 && r.d.error === 'abgelaufen');
  ok('Erinnerung nicht für abgelaufene Angebote', !(await L.taeglicherLauf(new Date(Date.now() + 30 * TAG))).erinnert.length);

  /* ---- Status von Hand, Duplizieren ---------------------------------------- */
  r = await adminPost({ action: 'status', id: c.id, status: 'angenommen' });
  ok('Abgelaufen -> von Hand angenommen (Telefon)', r.s === 200 && r.d.angebot.status === 'angenommen' && angebotRoh(c.id).annahme.weg === 'telefon');
  r = await adminPost({ action: 'status', id: c.id, status: 'bezahlt' });
  ok('Bar bezahlt -> bezahlt', r.s === 200 && r.d.angebot.status === 'bezahlt' && angebotRoh(c.id).zahlung.weg === 'bar');
  r = await adminPost({ action: 'status', id: c.id, status: 'angenommen' });
  ok('Bar-Zahlung zurücknehmen -> angenommen', r.s === 200 && r.d.angebot.status === 'angenommen' && !daten.has('catering|angebot-zahlung:' + c.id));
  ok('Unbekannter Ziel-Status -> 409', (await adminPost({ action: 'status', id: c.id, status: 'gesendet' })).s === 409);

  const e3 = (await adminPost({ action: 'neu', anfrage: 'c:1700000000000-abc123' })).d.angebot;
  await adminPost({ action: 'senden', id: e3.id });
  r = await adminPost({ action: 'duplizieren', id: e3.id });
  const dup = r.d.angebot;
  ok('Duplizieren: neuer Entwurf, neue Nummer, gleiche Positionen und Anfrage', r.s === 200 && dup.status === 'entwurf' && dup.nummer !== e3.nummer
    && dup.anfrage === e3.anfrage && dup.zeilen.length === e3.zeilen.length && dup.vorgaengerNummer === e3.nummer && tokenVon(dup.id) !== tokenVon(e3.id));
  await adminPost({ action: 'senden', id: dup.id });
  ok('Duplikat senden ersetzt das offene Vorgänger-Angebot', angebotRoh(e3.id).status === 'abgelehnt' && angebotRoh(e3.id).ersetztDurch === dup.nummer);
  r = await kundeGet({ id: e3.id, t: tokenVon(e3.id) });
  ok('Kunde sieht beim alten Link "ersetzt"', r.d.angebot.status === 'abgelehnt' && r.d.angebot.ersetzt === true);

  /* ---- Übersicht ----------------------------------------------------------- */
  r = await adminGet({ liste: '1' });
  const offen = r.d.angebote.filter((x) => x.status === 'gesendet');
  ok('Liste mit Status je Angebot und Summe der offenen Angebote',
    r.s === 200 && r.d.summen.offen.anzahl === offen.length && Math.abs(r.d.summen.offen.summe - offen.reduce((s2, x) => s2 + x.gesamt, 0)) < 0.005
    && r.d.angebote.every((x) => L.STATUS.includes(x.status) && x.anfrage === 'c:1700000000000-abc123' || x.anfrage === null), r.d.summen);
  ok('Liste ohne Token', !JSON.stringify(r.d).includes(tokenVon(a1.id)));

  /* ---- Aufräumen nach 365 Tagen -------------------------------------------- */
  const vorher = [...daten.keys()].filter((k) => k.startsWith('catering|angebot:')).length;
  lauf = await L.taeglicherLauf(new Date(Date.now() + 400 * TAG));
  const nachher = [...daten.keys()].filter((k) => k.startsWith('catering|angebot:'));
  ok('Nach 365 Tagen: Entwürfe, abgelehnte und abgelaufene weg, bezahlte bleiben',
    lauf.geloescht > 0 && nachher.length < vorher && daten.has('catering|angebot:' + a1.id) && daten.has('catering|angebot:' + b.id), { vorher, nachher: nachher.length });

  r = antwort(await taeglich.handler({}));
  ok('Zeitplan-Function läuft (200, Bericht)', r.s === 200 && typeof r.d.geprueft === 'number');

  console.error = leise;
  console.log('\n' + (fehler ? '❌ ' + fehler + ' von ' + n + ' Prüfungen fehlgeschlagen' : '✅ Alle ' + n + ' Prüfungen grün'));
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.error = leise; console.error(e); process.exit(1); });
