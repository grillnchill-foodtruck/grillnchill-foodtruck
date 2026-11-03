#!/usr/bin/env node
/**
 * werkzeug/wallet-test.js
 * ----------------------------------------------------------------------------
 * Apple Pay in der iOS-App (ab Build 8) und Google Pay: sumup-checkout legt die
 * Kasse mit zahlweg 'applepay' bzw. 'googlepay' an und verarbeitet danach das
 * Token (aktion 'applepay' bzw. 'googlepay').
 *
 *   node werkzeug/wallet-test.js
 *
 * Fährt den ECHTEN Handler gegen einen Blob-Speicher im Arbeitsspeicher.
 * SumUp ist nachgebaut, nichts verlässt den Rechner.
 *
 * Geprüft: Schalter aus = Weiterleitung, Schalter an = Kasse ohne gehostete
 * Seite, Token geht unverändert und ungekürzt an SumUp, Betrag kommt von
 * SumUp statt aus dem Browser, fremde oder falsche Vorgänge werden
 * abgewiesen, Fehler von SumUp landen ohne Token im Protokoll.
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
const originalLoad = Module._load;
Module._load = function (anfrage, ...rest) {
  if (anfrage === '@netlify/blobs') return { getStore: (o) => store(typeof o === 'string' ? o : o.name) };
  return originalLoad.call(this, anfrage, ...rest);
};

Object.assign(process.env, { SUMUP_API_KEY: 'sup_sk_test', SUMUP_MERCHANT_CODE: 'MTEST', URL: 'https://example.org', SUMUP_SANDBOX: 'false' });
delete process.env.NETLIFY_BLOBS_SITE_ID;

/* --- SumUp nachbauen ------------------------------------------------------- */
const SUMUP = {};
const PUTS = [];
let ckNr = 0, putAntwort = null;
const antwort = (status, d) => ({ ok: status >= 200 && status < 300, status, json: async () => d, text: async () => JSON.stringify(d) });
global.fetch = async (url, opts = {}) => {
  url = String(url);
  if (!url.startsWith('https://api.sumup.com/v0.1/checkouts')) return antwort(503, {});
  const m = opts.method || 'GET';
  if (m === 'POST') {
    const body = JSON.parse(opts.body);
    const id = 'ck-applepay-' + (++ckNr);
    SUMUP[id] = { status: 'PENDING', amount: body.amount, currency: body.currency, payload: body };
    return antwort(201, { id, status: 'PENDING', ...(body.hosted_checkout ? { hosted_checkout_url: 'https://checkout.sumup.com/pay/' + id } : {}) });
  }
  const id = decodeURIComponent(url.split('/checkouts/')[1] || '');
  const c = SUMUP[id];
  if (!c) return antwort(404, {});
  if (m === 'PUT') {
    const body = JSON.parse(opts.body);
    PUTS.push(body);
    if (putAntwort) return putAntwort(body);
    c.status = 'PAID';
    return antwort(200, { id, status: 'PAID', amount: c.amount, transactions: [{ status: 'SUCCESSFUL' }] });
  }
  return antwort(200, { id, status: c.status, amount: c.amount, currency: c.currency });
};
const PROTOKOLL = [];
const leiseLog = console.log;
console.error = (...a) => PROTOKOLL.push(a.map(String).join(' '));
console.warn = () => {};

const F = path.join(__dirname, '..', 'netlify', 'functions');
const kasse = require(F + '/sumup-checkout.js');
let fehler = 0, n = 0, ipNr = 1;
const ok = (name, b, info) => { n++; if (!b) fehler++; leiseLog('  ' + (b ? '✅' : '❌') + ' ' + name + (b || info === undefined ? '' : '   → ' + JSON.stringify(info))); };
async function rufe(body) {
  const r = await kasse.handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '10.2.0.' + (ipNr++ % 250) }, body: typeof body === 'string' ? body : JSON.stringify(body), queryStringParameters: {} });
  let d = null; try { d = JSON.parse(r.body); } catch (e) {}
  return { code: r.statusCode, d };
}
const schalter = (an, gp) => schreib('shop-status', 'zahlung', { direktZahlung: false, applePayApp: an, googlePay: gp || 'aus', pass: { aktiv: false } });
const bestellung = (nr, zw) => ({
  zahlweg: zw || 'applepay', amount: 9.5, reference: 'GNC-17000000000' + nr,
  customer: { name: 'Test', email: 'ap' + nr + '@example.org', phone: '+4915100000' + nr },
  order: { total: 9.5, name: 'Test', email: 'ap' + nr + '@example.org', phone: '+4915100000' + nr, mode: 'pickup', payment: 'sumup', cartSnapshot: { a: { menuId: 'classic', qty: 1 } } },
});
// Token wie aus PKPayment, mit langem data-Feld (länger als saeubern() Texte durchlässt)
const langerText = 'A'.repeat(6000) + '==';
const token = () => ({
  paymentData: { data: langerText, signature: 'MIAGCSqGSIb3DQEHAqCAMIACAQEx', header: { publicKeyHash: 'h', ephemeralPublicKey: 'e', transactionId: 't1' }, version: 'EC_v1' },
  paymentMethod: { displayName: 'Visa 1234', network: 'Visa', type: 'debit' },
  transactionIdentifier: 'T-ABC',
});

