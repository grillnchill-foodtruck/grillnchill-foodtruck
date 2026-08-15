/**
 * standing-skip.js
 * ----------------------------------------------------------------------------
 * Ein-Klick-Ziele aus der Erinnerungsmail – ohne Anmeldung nutzbar.
 *
 *   GET ?id=<id>&t=<token>          → diesen einen Termin aussetzen
 *   GET ?id=<id>&t=<token>&off=1    → Erinnerungen ganz abschalten
 *
 * Das Token ist ein HMAC über die Kennung; ohne den Serverschlüssel lässt es
 * sich nicht erraten. Es erlaubt bewusst nur diese beiden harmlosen Schritte –
 * nichts wird gelöscht, nichts bestellt, nichts eingesehen.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { naechsterTermin } = require('./lib/standing');

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

function linkToken(id, secret) {
  return crypto.createHmac('sha256', secret || 'gnc').update('so:' + id).digest('hex').slice(0, 16);
}

const seite = (titel, text) => `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${titel}</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#141310;
color:#E9E5D9;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:1.5rem;">
  <div style="max-width:26rem;text-align:center;">
    <div style="font-size:1.35rem;font-weight:800;margin-bottom:.6rem;">${titel}</div>
    <p style="color:#A29B8C;line-height:1.6;margin:0 0 1.6rem;">${text}</p>
    <a href="https://grillnchill-foodtruck.de" style="display:inline-block;background:#E85A24;
       color:#fff;text-decoration:none;font-weight:700;padding:.8rem 1.5rem;border-radius:999px;">
      Zur Speisekarte</a>
  </div>
</body></html>`;

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const id = String(p.id || '').replace(/[^a-f0-9]/g, '').slice(0, 24);
  const secret = process.env.STATUS_SECRET || process.env.ADMIN_PASSWORD || 'gnc';
  const html = (code, body) => ({ statusCode: code, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body });

  if (!id || p.t !== linkToken(id, secret)) {
    return html(403, seite('Link nicht gültig', 'Dieser Link ist abgelaufen oder unvollständig. Du kannst deine stehende Bestellung jederzeit im Kundenkonto verwalten.'));
  }

  try {
    const s = store('standing');
    const { blobs } = await s.list({ prefix: 'so:' });
    const treffer = blobs.find(b => b.key.endsWith(':' + id));
    if (!treffer) return html(404, seite('Nicht gefunden', 'Diese stehende Bestellung gibt es nicht mehr.'));

    const rec = await s.get(treffer.key, { type: 'json' });
    if (!rec) return html(404, seite('Nicht gefunden', 'Diese stehende Bestellung gibt es nicht mehr.'));

    if (p.off === '1') {
      rec.remind = false;
      rec.remindConsentAt = null;
      await s.setJSON(treffer.key, rec);
      return html(200, seite('Erinnerungen abgeschaltet',
        'Du bekommst keine Erinnerungen mehr zu dieser stehenden Bestellung. Die Bestellung selbst bleibt in deinem Konto gespeichert – du kannst die Erinnerung dort jederzeit wieder einschalten.'));
    }

    rec.skipUntil = rec.nextRun;
    rec.nextRun = naechsterTermin(rec.weekday, rec.time, rec.skipUntil);
    await s.setJSON(treffer.key, rec);

    const wann = rec.nextRun
      ? new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'long', day: '2-digit', month: '2-digit' })
          .format(new Date(rec.nextRun))
      : null;
    return html(200, seite('Diese Woche ausgesetzt',
      wann ? `Alles klar – diesmal ohne dich. Die nächste Erinnerung kommt vor ${wann}.`
           : 'Alles klar – diesmal ohne dich.'));
  } catch (e) {
    console.error('standing-skip:', e);
    return html(500, seite('Da ging etwas schief', 'Bitte versuch es später noch einmal oder verwalte deine stehende Bestellung im Kundenkonto.'));
  }
};
