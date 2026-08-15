/**
 * ============================================================
 *  GRILL'N CHILL – SumUp Checkout-Status prüfen (Netlify Function)
 * ============================================================
 *
 *  Wird nach der Rückkehr von der SumUp-Zahlungsseite aufgerufen.
 *  Liefert den echten Status eines Checkouts zurück, damit die
 *  Bestellung NUR dann als bezahlt gilt, wenn SumUp "PAID" meldet.
 *
 *  Aufruf:  GET /.netlify/functions/sumup-status?id=<checkout_id>
 *  Antwort: { id, status }   (status z. B. PENDING | PAID | FAILED | EXPIRED)
 *
 *  Nutzt dieselbe SUMUP_API_KEY Environment Variable wie sumup-checkout.
 * ============================================================
 */

const SUMUP_API_BASE = 'https://api.sumup.com/v0.1';

const json = (statusCode, body) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }, body: '' };
  }

  const apiKey = process.env.SUMUP_API_KEY || '';
  if (!apiKey || apiKey.startsWith('HIER_')) {
    return json(500, { error: 'SumUp-Backend nicht konfiguriert' });
  }

  const id = (event.queryStringParameters && event.queryStringParameters.id) || '';
  if (!id) {
    return json(400, { error: 'Missing checkout id' });
  }

  try {
    const response = await fetch(`${SUMUP_API_BASE}/checkouts/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return json(response.status, { error: 'SumUp returned error', status: response.status, body: data });
    }

    return json(200, {
      id: data?.id || id,
      status: data?.status || 'UNKNOWN',
      transaction_code: (Array.isArray(data?.transactions) && data.transactions[0] && data.transactions[0].transaction_code) || null,
      // Zahlungsmittel für die Rechnung: Kartenart und die letzten vier Ziffern
      card: (() => {
        const tx = Array.isArray(data?.transactions) ? data.transactions[0] : null;
        if (!tx) return null;
        const c = tx.card || {};
        return {
          type: c.type || tx.payment_type || null,          // VISA, MASTERCARD, ...
          last4: c.last_4_digits || c.last4 || null,
          entry: tx.entry_mode || null,                     // z. B. CUSTOMER_ENTRY
        };
      })(),
    });
  } catch (err) {
    return json(502, { error: 'SumUp request failed', detail: err.message });
  }
};