(async () => {
  leiseLog('\nApple Pay in der App\n');

  /* 1. Schalter aus: Weiterleitung, Token wird abgewiesen */
  schalter(false);
  let r = await rufe(bestellung(1));
  ok('Schalter aus: Kasse bleibt Weiterleitung mit SumUp-Seite', r.code === 200 && r.d.zahlweg === 'weiterleitung' && !!r.d.hosted_checkout_url, r);
  r = await rufe({ aktion: 'applepay', reference: r.d.reference, checkoutId: r.d.id, token: token() });
  ok('Schalter aus: Token wird nicht verarbeitet', r.code === 403 && PUTS.length === 0, r);

  /* 2. Schalter an: Kasse ohne gehostete Seite, Betrag in der Antwort */
  schalter(true);
  r = await rufe(bestellung(2));
  const k = r.d;
  const roh = SUMUP[k.id] && SUMUP[k.id].payload;
  ok('Schalter an: zahlweg applepay, Kasse ohne gehostete Seite und ohne redirect_url', r.code === 200 && k.zahlweg === 'applepay' && roh && !roh.hosted_checkout && !roh.redirect_url, { k, roh });
  ok('Antwort nennt den Betrag fürs Apple-Pay-Blatt', typeof k.betrag === 'number' && k.betrag > 0, k);
  const rec = lies('orders', 'o:' + k.reference);
  ok('Archiv: offener Vorgang mit zahlweg applepay', rec && rec.status === 'pending' && rec.zahlweg === 'applepay' && rec.checkoutId === k.id, rec);

  /* 3. Abweisen */
  r = await rufe({ aktion: 'applepay', reference: k.reference, checkoutId: 'ck-falsch-123', token: token() });
  ok('Falsche Checkout-ID: abgewiesen', r.code === 404 && PUTS.length === 0, r);
  r = await rufe({ aktion: 'applepay', reference: 'GNC-1', checkoutId: k.id, token: token() });
  ok('Unbekannte Referenz: abgewiesen', r.code === 404 && PUTS.length === 0, r);
  r = await rufe({ aktion: 'applepay', reference: k.reference, checkoutId: k.id, token: { paymentData: {} } });
  ok('Token ohne Inhalt: abgewiesen', r.code === 400 && PUTS.length === 0, r);
  r = await rufe({ aktion: 'applepay', reference: k.reference, checkoutId: k.id });
  ok('Ohne Token: abgewiesen', r.code === 400 && PUTS.length === 0, r);

  /* 4. Verarbeiten */
  SUMUP[k.id].amount = 9.5;
  r = await rufe({ aktion: 'applepay', reference: k.reference, checkoutId: k.id, amount: 0.01, token: token() });
  const put = PUTS[0] || {};
  ok('Bezahlt: Antwort PAID', r.code === 200 && r.d.status === 'PAID' && r.d.ok === true, r);
  ok('An SumUp: payment_type apple_pay mit Checkout-ID', put.payment_type === 'apple_pay' && put.id === k.id, put);
  ok('Betrag kommt von SumUp, nicht aus dem Browser (9,50 statt 0,01)', put.amount === 9.5 && put.currency === 'EUR', put);
  ok('Token unverändert und ungekürzt weitergereicht', JSON.stringify(put.apple_pay && put.apple_pay.token) === JSON.stringify(token()), (put.apple_pay && put.apple_pay.token && put.apple_pay.token.paymentData.data.length));
  r = await rufe({ aktion: 'applepay', reference: k.reference, checkoutId: k.id, token: token() });
  ok('Schon bezahlt: PAID ohne zweite Belastung', r.d.status === 'PAID' && PUTS.length === 1, { r, puts: PUTS.length });

  /* 5. Abgelehnt und Bank-Abfrage */
  r = await rufe(bestellung(3));
  const k3 = r.d;
  putAntwort = () => antwort(400, [{ param: 'apple_pay', error_code: 'INVALID', message: 'Token ungültig' }]);
  PROTOKOLL.length = 0;
  r = await rufe({ aktion: 'applepay', reference: k3.reference, checkoutId: k3.id, token: token() });
  ok('SumUp lehnt ab: FAILED', r.code === 200 && r.d.status === 'FAILED' && r.d.ok === false, r);
  ok('Protokoll nennt den Fehler, aber nie das Token', PROTOKOLL.some((z) => /INVALID/.test(z)) && !PROTOKOLL.some((z) => z.includes('AAAAAAAA') || z.includes('MIAGCSq')), PROTOKOLL);
  r = await rufe(bestellung(4));
  const k4 = r.d;
  putAntwort = () => antwort(202, { id: k4.id, status: 'PENDING', next_step: { url: 'https://bank.example/3ds' } });
  r = await rufe({ aktion: 'applepay', reference: k4.reference, checkoutId: k4.id, token: token() });
  ok('Bank will eine Abfrage (next_step): FAILED, das Blatt kann sie nicht zeigen', r.d.status === 'FAILED', r);

  /* 6. Storniert */
  r = await rufe(bestellung(5));
  const k5 = r.d;
  const rec5 = lies('orders', 'o:' + k5.reference); rec5.status = 'cancelled'; schreib('orders', 'o:' + k5.reference, rec5);
  putAntwort = null;
  const vorher = PUTS.length;
  r = await rufe({ aktion: 'applepay', reference: k5.reference, checkoutId: k5.id, token: token() });
  ok('Stornierter Vorgang: nicht mehr belastbar', r.code === 409 && PUTS.length === vorher, r);

  /* 7. Google Pay */
  leiseLog('\nGoogle Pay\n');
  process.env.GOOGLE_PAY_MERCHANT_ID = 'BCR2DN4TEST';
  const gpToken = () => ({ apiVersion: 2, apiVersionMinor: 0, paymentMethodData: { type: 'CARD', description: 'Visa •••• 1234', info: { cardNetwork: 'VISA', cardDetails: '1234' }, tokenizationData: { type: 'PAYMENT_GATEWAY', token: '{"signature":"' + 'B'.repeat(5000) + '","protocolVersion":"ECv2"}' } } });
  const shop = require(F + '/shop-status.js');
  const lade = async () => JSON.parse((await shop.handler({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': '10.3.0.1' }, queryStringParameters: {} })).body);
  schalter(true, 'aus');
  let st = await lade();
  ok('Google Pay aus: shop-status nennt keine Google-Pay-Daten', st.zahlung && st.zahlung.googlePay === null, st.zahlung);
  schalter(true, 'test');
  st = await lade();
  ok('Testmodus: shop-status nennt Modus, Google-Händler-ID und SumUp-Code', st.zahlung.googlePay && st.zahlung.googlePay.modus === 'test' && st.zahlung.googlePay.merchantId === 'BCR2DN4TEST' && st.zahlung.googlePay.gatewayMerchantId === 'MTEST', st.zahlung);
  r = await rufe(bestellung(6, 'googlepay'));
  ok('Testmodus: Kasse bleibt Weiterleitung, im Test wird nie bezahlt', r.d.zahlweg === 'weiterleitung', r.d);
  const vorGp = PUTS.length;
  r = await rufe({ aktion: 'googlepay', reference: r.d.reference, checkoutId: r.d.id, token: gpToken() });
  ok('Testmodus: Token wird nicht verarbeitet', r.code === 403 && PUTS.length === vorGp, r);
  schalter(true, 'an');
  r = await rufe(bestellung(7, 'googlepay'));
  const g = r.d;
  ok('An: zahlweg googlepay, Kasse ohne gehostete Seite', g.zahlweg === 'googlepay' && SUMUP[g.id] && !SUMUP[g.id].payload.hosted_checkout, g);
  r = await rufe({ aktion: 'applepay', reference: g.reference, checkoutId: g.id, token: token() });
  ok('Apple-Pay-Token auf einer Google-Pay-Kasse: abgewiesen', r.code === 404 && PUTS.length === vorGp, r);
  r = await rufe({ aktion: 'googlepay', reference: g.reference, checkoutId: g.id, token: { apiVersion: 2, paymentMethodData: {} } });
  ok('Google-Token ohne tokenizationData: abgewiesen', r.code === 400 && PUTS.length === vorGp, r);
  r = await rufe({ aktion: 'googlepay', reference: g.reference, checkoutId: g.id, token: gpToken() });
  const gput = PUTS[PUTS.length - 1] || {};
  ok('Bezahlt: Antwort PAID', r.d.status === 'PAID', r);
  ok('An SumUp: payment_type google_pay, PaymentData unverändert im Feld google_pay', gput.payment_type === 'google_pay' && JSON.stringify(gput.google_pay) === JSON.stringify(gpToken()) && !gput.apple_pay, gput.payment_type);

  leiseLog('\n' + (n - fehler) + ' von ' + n + (fehler ? ' – ' + fehler + ' FEHLER' : ' grün'));
  process.exit(fehler ? 1 : 0);
})();
