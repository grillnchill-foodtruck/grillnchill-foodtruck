/**
 * ============================================================
 *  GRILL'N CHILL – Status-Update Handler (Netlify Function)
 * ============================================================
 *
 *  Diese Funktion wird über die Buttons in Pasquales
 *  Owner-Notification-Mail aufgerufen.
 *
 *  Aufruf-URL:
 *  /.netlify/functions/status-update?ref=GNC-123&status=on_the_way&token=...&order={...}
 *
 *  → Sendet die Status-Update-Mail an den Kunden
 *  → Zeigt Pasquale eine Bestätigungsseite
 *
 *  Schutz: Der `token` muss mit STATUS_UPDATE_SECRET übereinstimmen,
 *  damit niemand ohne Zugang Status-Updates auslösen kann.
 * ============================================================
 */

const VALID_STATUSES = ['preparing', 'on_the_way', 'ready_for_pickup', 'delivered'];

const STATUS_LABELS = {
  preparing:        { emoji: '👨‍🍳', name: 'In Zubereitung' },
  on_the_way:       { emoji: '🛵', name: 'Unterwegs' },
  ready_for_pickup: { emoji: '✅', name: 'Abholbereit' },
  delivered:        { emoji: '🎉', name: 'Geliefert' },
};

function htmlPage(title, message, color = '#6DBE45') {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Grilln Chill</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;background:#0A0A0A;color:#F5E9D0;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;line-height:1.6}
  .box{max-width:500px;width:100%;background:#141414;border:1px solid #2A2520;border-radius:14px;padding:40px 30px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,0.4)}
  h1{margin:0 0 16px;color:${color};font-size:24px}
  p{margin:8px 0;color:#ccc}
  small{color:#888;font-size:13px}
  .icon{font-size:64px;margin-bottom:14px}
  a{color:#E85A24;text-decoration:none;font-weight:600}
</style></head><body>
<div class="box">
  ${message}
</div>
</body></html>`,
  };
}

exports.handler = async (event) => {
  const statusSecret = process.env.STATUS_UPDATE_SECRET || '';
  const siteUrl      = process.env.URL || 'https://grillnchill-foodtruck.de';

  const params = event.queryStringParameters || {};
  const { ref, status, token, order: orderEncoded } = params;

  // Token-Check
  if (!statusSecret || token !== statusSecret) {
    return htmlPage('Zugriff verweigert',
      `<div class="icon">🔒</div>
       <h1 style="color:#E04848">Zugriff verweigert</h1>
       <p>Der Sicherheits-Token ist ungültig oder fehlt.</p>
       <small>Dieser Link wurde aus einer E-Mail an den Inhaber generiert.</small>`,
      '#E04848');
  }

  // Status-Check
  if (!VALID_STATUSES.includes(status)) {
    return htmlPage('Ungültiger Status',
      `<div class="icon">⚠️</div>
       <h1 style="color:#E04848">Ungültiger Status</h1>
       <p>Status "${status}" wird nicht unterstützt.</p>`,
      '#E04848');
  }

  if (!ref || !orderEncoded) {
    return htmlPage('Fehler',
      `<div class="icon">⚠️</div>
       <h1 style="color:#E04848">Fehlende Bestelldaten</h1>
       <p>Bestell-Referenz oder Bestelldaten fehlen.</p>`,
      '#E04848');
  }

  let order;
  try {
    order = JSON.parse(decodeURIComponent(orderEncoded));
  } catch (e) {
    return htmlPage('Fehler',
      `<div class="icon">⚠️</div>
       <h1 style="color:#E04848">Bestelldaten beschädigt</h1>
       <p>Die Bestelldaten konnten nicht gelesen werden.</p>`,
      '#E04848');
  }

  // Status-Mail an Kunde senden (ruft die andere Function intern auf)
  try {
    const sendResponse = await fetch(`${siteUrl}/.netlify/functions/send-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'status_update',
        status,
        order: { ...order, reference: ref },
      }),
    });

    if (!sendResponse.ok) {
      const errData = await sendResponse.json().catch(() => null);
      throw new Error(errData?.detail || `HTTP ${sendResponse.status}`);
    }
  } catch (err) {
    return htmlPage('E-Mail nicht gesendet',
      `<div class="icon">⚠️</div>
       <h1 style="color:#E04848">E-Mail konnte nicht gesendet werden</h1>
       <p>${err.message}</p>
       <p><small>Bestellung #${ref} – Status wurde NICHT aktualisiert.</small></p>
       <p style="margin-top:20px"><a href="${siteUrl}">← Zurück zur Website</a></p>`,
      '#E04848');
  }

  // Erfolgsseite
  // Brücke zur Live-Statusseite: Seite + Push mitziehen (fire-and-forget)
  try {
    const siteUrl = (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');
    await fetch(siteUrl + '/.netlify/functions/order-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'set', secret: process.env.STATUS_UPDATE_SECRET || '', reference: ref, state: status }),
    }).catch(() => {});
  } catch (e) {}

  const label = STATUS_LABELS[status];
  return htmlPage(`Status aktualisiert: ${label.name}`,
    `<div class="icon">${label.emoji}</div>
     <h1>Status aktualisiert</h1>
     <p style="font-size:18px;color:#F5E9D0;margin:8px 0 20px"><strong>${label.name}</strong></p>
     <p>Bestellung <strong>#${ref}</strong> von <strong>${order.name || 'Kunde'}</strong></p>
     <p><small>Eine E-Mail wurde an ${order.email || 'den Kunden'} gesendet.</small></p>
     <p style="margin-top:30px;padding-top:20px;border-top:1px solid #2A2520">
       <a href="${siteUrl}">← Zurück zur Website</a>
     </p>`);
};
