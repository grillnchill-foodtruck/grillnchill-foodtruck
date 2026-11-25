/**
 * lib/office-ticket.js
 * Einmal-Ticket fürs GNC Office (office.grillnchill-foodtruck.de). Format wie
 * im Office (functions/_lib/ticket.js): base64url(JSON) + "." + base64url(HMAC-SHA256).
 * Gemeinsames Geheimnis: OFFICE_TICKET_SECRET (Netlify und Cloudflare).
 */
const crypto = require('crypto');
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function signieren(daten, geheimnis) {
  const teil = b64url(Buffer.from(JSON.stringify(daten), 'utf8'));
  return teil + '.' + b64url(crypto.createHmac('sha256', geheimnis).update(teil).digest());
}

function ticketFuer(wer, geheimnis, jetztSek = Math.floor(Date.now() / 1000)) {
  return signieren({
    v: 1, aud: 'gnc-office', sub: wer.sub, name: wer.name, rolle: wer.role, zf: true,
    iat: jetztSek, exp: jetztSek + 60, jti: crypto.randomBytes(16).toString('hex'),
  }, geheimnis);
}

module.exports = { signieren, ticketFuer };
