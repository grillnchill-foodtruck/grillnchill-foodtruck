/**
 * ============================================================
 *  GRILL'N CHILL – SumUp Hosted Checkout (Netlify Function)
 * ============================================================
 *
 *  Diese Datei läuft als serverlose Funktion auf Netlify.
 *  Sie ersetzt die PHP-Datei – Netlify unterstützt kein PHP.
 *
 *
 *  SETUP IN 3 SCHRITTEN:
 *  ====================
 *
 *  1. SUMUP-DATEN HOLEN
 *     - Login auf https://developer.sumup.com
 *     - Sandbox-Account anlegen unter "Developer Settings" → "Sandboxes"
 *     - Oben rechts zum Sandbox-Account wechseln
 *     - API-Key erstellen unter "Developer Settings" → "API Keys"
 *     - Merchant Code aus "Profile/Settings" notieren
 *
 *  2. ENVIRONMENT VARIABLES BEI NETLIFY EINTRAGEN
 *     - Netlify-Dashboard öffnen → Site Settings → Environment Variables
 *     - Folgende Variablen anlegen:
 *
 *       SUMUP_API_KEY        = sup_sk_xxx... (dein API-Key)
 *       SUMUP_MERCHANT_CODE  = MXXXXXX (dein Merchant-Code)
 *       SUMUP_SANDBOX        = true (für Tests) oder false (Live)
 *
 *     - Site neu deployen, damit die Variablen aktiv werden
 *
 *  3. TEST IM BROWSER
 *     - Gehe zu: https://deine-domain.netlify.app/.netlify/functions/sumup-checkout
 *     - Du siehst eine Status-Seite mit ✓ / ✗ Checks
 *
 *
 *  TESTKARTEN (Sandbox-Modus, Stand 2026):
 *  - Erfolgreich (Visa):    4200 0000 0000 0091
 *  - Erfolgreich (Mastercard): 5200 0000 0000 0007
 *  - Fehlgeschlagen:        Bestellbetrag auf 11.00 €, 42.01 €, 42.76 € oder 42.91 €
 *  - CVV:                   beliebige 3 Ziffern (z.B. 123)
 *  - Ablauf:                beliebiges zukünftiges Datum (z.B. 12/30)
 *
 * ============================================================
 */

const SUMUP_API_BASE = 'https://api.sumup.com/v0.1';

// Helper: JSON response
// Bestell-Archiv: eingehende Online-Zahlungen als "pending" sichern, damit eine
// bezahlte Bestellung auch dann nachverfolgbar ist, wenn der Kunde nach der
// Zahlung nicht zur Website zurückkehrt (Abgleich: orders-reconcile.js).
const { getStore } = require('@netlify/blobs');
function ordersStore() {
  const opts = { name: 'orders', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

const json = (statusCode, body, extraHeaders = {}) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extraHeaders,
  },
  body: JSON.stringify(body),
});

// Helper: HTML response
const html = (statusCode, htmlBody) => ({
  statusCode,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
  body: htmlBody,
});

