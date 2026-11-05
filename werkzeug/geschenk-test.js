#!/usr/bin/env node
/**
 * werkzeug/geschenk-test.js
 * ----------------------------------------------------------------------------
 * Geschenkgutscheine (lib/geschenk.js) von Kauf bis Einlöse-Prüfung:
 *
 *   node werkzeug/geschenk-test.js
 *
 * Fährt die ECHTEN Handler (giftcard-checkout, sumup-webhook, giftcard-status,
 * giftcard-pdf, giftcard-check, giftcard-zustellung) gegen einen Blob-Speicher
 * im Arbeitsspeicher. SumUp, Brevo und Telegram sind nachgebaut, nichts
 * verlässt den Rechner.
 * ----------------------------------------------------------------------------
 */
const path = require('path');
const Module = require('module');

const DATEN = new Map();
const store = (name) => ({
  async get(k, o) { const v = DATEN.get(name + '|' + k); return v === undefined ? null : (o && o.type === 'json' ? JSON.parse(v) : v); },
  async setJSON(k, v, o) {
    const key = name + '|' + k;
    if (o && o.onlyIfNew && DATEN.has(key)) return { modified: false };
    DATEN.set(key, JSON.stringify(v)); return { modified: true, etag: String(Math.random()) };
  },
  async set(k, v) { DATEN.set(name + '|' + k, String(v)); return { modified: true }; },
  async delete(k) { DATEN.delete(name + '|' + k); },
  async list({ prefix } = {}) { return { blobs: [...DATEN.keys()].filter((k) => k.startsWith(name + '|' + (prefix || ''))).map((k) => ({ key: k.slice(name.length + 1) })) }; },
});
const lies = (name, k) => { const v = DATEN.get(name + '|' + k); return v === undefined ? null : JSON.parse(v); };
const schreib = (name, k, v) => DATEN.set(name + '|' + k, JSON.stringify(v));
const schluessel = (name, prefix) => [...DATEN.keys()].filter((k) => k.startsWith(name + '|' + prefix)).map((k) => k.slice(name.length + 1));
const originalLoad = Module._load;
Module._load = function (anfrage, ...rest) {
  if (anfrage === '@netlify/blobs') return { getStore: (o) => store(typeof o === 'string' ? o : o.name) };
  return originalLoad.call(this, anfrage, ...rest);
};

Object.assign(process.env, {
  SUMUP_API_KEY: 'sup_sk_test', SUMUP_MERCHANT_CODE: 'MTEST', SITE_URL: 'https://example.org',
  BREVO_API_KEY: 'xkeysib-test', BREVO_SENDER_EMAIL: 'shop@example.org', INTERNAL_HOOK_SECRET: 'geheim-test',
});
delete process.env.NETLIFY_BLOBS_SITE_ID;
delete process.env.TELEGRAM_BOT_TOKEN;

const F = path.join(__dirname, '..', 'netlify', 'functions');
const handler = (n) => require(F + '/' + n + '.js').handler;

/* --- Außenwelt nachbauen ----------------------------------------------------- */
const SUMUP = {};
const MAILS = [];
let brevoAus = false, ckNr = 0;
const antwort = (status, d) => ({ ok: status >= 200 && status < 300, status, json: async () => d, text: async () => JSON.stringify(d) });
global.fetch = async (url, opts = {}) => {
  url = String(url);
  const m = opts.method || 'GET';
  if (url.startsWith('https://api.sumup.com/v0.1/checkouts')) {
    if (m === 'POST') {
      const body = JSON.parse(opts.body);
      const id = 'ck-gs-' + (++ckNr);
      SUMUP[id] = { status: 'PENDING', amount: body.amount, checkout_reference: body.checkout_reference };
      return antwort(201, { id, status: 'PENDING', hosted_checkout_url: 'https://checkout.sumup.com/pay/' + id });
    }
    const id = decodeURIComponent(url.split('/checkouts/')[1] || '');
    const c = SUMUP[id];
    return c ? antwort(200, { id, ...c }) : antwort(404, {});
  }
  if (url.startsWith('https://api.brevo.com/')) {
    if (brevoAus) return antwort(500, { code: 'test_fehler' });
    MAILS.push(JSON.parse(opts.body));
    return antwort(201, { messageId: 'm' + MAILS.length });
  }
  if (url.startsWith('https://example.org/.netlify/functions/sumup-webhook')) {
    const r = await handler('sumup-webhook')({ httpMethod: 'POST', headers: opts.headers || {}, body: opts.body, queryStringParameters: {} });
    return antwort(r.statusCode, JSON.parse(r.body));
  }
  return antwort(503, {});
};
const PROTOKOLL = [];
const leiseLog = console.log;
console.error = (...a) => PROTOKOLL.push(a.map(String).join(' '));
console.warn = () => {};
console.log = (...a) => PROTOKOLL.push(a.map(String).join(' '));

