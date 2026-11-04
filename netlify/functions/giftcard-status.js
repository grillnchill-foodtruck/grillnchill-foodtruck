/**
 * giftcard-status.js
 * ----------------------------------------------------------------------------
 * Danke-Ansicht der Gutscheinseite nach der Rückkehr von SumUp.
 *
 *   GET ?ref=GNC-GC-…&id=<SumUp-Checkout-ID>
 *   → { state: 'pending' }
 *   → { state: 'paid', code, amount, validUntil, recipientName, delivery,
 *       sendOn, recipientMailed, pdf, pdfDownload }
 *   → { state: 'failed' }
 *
 * Den Code sieht nur, wer Referenz UND geheime Checkout-ID kennt; beides
 * liegt nur im Browser der Käuferin (sessionStorage). Ist die Zahlung bei
 * SumUp durch, der Webhook aber noch nicht da, stößt diese Funktion ihn an
 * (er prüft selbst bei SumUp nach und stellt genau einmal aus).
 * ----------------------------------------------------------------------------
 */

const { schutz, internHeader } = require('./lib/bremse');
const geschenk = require('./lib/geschenk');

const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(data),
});

exports.handler = async (event) => {
  const halt = await schutz(event, { name: 'gutscheinstatus', max: 120, maxKB: 4 });
  if (halt) return halt;
  if (event.httpMethod !== 'GET') return json(405, { error: 'method_not_allowed' });
  const q = event.queryStringParameters || {};
  const ref = String(q.ref || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
  const id = String(q.id || '').slice(0, 80);
  if (!/^GNC-GC-\d+$/.test(ref) || !id) return json(400, { error: 'bad_request' });

  const os = geschenk.store('orders');
  const key = 'o:' + ref;
  let rec = await os.get(key, { type: 'json' });
  if (!rec || rec.kind !== 'giftcard' || rec.checkoutId !== id) return json(404, { error: 'not_found' });

  if (rec.status !== 'completed') {
    if (rec.status === 'refunded') return json(200, { state: 'failed' });
    // Live bei SumUp nachsehen; bei PAID den Webhook anstoßen
    const apiKey = process.env.SUMUP_API_KEY;
    let status = '';
    if (apiKey) {
      try {
        const r = await fetch('https://api.sumup.com/v0.1/checkouts/' + encodeURIComponent(id), { headers: { Authorization: 'Bearer ' + apiKey } });
        const d = await r.json().catch(() => null);
        if (r.ok && d) status = String(d.status || '').toUpperCase();
      } catch (e) {}
    }
    if (status === 'FAILED' || status === 'EXPIRED') return json(200, { state: 'failed' });
    // PENDING bei SumUp: nicht bezahlt (zurück ohne Zahlung). Leer: SumUp nicht erreichbar.
    if (status === 'PENDING') return json(200, { state: 'open' });
    if (status !== 'PAID') return json(200, { state: 'pending' });
    try {
      await fetch(geschenk.seite() + '/.netlify/functions/sumup-webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...internHeader() },
        body: JSON.stringify({ id }),
      });
    } catch (e) {}
    rec = await os.get(key, { type: 'json' });
    if (!rec || rec.status !== 'completed' || !rec.code) return json(200, { state: 'pending' });
  }

  const d = await geschenk.store('vouchers').get('gd:' + rec.code, { type: 'json' });
  if (!d) {
    // Kauf vor der neuen Gutscheinseite: Code ohne Geschenk-Daten
    const g = rec.gift || {};
    return json(200, { state: 'paid', code: rec.code, amount: g.amount, recipientName: g.recipientName || '', delivery: 'self' });
  }
  return json(200, { state: 'paid', ...geschenk.kaeuferSicht(d) });
};
