/**
 * werkzeug/checkout-durchlauf.js
 * ----------------------------------------------------------------------------
 * Faehrt die echten Handler von sumup-checkout, voucher-check und send-email
 * und prueft, welcher Betrag am Ende wirklich belastet wird.
 *
 * Beantwortet die Frage, auf die es ankommt: Zahlt eine ehrliche Bestellung
 * genau den angezeigten Preis, und zahlt eine manipulierte trotzdem den Preis
 * aus der Karte? Barbestellungen sind eigens dabei, weil sie nicht ueber SumUp
 * laufen – fuer sie ist send-email die einzige Stelle, an der der Preis
 * ueberhaupt geprueft wird.
 *
 * Blob-Speicher und ausgehende Aufrufe (SumUp, Brevo, Telegram) sind
 * Attrappen; der Rest laeuft unveraendert.
 *
 * Voraussetzung: npm install   (send-email zieht pdfkit)
 * Aufruf:        node werkzeug/checkout-durchlauf.js
 * Ausgang:       0 = alles wie vorgesehen, 1 = Abweichung
 * ----------------------------------------------------------------------------
 */
const path = require('path');
const Module = require('module');
const FUNCS = path.join(__dirname, '..', 'netlify', 'functions');

const daten = new Map();
const blobs = { getStore: () => ({
  async get(k) { const v = daten.get(k); return v === undefined ? null : JSON.parse(v); },
  async setJSON(k, v) { daten.set(k, JSON.stringify(v)); },
  async delete(k) { daten.delete(k); },
  async list({ prefix } = {}) {
    return { blobs: [...daten.keys()].filter(k => !prefix || k.startsWith(prefix)).map(key => ({ key })) };
  },
}) };
Module._resolveFilename = ((o) => function (r, ...a) {
  if (r === '@netlify/blobs') return '@netlify/blobs';
  return o.call(this, r, ...a);
})(Module._resolveFilename);
require.cache['@netlify/blobs'] = { id: '@netlify/blobs', loaded: true, exports: blobs };

// Ausgehende Aufrufe abfangen
let sumupBetrag = null;
const ausgehend = [];
global.fetch = async (url, opts = {}) => {
  const body = opts.body ? JSON.parse(opts.body) : {};
  ausgehend.push({ url: String(url), body });
  if (String(url).includes('sumup.com/v0.1/checkouts')) {
    sumupBetrag = body.amount;
    return { ok: true, status: 200, json: async () => ({ id: 'chk_1', hosted_checkout_url: 'https://pay.test/1' }) };
  }
  return { ok: true, status: 200, json: async () => ({ messageId: 'x' }) };
};

process.env.SUMUP_API_KEY = 'sup_sk_test_1234567890';
process.env.SUMUP_MERCHANT_CODE = 'MTEST01';
process.env.BREVO_API_KEY = 'xkeysib-test';
process.env.BREVO_SENDER_EMAIL = 'noreply@test.de';
process.env.OWNER_EMAIL = 'kubi@test.de';
process.env.STATUS_UPDATE_SECRET = 'geheim-status-1234567890';
process.env.TEST_ORDER_CODE = 'MEINGEHEIMERTESTCODE';
process.env.TELEGRAM_BOT_TOKEN = 'bot-test';
process.env.TELEGRAM_CHAT_ID = '123';

const SK = require(path.join(__dirname, '..', 'speisekarte.js'));
const sumup = require(path.join(FUNCS, 'sumup-checkout.js'));
const voucher = require(path.join(FUNCS, 'voucher-check.js'));
const mail = require(path.join(FUNCS, 'send-email.js'));

const post = (h, body) => h.handler({ httpMethod: 'POST', body: JSON.stringify(body), headers: {} });
const zeile = (t, ok, extra = '') => { console.log('  ' + (ok ? '✅' : '❌') + ' ' + t.padEnd(52) + extra); return ok; };

function bestellung(patch = {}) {
  const cart = { a: { menuId: 'kubis', qty: 4, double: false, isMenu: false } };   // 44,00 €
  const w = SK.warenwert(cart);
  return Object.assign({
    reference: 'GNC-' + Date.now(), name: 'Test Gast', email: 'gast@test.de', phone: '0151',
    mode: 'pickup', payment: 'sumup', cartSnapshot: cart, items: [],
    subtotal: w, discount: 0, loyaltyDiscount: 0, deliveryFee: 0, tip: 0, total: w,
  }, patch);
}