let fehler = 0, n = 0, ipNr = 1;
const ok = (name, b, info) => { n++; if (!b) fehler++; leiseLog('  ' + (b ? '✅' : '❌') + ' ' + name + (b || info === undefined ? '' : '   → ' + JSON.stringify(info).slice(0, 400))); };
const ip = () => ({ 'x-nf-client-connection-ip': '10.3.0.' + (ipNr++ % 250) });
async function kaufe(body) {
  const r = await handler('giftcard-checkout')({ httpMethod: 'POST', headers: ip(), body: JSON.stringify(body), queryStringParameters: {} });
  return { code: r.statusCode, d: JSON.parse(r.body) };
}
async function zahle(id) {
  SUMUP[id].status = 'PAID';
  const r = await handler('sumup-webhook')({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ id }), queryStringParameters: {} });
  return JSON.parse(r.body);
}
async function status(ref, id) {
  const r = await handler('giftcard-status')({ httpMethod: 'GET', headers: ip(), queryStringParameters: { ref, id } });
  return { code: r.statusCode, d: JSON.parse(r.body) };
}
async function pruefe(code) {
  const r = await handler('giftcard-check')({ httpMethod: 'POST', headers: ip(), body: JSON.stringify({ code }), queryStringParameters: {} });
  return JSON.parse(r.body);
}
const geschenk = require(F + '/lib/geschenk.js');
const morgen = geschenk.tagePlus(geschenk.berlin().tag, 1);
const basis = (extra) => ({
  v: 2, amount: 30, preset: 'zwei', email: 'kaeufer@example.org', buyerName: 'Kubi',
  recipientName: 'Ayşe', recipientEmail: 'ayse@example.org', message: 'Alles Gute!\nLass es dir schmecken.',
  delivery: 'mail', sendOn: '', terms: true, ...extra,
});

