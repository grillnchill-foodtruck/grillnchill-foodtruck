/**
 * giftcard-checkout.js
 * ----------------------------------------------------------------------------
 * Verkauf von Geschenkgutscheinen (Seite /gutscheine).
 *
 *   POST { amount, email, buyerName?, recipientName? }
 *   → { id, hosted_checkout_url, reference }
 *
 * Ablauf: SumUp-Checkout anlegen → Vorgang als "pending" (kind: giftcard) im
 * Bestell-Store sichern → Kunde zahlt bei SumUp → sumup-webhook (Realtime)
 * bzw. orders-reconcile (5-Min-Netz) erzeugen nach Zahlungseingang automatisch
 * den Gutschein-Code (Store vouchers, Prefix c:) und mailen ihn dem Käufer.
 * Es wird pro Vorgang genau EIN Code erzeugt (Idempotenz über status=pending).
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');

const SUMUP_API_BASE = 'https://api.sumup.com/v0.1';
const MIN_AMOUNT = 10;
const MAX_AMOUNT = 200;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify(data),
});

function ordersStore() {
  const opts = { name: 'orders', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  const apiKey = process.env.SUMUP_API_KEY;
  const merchantCode = process.env.SUMUP_MERCHANT_CODE;
  if (!apiKey || !merchantCode) return json(500, { error: 'not_configured' });

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }

  // Stiller Rückzieher: Kunde ist aus dem SumUp-Fenster zurückgekehrt, ohne zu zahlen.
  // Der Vorgang wird storniert, als hätte es ihn nie gegeben (kein Phantom im Admin).
  // Sicherheit: Referenz + geheime Checkout-ID müssen passen; nur Status 'pending';
  // und sollte doch noch eine Zahlung eintreffen, belebt der Webhook den Vorgang wieder.
  if (input.cancelOnly === true) {
    try {
      const sup = input.supersedes || {};
      if (typeof sup.reference === 'string' && /^GNC-GC-/.test(sup.reference) && sup.checkoutId) {
        const okey = 'o:' + sup.reference.replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
        const old = await ordersStore().get(okey, { type: 'json' });
        if (old && old.status === 'pending' && old.checkoutId === sup.checkoutId) {
          old.status = 'cancelled';
          old.cancelledAt = new Date().toISOString();
          old.cancelReason = 'user_back';
          await ordersStore().setJSON(okey, old);
          return json(200, { ok: true, cancelled: true });
        }
      }
      return json(200, { ok: true, cancelled: false });
    } catch (e) {
      return json(200, { ok: true, cancelled: false });
    }
  }

  const amount = Math.round(parseFloat(input.amount) || 0);
  if (amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
    return json(400, { error: 'bad_amount', hint: `Betrag: ${MIN_AMOUNT}–${MAX_AMOUNT} € in ganzen Euro` });
  }
  const email = String(input.email || '').trim().toLowerCase().slice(0, 120);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: 'bad_email' });
  const buyerName = String(input.buyerName || '').replace(/[<>]/g, '').trim().slice(0, 40);
  const recipientName = String(input.recipientName || '').replace(/[<>]/g, '').trim().slice(0, 40);

  const siteUrl = (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');
  const reference = 'GNC-GC-' + Date.now();

  const payload = {
    checkout_reference: reference,
    amount,
    currency: 'EUR',
    merchant_code: merchantCode,
    description: `Grilln Chill Geschenkgutschein ${amount} EUR` + (buyerName ? ` - ${buyerName}` : ''),
    return_url: `${siteUrl}/.netlify/functions/sumup-webhook`,
    redirect_url: `${siteUrl}/gutscheine.html?payment=return`,
    hosted_checkout: { enabled: true },
  };

  try {
    const response = await fetch(`${SUMUP_API_BASE}/checkouts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || !data.id) {
      return json(502, { error: 'sumup_error', detail: data });
    }

    // Vorgang für Webhook/Abgleich sichern (Erfüllung passiert NACH Zahlung)
    await ordersStore().setJSON('o:' + reference, {
      status: 'pending',
      kind: 'giftcard',
      createdAt: new Date().toISOString(),
      checkoutId: data.id,
      gift: { amount, email, buyerName, recipientName },
    });

    // Vorherigen, nicht bezahlten Gutschein-Versuch stornieren (Referenz + geheime ID müssen passen)
    try {
      const sup = input.supersedes;
      if (sup && typeof sup.reference === 'string' && /^GNC-GC-/.test(sup.reference) && sup.checkoutId) {
        const okey = 'o:' + sup.reference.replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
        const old = await ordersStore().get(okey, { type: 'json' });
        if (old && old.status === 'pending' && old.checkoutId === sup.checkoutId) {
          old.status = 'cancelled';
          old.cancelledAt = new Date().toISOString();
          old.cancelReason = 'superseded';
          await ordersStore().setJSON(okey, old);
        }
      }
    } catch (e) {}

    return json(200, { id: data.id, hosted_checkout_url: data.hosted_checkout_url || null, reference });
  } catch (e) {
    return json(502, { error: 'request_failed', detail: String((e && e.message) || e) });
  }
};