(async () => {
  let alles = true;
  const ECHT = 44.0;

  console.log('\n1) sumup-checkout – was wird bei SumUp wirklich belastet?\n');

  sumupBetrag = null;
  await post(sumup, { order: bestellung(), amount: ECHT, reference: 'GNC-OK' });
  alles &= zeile('Ehrliche Bestellung', Math.abs(sumupBetrag - ECHT) < 0.005, sumupBetrag + ' EUR (Karte ' + ECHT + ')');

  sumupBetrag = null;
  await post(sumup, { order: bestellung({ total: 1.0 }), amount: 1.0, reference: 'GNC-BETRUG' });
  alles &= zeile('total auf 1 € manipuliert', Math.abs(sumupBetrag - ECHT) < 0.005, sumupBetrag + ' EUR statt 1,00');

  sumupBetrag = null;
  await post(sumup, { order: bestellung({ total: 1.0, isTest: true }), amount: 1.0, reference: 'GNC-FAKETEST' });
  alles &= zeile('Testbestellung ohne Code', Math.abs(sumupBetrag - ECHT) < 0.005, sumupBetrag + ' EUR statt 1,00');

  sumupBetrag = null;
  await post(sumup, { order: bestellung({ total: 1.0, isTest: true, testCode: 'MEINGEHEIMERTESTCODE' }),
    amount: 1.0, reference: 'GNC-ECHTTEST' });
  alles &= zeile('Testbestellung MIT richtigem Code', Math.abs(sumupBetrag - 1.0) < 0.005, sumupBetrag + ' EUR');

  sumupBetrag = null;
  await post(sumup, { order: bestellung({ total: 1.0, testCode: 'TESTGNC1', isTest: true }),
    amount: 1.0, reference: 'GNC-ALTCODE' });
  alles &= zeile('Alter Code TESTGNC1 wirkt nicht mehr', Math.abs(sumupBetrag - ECHT) < 0.005, sumupBetrag + ' EUR statt 1,00');

  // Ohne Warenkorb darf NICHT korrigiert werden (Ausfallsicherheit)
  sumupBetrag = null;
  const ohneKorb = bestellung({ total: 23.5 }); delete ohneKorb.cartSnapshot;
  await post(sumup, { order: ohneKorb, amount: 23.5, reference: 'GNC-OHNEKORB' });
  alles &= zeile('Ohne Warenkorb: Betrag bleibt unangetastet', Math.abs(sumupBetrag - 23.5) < 0.005, sumupBetrag + ' EUR');

  console.log('\n2) voucher-check – Testcode\n');
  const v1 = JSON.parse((await post(voucher, { code: 'MEINGEHEIMERTESTCODE' })).body);
  alles &= zeile('Richtiger Code -> kind:test', v1.valid === true && v1.kind === 'test', JSON.stringify(v1));
  const v2 = JSON.parse((await post(voucher, { code: 'TESTGNC1' })).body);
  alles &= zeile('Alter Code -> abgelehnt', !v2.valid, JSON.stringify(v2));
  const v3 = JSON.parse((await post(voucher, { code: 'IRGENDWAS' })).body);
  alles &= zeile('Zufaelliger Code -> abgelehnt', !v3.valid, JSON.stringify(v3));
  alles &= zeile('Antwort verraet den Code nie', !JSON.stringify(v1).includes('MEINGEHEIMERTESTCODE'));

  console.log('\n3) send-email – Barbestellung (laeuft NICHT ueber SumUp)\n');
  // Der Handler arbeitet auf SEINER Kopie (JSON ueber die Leitung). Geprueft
  // wird deshalb am archivierten Datensatz und an der Mail - also genau an
  // dem, was Kubi am Truck und im Postfach sieht.
  const archiv = (ref) => { const v = daten.get('o:' + ref); return v ? JSON.parse(v) : null; };

  await post(mail, { type: 'order_confirmation',
    order: bestellung({ payment: 'cash', total: 2.0, reference: 'GNC-BAR-BETRUG' }) });
  const aBetrug = archiv('GNC-BAR-BETRUG');
  alles &= zeile('Manipulierter Barbetrag im Archiv korrigiert',
    !!aBetrug && Math.abs(aBetrug.order.total - ECHT) < 0.005,
    (aBetrug ? aBetrug.order.total : '?') + ' EUR statt 2,00');
  alles &= zeile('Ursprungsbetrag festgehalten',
    !!aBetrug && aBetrug.order.totalGemeldet === 2.0,
    'totalGemeldet=' + (aBetrug && aBetrug.order.totalGemeldet));

  const mailBetrug = ausgehend.filter(a => a.url.includes('brevo')).pop();
  const mailText = JSON.stringify(mailBetrug && mailBetrug.body || {});
  alles &= zeile('Mail zeigt den korrigierten Betrag',
    /44,00\s*&nbsp;?€|44,00 €/.test(mailText) && !/\b2,00 €/.test(mailText),
    '44,00 € in der Mail: ' + /44,00/.test(mailText));

  await post(mail, { type: 'order_confirmation',
    order: bestellung({ payment: 'cash', total: ECHT, reference: 'GNC-BAR-OK' }) });
  const aOk = archiv('GNC-BAR-OK');
  alles &= zeile('Ehrliche Barbestellung unveraendert',
    !!aOk && Math.abs(aOk.order.total - ECHT) < 0.005 && !aOk.order.preisKorrigiert,
    (aOk ? aOk.order.total : '?') + ' EUR, keine Korrektur');

  console.log('\n4) Alarm an den Inhaber\n');
  const alarme = ausgehend.filter(a => a.url.includes('telegram') && /Preisabweichung/.test(a.body.text || ''));
  alles &= zeile('Telegram-Alarm bei Abweichung', alarme.length >= 3, alarme.length + ' Meldungen');
  if (alarme.length) console.log('     "' + String(alarme[0].body.text).split('\n').slice(0, 3).join(' | ') + '"');

  console.log('\n' + '─'.repeat(72));
  console.log(alles ? 'ERGEBNIS: ✅ Alle Handler verhalten sich wie vorgesehen.' : 'ERGEBNIS: ❌ siehe oben');
  process.exit(alles ? 0 : 1);
})();