(async () => {
  leiseLog('\nGeschenkgutscheine\n');

  /* 1. Prüfregeln beim Kauf */
  let r = await kaufe(basis({ terms: false }));
  ok('ohne Zustimmung zu den Bedingungen: abgewiesen', r.code === 400 && r.d.error === 'terms', r);
  r = await kaufe(basis({ recipientEmail: 'kein-mail' }));
  ok('Mail-Zustellung ohne gültige Empfänger-Adresse: abgewiesen', r.code === 400 && r.d.error === 'bad_recipient_email', r);
  r = await kaufe(basis({ sendOn: geschenk.berlin().tag }));
  ok('Wunschdatum heute: abgewiesen (frühestens morgen)', r.code === 400 && r.d.error === 'bad_date', r);
  r = await kaufe(basis({ sendOn: geschenk.tagePlus(geschenk.berlin().tag, 400) }));
  ok('Wunschdatum in über einem Jahr: abgewiesen', r.code === 400 && r.d.error === 'bad_date', r);
  r = await kaufe(basis({ amount: 250 }));
  ok('Betrag über 200 €: abgewiesen', r.code === 400 && r.d.error === 'bad_amount', r);
  r = await kaufe(basis({ buyerName: '' }));
  ok('ohne eigenen Namen: abgewiesen (steht als „Von“ auf der Karte)', r.code === 400 && r.d.error === 'bad_buyer', r);
  r = await kaufe(basis({ amount: 40, preset: 'zwei' }));
  const rec40 = lies('orders', 'o:' + r.d.reference);
  ok('Vorschlag passt nicht zum Betrag: Vorschlag fällt weg', r.code === 200 && rec40 && rec40.gift.preset === '', rec40 && rec40.gift);

  /* 2. Sofort per Mail */
  r = await kaufe(basis());
  ok('Kauf angelegt: SumUp-Weiterleitung und Vorgang „pending“', r.code === 200 && !!r.d.hosted_checkout_url && lies('orders', 'o:' + r.d.reference).status === 'pending', r);
  const k1 = r.d;
  let s = await status(k1.reference, 'falsche-id');
  ok('Danke-Ansicht mit falscher Checkout-ID: nicht gefunden', s.code === 404, s);
  s = await status(k1.reference, k1.id);
  ok('Danke-Ansicht vor der Zahlung: offen (nicht bezahlt)', s.code === 200 && s.d.state === 'open', s);
  MAILS.length = 0;
  const w1 = await zahle(k1.id);
  const rec1 = lies('orders', 'o:' + k1.reference);
  const code1 = rec1.code;
  ok('Zahlung: Code ausgestellt, Vorgang abgeschlossen', w1.action === 'giftcard_issued' && rec1.status === 'completed' && /^GNC[A-Z2-9]{6}$/.test(code1), w1);
  const v1 = lies('vouchers', 'c:' + code1);
  ok('Gutschein einlösbar wie bisher: 30 €, einmalig, ab 30 € Bestellwert', v1 && v1.value === 30 && v1.minOrder === 30 && v1.maxUses === 1 && v1.giftcard === true, v1);
  const d1 = lies('vouchers', 'gd:' + code1);
  ok('Geschenk-Daten gespeichert (Nachricht, Empfängerin, PDF-Schlüssel)', d1 && d1.message.includes('Lass es dir') && d1.recipientEmail === 'ayse@example.org' && d1.pdfToken.length === 36, d1);
  const anKaeufer = MAILS.find((m) => m.to[0].email === 'kaeufer@example.org');
  const anEmpf = MAILS.find((m) => m.to[0].email === 'ayse@example.org');
  ok('Mail an Käufer mit Code und PDF im Anhang', !!anKaeufer && anKaeufer.htmlContent.includes(code1) && anKaeufer.attachment && anKaeufer.attachment[0].content.length > 1000, anKaeufer && anKaeufer.subject);
  ok('Mail an Ayşe sofort, mit Nachricht und Code', !!anEmpf && anEmpf.htmlContent.includes('Lass es dir schmecken') && anEmpf.htmlContent.includes(code1) && /Kubi schenkt dir 30,00/.test(anEmpf.subject), anEmpf && anEmpf.subject);
  ok('Nachricht wird in der Mail maskiert', !anEmpf.htmlContent.includes('<script'));
  ok('Käufer-Mail: Kaufbeleg als zweites PDF im Anhang', anKaeufer.attachment.length === 2 && /^Kaufbeleg-GNC-GC-/.test(anKaeufer.attachment[1].name) && Buffer.from(anKaeufer.attachment[1].content, 'base64').slice(0, 4).toString() === '%PDF', anKaeufer.attachment.map((x) => x.name));
  ok('Mail an Ayşe: nur der Gutschein, kein Kaufbeleg', anEmpf.attachment.length === 1 && !anEmpf.htmlContent.includes('art=beleg'), anEmpf.attachment.map((x) => x.name));
  const archiv = lies('invoices', 'gs:' + k1.reference);
  ok('Kaufbeleg archiviert (Store invoices, gs:<Referenz>)', archiv && archiv.betrag === 30 && archiv.kaeufer.email === 'kaeufer@example.org' && archiv.code === code1 && archiv.art === 'Mehrzweck-Gutschein', archiv);
  ok('Zustellung vermerkt, kein offener Auftrag', !!lies('vouchers', 'gd:' + code1).recipientMailedAt && schluessel('vouchers', 'gz:').length === 0, schluessel('vouchers', 'gz:'));

  /* 3. Doppelte Signale erzeugen keinen zweiten Code */
  MAILS.length = 0;
  const w1b = await zahle(k1.id);
  ok('Webhook ein zweites Mal: kein neuer Code, keine Mail', w1b.ignored === 'already_completed' && MAILS.length === 0 && schluessel('vouchers', 'c:').length === 1, w1b);
  s = await status(k1.reference, k1.id);
  ok('Danke-Ansicht nach der Zahlung: Code, Zustellung, PDF-Links, Kaufbeleg', s.d.state === 'paid' && s.d.code === code1 && s.d.recipientMailed === true && /giftcard-pdf\?c=/.test(s.d.pdf) && /dl=1$/.test(s.d.pdfDownload) && /art=beleg/.test(s.d.beleg) && s.d.beleg.includes(lies('vouchers', 'gd:' + code1).belegToken), s.d);

  r = await kaufe(basis({ email: 'parallel@example.org' }));
  SUMUP[r.d.id].status = 'PAID';
  await Promise.all([
    handler('sumup-webhook')({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ id: r.d.id }), queryStringParameters: {} }),
    handler('sumup-webhook')({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ id: r.d.id }), queryStringParameters: {} }),
    status(r.d.reference, r.d.id),
  ]);
  const codesParallel = schluessel('vouchers', 'gd:').map((k) => lies('vouchers', k)).filter((d) => d.buyerEmail === 'parallel@example.org');
  ok('Webhook, zweiter Webhook und Danke-Ansicht gleichzeitig: genau ein Code', codesParallel.length === 1, codesParallel.map((d) => d.code));

  /* 4. Wunschdatum */
  MAILS.length = 0;
  r = await kaufe(basis({ email: 'datum@example.org', recipientEmail: 'geburtstag@example.org', sendOn: morgen }));
  await zahle(r.d.id);
  const code2 = lies('orders', 'o:' + r.d.reference).code;
  ok('Wunschdatum: nur Käufer-Mail jetzt, Auftrag für morgen', MAILS.length === 1 && MAILS[0].to[0].email === 'datum@example.org' && schluessel('vouchers', 'gz:').includes('gz:' + morgen + ':' + code2), schluessel('vouchers', 'gz:'));
  ok('Käufer-Mail nennt Tag und 8 Uhr', /um 8 Uhr an Ayşe/.test(MAILS[0].htmlContent));
  const [jy, jm, jd] = morgen.split('-').map(Number);
  const um = (stunde) => new Date(Date.UTC(jy, jm - 1, jd, stunde - 1));   // Berlin im Winter = UTC+1
  let z = await geschenk.faelligeZustellen(new Date());
  ok('heute: Auftrag bleibt liegen', z.verschickt === 0 && z.offen === 1, z);
  z = await geschenk.faelligeZustellen(um(7));
  ok('morgen 7 Uhr: noch nicht', z.verschickt === 0 && z.offen === 1, z);
  z = await geschenk.faelligeZustellen(um(8));
  const anGeb = MAILS.find((m) => m.to[0].email === 'geburtstag@example.org');
  ok('morgen 8 Uhr: Mail raus, Auftrag erledigt', z.verschickt === 1 && !!anGeb && schluessel('vouchers', 'gz:').length === 0, z);
  z = await geschenk.faelligeZustellen(um(9));
  ok('nächster Lauf: nichts doppelt', z.verschickt === 0 && MAILS.filter((m) => m.to[0].email === 'geburtstag@example.org').length === 1, z);

  /* 5. Brevo fällt aus: neuer Versuch über den stündlichen Lauf */
  brevoAus = true;
  r = await kaufe(basis({ email: 'ausfall@example.org', recipientEmail: 'ausfall-empf@example.org' }));
  const w5 = await zahle(r.d.id);
  const code5 = lies('orders', 'o:' + r.d.reference).code;
  ok('Mail-Ausfall: Code trotzdem ausgestellt, Wiederholung geplant', !!code5 && w5.action === 'giftcard_mail_failed' && schluessel('vouchers', 'gz:').some((k) => k.endsWith(':' + code5)), w5);
  brevoAus = false;
  MAILS.length = 0;
  z = await handler('giftcard-zustellung')({});
  ok('stündlicher Lauf holt die Mail an die Empfängerin nach', MAILS.some((m) => m.to[0].email === 'ausfall-empf@example.org') && !schluessel('vouchers', 'gz:').some((k) => k.endsWith(':' + code5)), JSON.parse(z.body));

  /* 6. Selbst drucken */
  MAILS.length = 0;
  r = await kaufe(basis({ email: 'druck@example.org', delivery: 'print', recipientEmail: '', recipientName: '' }));
  ok('Drucken: Name der beschenkten Person ist freiwillig', r.code === 200, r);
  await zahle(r.d.id);
  const code6 = lies('orders', 'o:' + r.d.reference).code;
  ok('Drucken: nur Käufer-Mail mit PDF, kein Auftrag', MAILS.length === 1 && MAILS[0].htmlContent.includes('Ausdrucken') && !schluessel('vouchers', 'gz:').some((k) => k.endsWith(code6)), MAILS.length);

  /* 7. Alter Seitenstand ohne v: 2 */
  MAILS.length = 0;
  r = await kaufe({ amount: 25, email: 'alt@example.org', buyerName: 'Alt', recipientName: 'Jemand' });
  ok('alter Seitenstand: Kauf klappt weiter', r.code === 200, r);
  await zahle(r.d.id);
  ok('alter Seitenstand: Code nur an Käufer', MAILS.length === 1 && MAILS[0].to[0].email === 'alt@example.org', MAILS.map((m) => m.to[0].email));

  /* 8. PDF */
  const d6 = lies('vouchers', 'gd:' + code1);
  let p = await handler('giftcard-pdf')({ httpMethod: 'GET', headers: ip(), queryStringParameters: { c: code1, t: 'falsch'.padEnd(36, '0') } });
  ok('PDF mit falschem Schlüssel: 404', p.statusCode === 404);
  p = await handler('giftcard-pdf')({ httpMethod: 'GET', headers: ip(), queryStringParameters: { c: code1, t: d6.pdfToken, dl: '1' } });
  ok('PDF mit Schlüssel: echtes PDF zum Herunterladen', p.statusCode === 200 && Buffer.from(p.body, 'base64').slice(0, 4).toString() === '%PDF' && /attachment/.test(p.headers['Content-Disposition']), p.statusCode);
  p = await handler('giftcard-pdf')({ httpMethod: 'GET', headers: ip(), queryStringParameters: { c: code1, t: d6.pdfToken, art: 'beleg' } });
  ok('Kaufbeleg mit dem Gutschein-Schlüssel der Beschenkten: 404', p.statusCode === 404);
  p = await handler('giftcard-pdf')({ httpMethod: 'GET', headers: ip(), queryStringParameters: { c: code1, t: d6.belegToken, art: 'beleg', dl: '1' } });
  ok('Kaufbeleg mit eigenem Schlüssel: PDF', p.statusCode === 200 && Buffer.from(p.body, 'base64').slice(0, 4).toString() === '%PDF' && /Kaufbeleg-GNC-GC-/.test(p.headers['Content-Disposition']), p.statusCode);

  /* 9. Prüfen */
  let c = await pruefe(code1.toLowerCase().replace(/^gnc/, 'gnc-'));
  ok('Prüfen: gültig, Wert, Mindestbestellwert, keine Namen', c.valid === true && c.value === 30 && c.minOrder === 30 && !JSON.stringify(c).includes('Ayşe') && !JSON.stringify(c).includes('@'), c);
  ok('Prüfen: Tippfehler-Format', (await pruefe('GNC12')).reason === 'format');
  ok('Prüfen: unbekannter Code', (await pruefe('GNCZZZZZZ')).reason === 'unknown');
  schreib('vouchers', 'c:GNCAKTION', { code: 'GNCAKTION', value: 5, active: true, maxUses: 100, uses: 0 });
  ok('Prüfen: Aktionscodes bleiben unsichtbar', (await pruefe('GNCAKTION')).reason === 'unknown');
  const vb = lies('vouchers', 'c:' + code6); vb.uses = 1; schreib('vouchers', 'c:' + code6, vb);
  ok('Prüfen: eingelöst', (await pruefe(code6)).reason === 'used');
  const ve = lies('vouchers', 'c:' + code5); ve.validUntil = '2020-01-01'; schreib('vouchers', 'c:' + code5, ve);
  ok('Prüfen: abgelaufen', (await pruefe(code5)).reason === 'expired');

  /* 10. Rückerstattet vor dem Wunschdatum: keine Mail mehr */
  r = await kaufe(basis({ email: 'storno@example.org', recipientEmail: 'storno-empf@example.org', sendOn: morgen }));
  await zahle(r.d.id);
  const code10 = lies('orders', 'o:' + r.d.reference).code;
  const v10 = lies('vouchers', 'c:' + code10); v10.active = false; schreib('vouchers', 'c:' + code10, v10);
  MAILS.length = 0;
  z = await geschenk.faelligeZustellen(um(8));
  ok('rückerstattet: Auftrag verworfen, keine Mail', !MAILS.some((m) => m.to[0].email === 'storno-empf@example.org') && !schluessel('vouchers', 'gz:').some((k) => k.endsWith(code10)), z);

  /* 11. Aufräumen nach Ablauf */
  const { aufraeumen } = require(F + '/lib/aufraeumen.js');
  const dAlt = lies('vouchers', 'gd:' + code5); dAlt.validUntil = '2020-01-01'; schreib('vouchers', 'gd:' + code5, dAlt);
  const auf = await aufraeumen(store);
  ok('Aufräumen: Geschenk-Daten 90 Tage nach Ablauf gelöscht, Gutschein bleibt', auf.geschenk === 1 && !lies('vouchers', 'gd:' + code5) && !!lies('vouchers', 'c:' + code5), auf);
  ok('Aufräumen: Namen auch aus der Gutschein-Notiz entfernt', !/Ayşe|Kubi/.test(lies('vouchers', 'c:' + code5).note), lies('vouchers', 'c:' + code5).note);

  /* 12. Am Truck einlösen (Scanner im Admin-Tool, auch Minijobber) */
  process.env.ZWEI_FAKTOR = 'aus';
  process.env.ADMIN_PASSWORD = 'admin-test';
  const { hashen } = require(F + '/lib/team-passwort.js');
  schreib('team', 'u:lena', { name: 'Lena', role: 'staff', pwHash: await hashen('lena-test') });
  schreib('team', 'u:tom', { name: 'Tom', role: 'staff', pwHash: await hashen('tom-test') });
  const truck = async (pw, body) => {
    const r = await handler('giftcard-einloesen')({ httpMethod: 'POST', headers: ip(), body: JSON.stringify({ password: pw, ...body }), queryStringParameters: {} });
    return { code: r.statusCode, d: JSON.parse(r.body) };
  };
  r = await kaufe(basis({ email: 'truck@example.org', recipientEmail: 'truck-empf@example.org' }));
  await zahle(r.d.id);
  const codeT = lies('orders', 'o:' + r.d.reference).code;
  let t = await truck('falsch', { action: 'pruefen', code: codeT });
  ok('Truck: ohne Team-Passwort kein Zugriff', t.code === 401, t);
  t = await truck('lena-test', { action: 'pruefen', code: 'gnc-' + codeT.slice(3).toLowerCase() });
  ok('Truck: Minijobberin sieht Wert, Mindestbestellwert, Status offen', t.code === 200 && t.d.gift.value === 30 && t.d.gift.minOrder === 30 && t.d.gift.status === 'offen' && t.d.gift.recipientName === 'Ayşe', t.d);
  t = await truck('lena-test', { action: 'pruefen', code: 'GNCAKTION' });
  ok('Truck: Aktionscodes erscheinen nicht als Geschenkgutschein', t.code === 404, t);
  t = await truck('lena-test', { action: 'einloesen', code: codeT, bestellwert: '24,50' });
  ok('Truck: Bestellwert unter dem Gutscheinwert wird abgewiesen', t.code === 400 && t.d.error === 'too_low' && /5,50/.test(t.d.hint), t.d);
  const [t1, t2] = await Promise.all([
    truck('lena-test', { action: 'einloesen', code: codeT, bestellwert: '34,50' }),
    truck('tom-test', { action: 'einloesen', code: codeT, bestellwert: '34,50' }),
  ]);
  const gut = [t1, t2].filter((x) => x.code === 200);
  ok('Truck: zwei Handys gleichzeitig, nur eines löst ein', gut.length === 1 && [t1, t2].some((x) => x.code === 409), [t1.code, t2.code]);
  ok('Truck: Rest für SumUp stimmt (34,50 − 30 = 4,50)', gut[0] && gut[0].d.rest === 4.5 && gut[0].d.gift.status === 'eingeloest' && gut[0].d.gift.redeemedVia === 'truck', gut[0] && gut[0].d);
  const vT = lies('vouchers', 'c:' + codeT);
  ok('Truck: Gutschein verbraucht, online nicht mehr einlösbar', vT.uses === vT.maxUses && (await pruefe(codeT)).reason === 'used', vT);
  const wer = gut[0] === t1 ? ['lena-test', 'tom-test'] : ['tom-test', 'lena-test'];
  t = await truck(wer[1], { action: 'zuruecknehmen', code: codeT });
  ok('Truck: andere Person darf nicht zurücknehmen', t.code === 403, t);
  t = await truck(wer[0], { action: 'zuruecknehmen', code: codeT });
  ok('Truck: wer eingelöst hat, nimmt in 15 Minuten zurück', t.code === 200 && t.d.gift.status === 'offen' && (await pruefe(codeT)).valid === true, t.d);
  t = await truck('tom-test', { action: 'einloesen', code: codeT, bestellwert: 30 });
  ok('Truck: danach wieder einlösbar (genau Gutscheinwert, Rest 0)', t.code === 200 && t.d.rest === 0, t.d);
  const vT2 = lies('vouchers', 'c:' + codeT); vT2.manualRedeemedAt = new Date(Date.now() - 20 * 60000).toISOString(); schreib('vouchers', 'c:' + codeT, vT2);
  t = await truck('tom-test', { action: 'zuruecknehmen', code: codeT });
  ok('Truck: nach 15 Minuten nur noch der Admin', t.code === 403, t);
  t = await truck('admin-test', { action: 'zuruecknehmen', code: codeT });
  ok('Truck: Admin nimmt jederzeit zurück', t.code === 200 && t.d.gift.status === 'offen', t.d);
  t = await truck('lena-test', { action: 'einloesen', code: code10, bestellwert: 50 });
  ok('Truck: erstatteter (gesperrter) Gutschein lässt sich nicht einlösen', t.code === 409 && t.d.error === 'inactive', t.d);
  const audit = schluessel('audit', 'a:').map((k) => lies('audit', k)).filter((x) => x.action === 'Gutschein');
  ok('Truck: jede Einlösung namentlich im Protokoll', audit.some((x) => /am Truck eingelöst/.test(x.detail) && /in SumUp 4,50/.test(x.detail)) && audit.some((x) => x.name === 'Kubi' && /zurückgenommen/.test(x.detail)), audit.map((x) => x.name + ': ' + x.detail));

  /* 13. QR-Code */
  const qrAntwort = await handler('giftcard-qr')({ httpMethod: 'GET', headers: ip(), queryStringParameters: { c: codeT } });
  ok('QR für die Mail: GIF', qrAntwort.statusCode === 200 && Buffer.from(qrAntwort.body, 'base64').slice(0, 3).toString() === 'GIF', qrAntwort.statusCode);
  ok('QR in der Mail an die Beschenkte', MAILS.some((m) => m.to[0].email === 'truck-empf@example.org' && m.htmlContent.includes('giftcard-qr?c=' + codeT)));

  const lecks = PROTOKOLL.filter((l) => /ayse@example|Lass es dir/.test(l));
  ok('Protokoll ohne Adressen und Nachrichten', lecks.length === 0, lecks);

  leiseLog('\n' + (n - fehler) + '/' + n + ' bestanden' + (fehler ? ', ' + fehler + ' FEHLER' : '') + '\n');
  process.exit(fehler ? 1 : 0);
})().catch((e) => { leiseLog('Absturz:', e); process.exit(1); });
