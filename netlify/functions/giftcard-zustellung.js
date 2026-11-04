/**
 * giftcard-zustellung.js
 * ----------------------------------------------------------------------------
 * Stündlich (netlify.toml): Gutschein-Mails an beschenkte Personen, deren
 * Wunschdatum erreicht ist (ab 8 Uhr Berlin), und neue Versuche für
 * Sofort-Mails, die beim Kauf nicht rausgingen. Logik: lib/geschenk.js.
 * ----------------------------------------------------------------------------
 */

const { faelligeZustellen } = require('./lib/geschenk');

exports.handler = async () => {
  const r = await faelligeZustellen();
  if (r.verschickt || r.fehler) console.log('Gutschein-Zustellung:', JSON.stringify(r));
  return { statusCode: 200, body: JSON.stringify(r) };
};
