/**
 * retarget-optout.js
 * ----------------------------------------------------------------------------
 * Abmelde-Link aus der Retargeting-Mail (§ 7 Abs. 3 UWG: Widerspruchsrecht).
 *
 *   GET /retarget-optout?e=<base64url(email)>&t=<token>
 *
 * Der Token ist an E-Mail + ADMIN_PASSWORD gebunden – Links lassen sich nicht
 * für fremde Adressen fälschen. Nach dem Klick wird die Adresse dauerhaft
 * von Angebots-Mails ausgeschlossen (Store: retarget, Prefix opt:).
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

function store() {
  const opts = { name: 'retarget', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

function page(title, text) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title} – Grilln Chill</title></head>
<body style="margin:0;background:#0F0D0B;font-family:Arial,Helvetica,sans-serif;color:#F5E9D0;display:flex;align-items:center;justify-content:center;min-height:100vh;">
<div style="max-width:420px;padding:40px 28px;text-align:center;">
  <div style="font-size:22px;font-weight:800;letter-spacing:0.5px;margin-bottom:6px;">GRILL'N CHILL</div>
  <div style="color:#FF7A3D;font-size:12px;font-weight:700;letter-spacing:1px;margin-bottom:28px;">HALAL BURGER · BIELEFELD</div>
  <h1 style="font-size:19px;margin:0 0 12px;">${title}</h1>
  <p style="color:#C9BCA4;font-size:14px;line-height:1.7;margin:0 0 28px;">${text}</p>
  <a href="https://grillnchill-foodtruck.de" style="display:inline-block;background:#CC4715;color:#fff;padding:12px 26px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;">Zur Website</a>
</div></body></html>`,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method not allowed' };
  const p = event.queryStringParameters || {};
  let email = '';
  try { email = Buffer.from(p.e || '', 'base64url').toString('utf-8').toLowerCase().trim(); } catch (e) {}
  const expected = crypto.createHash('sha256')
    .update('optout:' + email + ':' + (process.env.ADMIN_PASSWORD || ''))
    .digest('hex').slice(0, 24);

  if (!email || !email.includes('@') || p.t !== expected) {
    return page('Link ungültig', 'Dieser Abmelde-Link ist ungültig oder abgelaufen. Schreib uns einfach an info@grillnchill-foodtruck.de – wir kümmern uns.');
  }

  try {
    const hash = crypto.createHash('sha256').update(email).digest('hex');
    await store().setJSON('opt:' + hash, { optedOutAt: new Date().toISOString() });
    return page('Abgemeldet', 'Du erhältst künftig keine Angebots-Mails mehr von uns. Bestellbestätigungen und Status-Updates zu deinen Bestellungen bekommst du natürlich weiterhin.');
  } catch (e) {
    return page('Das hat nicht geklappt', 'Bitte versuch es später erneut oder schreib uns an info@grillnchill-foodtruck.de.');
  }
};
