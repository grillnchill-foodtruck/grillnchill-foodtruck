/**
 * giftcard-check.js
 * ----------------------------------------------------------------------------
 * „Gutschein prüfen“ auf /gutscheine: Wert, Gültigkeit, noch offen?
 *
 *   POST { code } → { valid: true, code, value, minOrder, validUntil }
 *                 → { valid: false, reason: 'unknown'|'used'|'expired'|'inactive'|'format' }
 *
 * Nur gekaufte Geschenkgutscheine. Aktions- und persönliche Codes gelten
 * hier als unbekannt, damit niemand über diese Seite Codes durchprobiert.
 * Keine Namen, keine Adressen in der Antwort.
 * ----------------------------------------------------------------------------
 */

const { schutz } = require('./lib/bremse');
const { codeNormalisieren } = require('./lib/gutschein-code');
const geschenk = require('./lib/geschenk');

const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(data),
});

exports.handler = async (event) => {
  const halt = await schutz(event, { name: 'gutscheinpruefen', max: 20, maxKB: 2 });
  if (halt) return halt;
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }
  const code = codeNormalisieren(input.code);
  if (!/^GNC[A-Z0-9]{6}$/.test(code)) return json(200, { valid: false, reason: 'format' });
  try {
    return json(200, await geschenk.pruefen(code));
  } catch (e) {
    return json(502, { error: 'lookup_failed' });
  }
};
