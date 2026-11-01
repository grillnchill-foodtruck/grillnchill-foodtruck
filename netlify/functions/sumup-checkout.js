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
const { pruefeUndKorrigiere } = require('./lib/preisberechnung');
const { schutz, saeubern, grenzen } = require('./lib/bremse');
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
  // Grundschutz: Anfragen je Absender und Größe begrenzen (lib/bremse.js)
  const bremseHalt = await schutz(event, { name: 'kasse', max: 20, maxKB: 96 });
  if (bremseHalt) return bremseHalt;
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
  //  GET: früher eine öffentliche Statusseite zur SumUp-Einrichtung.
  //  Die Einstellungen stehen in Netlify, nicht im offenen Netz.
  if (event.httpMethod === 'GET') {
    return json(200, { ok: true });
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
    input = saeubern(JSON.parse(event.body || '{}'), { maxText: 4000 });

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

  // Je E-Mail, je Telefon und Notbremse über alle Absender (lib/bremse.js,
  // GRENZEN.kasse). Erst hier, damit der Rückzieher (cancelOnly) nicht zählt.
  {
    const o = (input.order && typeof input.order === 'object') ? input.order : {};
    const k = (input.customer && typeof input.customer === 'object') ? input.customer : {};
    const kassenHalt = await grenzen(event, 'kasse', { mail: o.email || k.email, tel: o.phone || k.phone });
    if (kassenHalt) return kassenHalt;
  }

  // Der belastete Betrag wird SERVERSEITIG aus dem Warenkorb nachgerechnet.
  //
  // Vorher wurde order.total übernommen (mit input.amount als Gegenprobe).
  // Beide Zahlen kamen aus dem Browser des Kunden und liessen sich in der
  // Anfrage frei setzen – eine veränderte Anfrage konnte 1 € für einen
  // 50-€-Warenkorb zahlen. Die Gegenprobe half nicht, weil sie zwei Werte
  // derselben, nicht vertrauenswürdigen Seite verglich.
  //
  // lib/preisberechnung.js baut den Preis aus cartSnapshot und speisekarte.js
  // neu auf – derselben Datei, die auch der Browser lädt. Kann sie nicht
  // sicher rechnen, bleibt es beim gemeldeten Betrag: ein Bestellabbruch ist
  // teurer als ein Betrugsversuch. Details im Kopf jener Datei.
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
  let treueFreigabe = null;   // geprüfte Treue-Art, kommt ins Archiv (siehe preisberechnung.js)
  if (input.order && typeof input.order === 'object') {
    // Schreibt den geprüften Betrag in input.order zurück, damit Archiv,
    // Ticket und Mail dieselbe Zahl zeigen wie die Belastung.
    const preis = await pruefeUndKorrigiere(input.order);
    if (preis && preis.sicher) amount = preis.betrag;
    if (preis && preis.treueFreigabe) treueFreigabe = preis.treueFreigabe;
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

  /* „Bezahlen ohne Umweg“: Der Browser möchte das SumUp-Widget direkt in der
     Kasse zeigen. Ob das erlaubt ist, entscheidet der Admin-Schalter hier im
     Server, nicht der Browser. Steht er aus (Werkszustand) oder ist er nicht
     lesbar, bekommt der Browser wie bisher die gehostete SumUp-Seite. */
  let zahlweg = 'weiterleitung';
  if (input.zahlweg === 'widget') {
    try {
      const e = await require('./lib/zahl-einstellungen').lesen();
      if (e.direktZahlung) zahlweg = 'widget';
    } catch (e) { zahlweg = 'weiterleitung'; }
  }

  const payload = {
    checkout_reference: reference,
    amount: Math.round(amount * 100) / 100,
    currency: 'EUR',
    merchant_code: merchantCode,
    description,
    // return_url = Server-Callback von SumUp (Realtime-Statusmeldung → Webhook),
    // redirect_url = Browser-Rückkehr des Kunden nach der Zahlung.
    return_url:   `${returnUrl}/.netlify/functions/sumup-webhook`,
    redirect_url: `${returnUrl}/index.html?payment=return&ref=${encodeURIComponent(reference)}`
      + (input.appMode ? '&app=1' : ''),   // App-Ansicht nach der Rueckkehr behalten
    hosted_checkout: { enabled: true },
  };
  if (zahlweg === 'widget') {
    /* Widget: keine gehostete Seite. Ohne redirect_url zeigt das Widget eine
       3-D-Secure-Abfrage der Bank im Rahmen auf unserer Seite, statt die ganze
       Seite zur Bank zu schicken (SumUp-Doku: Checkouts erstellen). Der Abschluss
       läuft wie bisher über return_url (Webhook) und sumup-status. */
    delete payload.hosted_checkout;
    delete payload.redirect_url;
  }

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
            zahlweg,
            treueFreigabe,
            quelle: 'online',   // Abholnummer vergibt erst send-email nach der Zahlung
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

    // Google Pay im Widget: Händler-ID von Google (öffentlich, kein Geheimnis).
    // Ohne sie nutzt das Widget die Voreinstellung von SumUp.
    const gpId = String(process.env.GOOGLE_PAY_MERCHANT_ID || '').trim();
    return json(200, {
      id: data?.id || null,
      hosted_checkout_url: data?.hosted_checkout_url || null,
      reference,
      zahlweg,
      ...(zahlweg === 'widget' && gpId ? { googlePay: { merchantId: gpId, merchantName: "Grill'n Chill" } } : {}),
    });
  } catch (err) {
    { console.error('SumUp:', err.message); return json(502, { error: 'SumUp request failed' }); }
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
