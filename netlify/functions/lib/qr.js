/**
 * lib/qr.js
 * ----------------------------------------------------------------------------
 * QR-Codes auf dem Server, mit derselben Bibliothek wie die Kundenkarte im
 * Browser (vendor/qrcode.js, Kazuhiko Arase, MIT).
 *
 *   matrix(text)      → { n, dunkel(x, y) }   zum Zeichnen im PDF
 *   gif(text, zelle)  → Buffer (GIF)           als Bild in Mails
 *
 * Gutscheine tragen https://grillnchill-foodtruck.de/g/<CODE>: Die
 * Handykamera öffnet damit „Gutschein prüfen“, der Scanner im Admin-Tool
 * erkennt den Code und löst ihn am Truck ein.
 * ----------------------------------------------------------------------------
 */

const qrcode = require('../../../vendor/qrcode.js');

function erzeugen(text) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text));
  qr.make();
  return qr;
}

function matrix(text) {
  const qr = erzeugen(text);
  const n = qr.getModuleCount();
  return { n, dunkel: (x, y) => qr.isDark(y, x) };
}

function gif(text, zelle) {
  const url = erzeugen(text).createDataURL(zelle || 6, 4);
  return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
}

function gutscheinLink(code) {
  return (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '') + '/g/' + code;
}

module.exports = { matrix, gif, gutscheinLink };
