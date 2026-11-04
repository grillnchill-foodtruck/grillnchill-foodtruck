/**
 * sumup-webhook.js
 * ----------------------------------------------------------------------------
 * Realtime-Abschluss von Online-Zahlungen.
 *
 * SumUp ruft diese URL auf, sobald sich der Status eines Checkouts ändert
 * (return_url beim Anlegen des Checkouts, siehe sumup-checkout.js). Damit
 * werden Bestellbestätigung, Inhaber-Mail, Telegram und Archiv-Eintrag
 * SEKUNDEN nach der Zahlung ausgelöst – unabhängig davon, ob der Kunde zur
 * Website zurückkehrt.
 *
 * Sicherheit: Dem Webhook-Payload wird NICHT vertraut. Es wird ausschließlich
 * die Checkout-ID entnommen und der echte Status direkt bei der SumUp-API
 * verifiziert (gleicher API-Key wie sumup-checkout). Benachrichtigt wird nur,
 * wenn der Archiv-Eintrag noch "pending" ist; send-email ist zusätzlich
 * idempotent – doppelte Zustellung ist damit zweifach ausgeschlossen.
 *
 * Kette der Sicherheitsnetze: Webhook (Sekunden) → Kunden-Rückkehr (sofort)
 * → orders-reconcile (alle 5 Minuten).
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { internHeader } = require('./lib/bremse');

const SUMUP_API_BASE = 'https://api.sumup.com/v0.1';

const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});

function store() {
  const opts = { name: 'orders', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}


// Tages-Umsatz-Aggregat fortschreiben (Basis der Admin-Umsatzübersicht)
async function addRevenue(s, patch) {
  try {
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const key = 'rev:' + d;
    const agg = (await s.get(key, { type: 'json' })) || {
      oCount: 0, oTotal: 0, pickupCount: 0, pickupTotal: 0,
      deliveryCount: 0, deliveryTotal: 0, gcCount: 0, gcTotal: 0,
    };
    for (const [k, v] of Object.entries(patch)) {
      agg[k] = Math.round(((agg[k] || 0) + v) * 100) / 100;
    }
    await s.setJSON(key, agg);
  } catch (e) {}
}

exports.handler = async (event) => {
  // SumUp sendet POST; GET mit ?id= erlaubt manuelles Anstoßen zum Testen
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch (e) {}
  const q = event.queryStringParameters || {};
  const checkoutId = body.id || body.checkout_id || (body.payload && body.payload.id) || q.id || null;

  if (!checkoutId) return json(200, { ok: true, ignored: 'no_checkout_id' });
  const apiKey = process.env.SUMUP_API_KEY;
  if (!apiKey) return json(200, { ok: false, error: 'not_configured' });

  try {
    // Echten Status bei SumUp verifizieren – Payload wird nie geglaubt
    const res = await fetch(`${SUMUP_API_BASE}/checkouts/${encodeURIComponent(checkoutId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) return json(200, { ok: true, ignored: 'lookup_failed' });

    const status = String(data.status || '').toUpperCase();
    const reference = String(data.checkout_reference || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 60);
    if (!reference) return json(200, { ok: true, ignored: 'no_reference' });

    // Catering-Anzahlung (GNC-AN-…): liegt im Store "catering", eigene Logik
    if (/^GNC-AN-/.test(reference)) return json(200, await require('./lib/catering-angebot').zahlungVerbuchen(data, 'webhook'));

    const s = store();
    const key = 'o:' + reference;
    const rec = await s.get(key, { type: 'json' });
    if (!rec) return json(200, { ok: true, ignored: 'unknown_order', reference });

    if (status === 'PAID') {
      // Idempotenz: Erledigtes nie doppelt erfüllen. ABER: Eine echte Zahlung
      // schlägt jede Stornierung – storniert/abgebrochen wird bei PAID wiederbelebt
      // (Supersede/Admin-Storno können so niemals eine bezahlte Bestellung verlieren).
      if (rec.status === 'completed' || rec.status === 'refunded') {
        return json(200, { ok: true, ignored: 'already_' + rec.status, reference });
      }
      if (rec.status === 'cancelled' || rec.status === 'abandoned') {
        rec.status = 'pending'; // Wiederbelebung dokumentieren
        rec.revivedAt = new Date().toISOString();
        rec.revivedFrom = rec.cancelledAt ? 'cancelled' : 'abandoned';
        try { await s.setJSON(key, rec); } catch (e) {}
      }
      const siteUrl = (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');

      // ---- Burger-Pass: Pass ausstellen, Menüs gutschreiben (genau einmal) ----
      if (rec.kind === 'burgerpass' && rec.bp) {
        const { kaufAbschliessen } = require('./lib/burger-pass');
        const r = await kaufAbschliessen(s, key, rec);
        return json(200, { ok: true, reference, action: r.neu ? 'pass_issued' : 'pass_exists' });
      }

      // ---- Geschenkgutschein: genau einen Code ausstellen, Mails, Zustellung (lib/geschenk.js) ----
      if (rec.kind === 'giftcard' && rec.gift) {
        const { ausstellen } = require('./lib/geschenk');
        const r = await ausstellen(rec, { os: s, key, quelle: 'Shop (Online-Kauf)', umsatz: addRevenue });
        if (r.doppelt) return json(200, { ok: true, reference, action: 'giftcard_exists', code: r.code });
        return json(200, { ok: true, reference, action: r.mailOk ? 'giftcard_issued' : 'giftcard_mail_failed', code: r.code });
      }

      // ---- Normale Bestellung: Benachrichtigungen auslösen (send-email hebt auf "completed") ----
      const notify = await fetch(siteUrl + '/.netlify/functions/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...internHeader() },
        // internalSecret: bindet die Treue-/Umsatz-Gutschrift an den verifizierten Zahlungseingang (S1/S4).
        body: JSON.stringify({ type: 'order_confirmation', order: rec.order, internalSecret: process.env.INTERNAL_HOOK_SECRET || undefined }),
      });
      return json(200, { ok: true, reference, action: notify.ok ? 'notified' : 'notify_failed' });
    }

    if (status === 'FAILED' || status === 'EXPIRED') {
      if (rec.status === 'pending') {
        rec.status = 'abandoned';
        rec.abandonedAt = new Date().toISOString();
        rec.payStatus = status;
        try { await s.setJSON(key, rec); } catch (e) {}
      }
      return json(200, { ok: true, reference, action: 'marked_abandoned' });
    }

    return json(200, { ok: true, reference, status });
  } catch (e) {
    // Immer 200: SumUp soll nicht endlos retryen – reconcile fängt Rest auf
    return json(200, { ok: false, error: String((e && e.message) || e) });
  }
};