exports.handler = async (event) => {
  const apiKey       = process.env.SUMUP_API_KEY || '';
  const merchantCode = process.env.SUMUP_MERCHANT_CODE || '';
  const sandboxMode  = (process.env.SUMUP_SANDBOX || 'true').toLowerCase() === 'true';
  const returnUrl    = process.env.URL || 'https://grillnchill-foodtruck.de'; // Netlify setzt URL automatisch

  // ============================================================
  //  CORS Preflight
  // ============================================================
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }, body: '' };
  }

  // ============================================================
  //  GET: Status-Seite zur Konfigurations-Überprüfung
  // ============================================================
  if (event.httpMethod === 'GET') {
    const apiKeySet   = apiKey.length > 10 && !apiKey.startsWith('HIER_');
    const merchantSet = merchantCode.length > 3 && !merchantCode.startsWith('HIER_');
    const allOk       = apiKeySet && merchantSet;

    return html(200, `<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8"><title>SumUp Backend Status</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0A0A0A;color:#F5E9D0;
       margin:0;padding:2rem;line-height:1.6}
  .box{max-width:600px;margin:2rem auto;background:#141414;border:1px solid #2A2520;
       border-radius:14px;padding:2rem}
  h1{color:#F5E9D0;margin:0 0 1.5rem}
  .row{display:flex;justify-content:space-between;padding:0.7rem 0;border-bottom:1px solid #2A2520}
  .ok{color:#6DBE45;font-weight:700}
  .fail{color:#E04848;font-weight:700}
  .pending{color:#FFC93C;font-weight:700}
  .summary{margin-top:1.5rem;padding:1rem;border-radius:8px;font-weight:700;text-align:center}
  .summary.ok{background:rgba(109,190,69,0.12);color:#6DBE45;border:1px solid #6DBE45}
  .summary.fail{background:rgba(224,72,72,0.12);color:#E04848;border:1px solid #E04848}
  small{color:#9A8E7A}
  code{background:#252220;padding:2px 6px;border-radius:4px;font-size:0.85em}
</style></head><body><div class="box">
<h1>🍔 SumUp Backend Status (Netlify)</h1>
<div class="row"><span>Plattform</span><span class="ok">Netlify Functions</span></div>
<div class="row"><span>Node-Version</span><span class="ok">${process.version}</span></div>
<div class="row"><span>SUMUP_API_KEY gesetzt</span><span class="${apiKeySet?'ok':'fail'}">${apiKeySet?'✓ JA':'✗ NEIN'}</span></div>
<div class="row"><span>SUMUP_MERCHANT_CODE gesetzt</span><span class="${merchantSet?'ok':'fail'}">${merchantSet?'✓ JA':'✗ NEIN'}</span></div>
<div class="row"><span>Modus</span><span class="${sandboxMode?'pending':'ok'}">${sandboxMode?'🧪 SANDBOX (Tests)':'🟢 LIVE (echte Zahlungen)'}</span></div>
<div class="row"><span>Return-URL</span><span><small>${escapeHtml(returnUrl)}</small></span></div>
<div class="summary ${allOk?'ok':'fail'}">${allOk
    ? '✓ Alles bereit. Du kannst jetzt im Bestellterminal "Online bezahlen" wählen.'
    : '✗ Konfiguration unvollständig. Trage SUMUP_API_KEY und SUMUP_MERCHANT_CODE in Netlify → Site Settings → Environment Variables ein und deploye neu.'}</div>
<p style="margin-top:1.5rem;color:#9A8E7A;font-size:0.85rem">
  Diese Seite siehst NUR du. Sie ist nicht über die Website verlinkt.<br>
  Endpunkt-URL: <code>/.netlify/functions/sumup-checkout</code>
</p>
</div></body></html>`);
  }

  // ============================================================
  //  POST: Checkout erstellen
  // ============================================================
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  // Konfig-Check
  if (!apiKey || apiKey.startsWith('HIER_') || !merchantCode || merchantCode.startsWith('HIER_')) {
    return json(500, {
      error: 'SumUp-Backend nicht konfiguriert',
      hint:  'Bitte SUMUP_API_KEY und SUMUP_MERCHANT_CODE in Netlify Environment Variables eintragen.'
    });
  }

  let input;
  try {
    input = JSON.parse(event.body || '{}');

  // Stiller Rückzieher: Kunde ist aus dem SumUp-Fenster zurückgekehrt, ohne zu zahlen.
  // Der Vorgang wird storniert, als hätte es ihn nie gegeben (kein Phantom im Admin).
  // Sicherheit: Referenz + geheime Checkout-ID müssen passen; nur Status 'pending';
  // und sollte doch noch eine Zahlung eintreffen, belebt der Webhook den Vorgang wieder.
  if (input.cancelOnly === true) {
    try {
      const sup = input.supersedes || {};
      if (typeof sup.reference === 'string' && /^GNC-/.test(sup.reference) && sup.checkoutId) {
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
  } catch (e) {
    return json(400, { error: 'Invalid JSON body' });
  }

  // S2: Der belastete Betrag wird verbindlich aus dem Bestellwert (order.total) abgeleitet.
  //     Einem separaten, frei manipulierbaren input.amount wird NICHT allein vertraut – sonst
  //     ließe sich z. B. 1 € für eine 50-€-Bestellung zahlen (Befund S2). Weichen amount und
  //     order.total voneinander ab, ist der Bestellwert maßgeblich.
  const hasOrderTotal = input.order && typeof input.order === 'object'
    && typeof input.order.total === 'number' && isFinite(input.order.total);
  if (!input.amount && !hasOrderTotal) {
    return json(400, { error: 'Missing amount' });
  }
  let amount = Math.round(parseFloat(input.amount) * 100) / 100;
  if (hasOrderTotal) {
    const orderTotal = Math.round(input.order.total * 100) / 100;
    if (isNaN(amount) || Math.abs(amount - orderTotal) > 0.01) {
      amount = orderTotal;
    }
  }
  if (isNaN(amount) || amount < 1.0 || amount > 500.0) {
    return json(400, { error: 'Amount out of bounds', hint: 'Betrag muss zwischen 1 und 500 € liegen' });
  }

  const reference = (input.reference || `GNC-${Date.now()}`)
    .replace(/[^A-Za-z0-9-]/g, '')
    .substring(0, 90);
  const description = (input.description || 'Grilln Chill Bestellung')
    .replace(/<[^>]*>/g, '')
    .substring(0, 100);
  const customer = input.customer || {};

  const payload = {
    checkout_reference: reference,
    amount: Math.round(amount * 100) / 100,
    currency: 'EUR',
    merchant_code: merchantCode,
    description,
    // return_url = Server-Callback von SumUp (Realtime-Statusmeldung → Webhook),
    // redirect_url = Browser-Rückkehr des Kunden nach der Zahlung.
    return_url:   `${returnUrl}/.netlify/functions/sumup-webhook`,
    redirect_url: `${returnUrl}/index.html?payment=return&ref=${encodeURIComponent(reference)}`,
    hosted_checkout: { enabled: true },
  };

  // SumUp's `customer_id` Feld erwartet eine vorher angelegte SumUp-Customer-ID,
  // nicht eine beliebige E-Mail. Daher senden wir es nicht mit.
  // Die Liefer-/Abholdaten (Name, Adresse, Telefon, Artikel, Notiz) stehen
  // im `description`-Feld und erscheinen so in der SumUp-Transaktion/im Dashboard.

  // SumUp API aufrufen
  try {
    const response = await fetch(`${SUMUP_API_BASE}/checkouts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      // SumUp liefert Validierungsfehler oft als Array: [{ message, error_code, param }]
      // oder als Objekt { message } / { error_message }. Beides auswerten, damit das
      // konkrete Feld sichtbar wird statt "Unknown".
      let detail = '';
      if (Array.isArray(data)) {
        detail = data
          .map(e => [e.param, e.message || e.error_code].filter(Boolean).join(': '))
          .filter(Boolean)
          .join(' · ');
      } else if (data && typeof data === 'object') {
        detail = data.message || data.error_message || data.error || data.detail || '';
        if (data.param) detail = `${data.param}: ${detail}`;
      }

      return json(response.status, {
        error: 'SumUp returned error',
        status: response.status,
        body: data,
        hint: response.status === 401
          ? 'Ungültiger API-Key. Bitte SUMUP_API_KEY prüfen (Tippfehler/Leerzeichen, und Sandbox- vs. Live-Key).'
          : response.status === 403
            ? 'Merchant-Code stimmt nicht oder Payments-Scope nicht aktiviert (bei SumUp anfragen).'
            : `Fehler ${response.status}${detail ? ' – ' + detail : ' (keine Detailangabe von SumUp)'}`,
      });
    }

    // Bestellung als "pending" archivieren (best effort – Zahlung geht immer vor)
    try {
      if (input.order && typeof input.order === 'object') {
        const raw = JSON.stringify(input.order);
        if (raw.length < 60000) {
          const order = JSON.parse(raw);
          order.reference = reference; // finale, bereinigte Referenz
          await ordersStore().setJSON('o:' + reference, {
            status: 'pending',
            createdAt: new Date().toISOString(),
            checkoutId: (data && data.id) || null,
            order,
          });
        }
      }
    } catch (e) {}

    // Ersetzt dieser Checkout einen vorherigen, nicht bezahlten Versuch?
    // (Kunde ist aus dem SumUp-Fenster zurück und bestellt neu.)
    // Sicherheit: Referenz UND geheime Checkout-ID müssen übereinstimmen.
    try {
      const sup = input.supersedes;
      if (sup && typeof sup.reference === 'string' && /^GNC-/.test(sup.reference) && sup.checkoutId) {
        const okey = 'o:' + sup.reference.replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
        const old = await ordersStore().get(okey, { type: 'json' });
        if (old && old.status === 'pending' && old.checkoutId === sup.checkoutId) {
          old.status = 'cancelled';
          old.cancelledAt = new Date().toISOString();
          old.cancelReason = 'superseded';
          await ordersStore().setJSON(okey, old);
        }
      }
    } catch (e) { /* Aufräumen darf den Checkout nie blockieren */ }

    return json(200, {
      id: data?.id || null,
      hosted_checkout_url: data?.hosted_checkout_url || null,
      reference,
    });
  } catch (err) {
    return json(502, { error: 'SumUp request failed', detail: err.message });
  }
};

// HTML-escape helper für die Status-Seite
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
