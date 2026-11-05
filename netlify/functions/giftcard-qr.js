/**
 * giftcard-qr.js
 * ----------------------------------------------------------------------------
 * QR-Code eines Geschenkgutscheins als GIF für die Gutschein-Mails.
 *
 *   GET ?c=<CODE>  → image/gif mit https://grillnchill-foodtruck.de/g/<CODE>
 *
 * Verrät nichts: Der Inhalt ist nur der Link aus dem Code, den der Aufrufer
 * schon kennt, und es wird nicht geprüft, ob es den Gutschein gibt.
 * ----------------------------------------------------------------------------
 */

const { schutz } = require('./lib/bremse');
const { codeNormalisieren } = require('./lib/gutschein-code');
const qr = require('./lib/qr');

exports.handler = async (event) => {
  const halt = await schutz(event, { name: 'gutscheinqr', max: 120, maxKB: 2 });
  if (halt) return halt;
  const code = codeNormalisieren((event.queryStringParameters || {}).c);
  if (!/^GNC[A-Z0-9]{6}$/.test(code)) return { statusCode: 404, body: '' };
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'public, max-age=31536000, immutable' },
    body: qr.gif(qr.gutscheinLink(code), 6).toString('base64'),
    isBase64Encoded: true,
  };
};
