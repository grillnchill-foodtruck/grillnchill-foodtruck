/**
 * giftcard-pdf.js
 * ----------------------------------------------------------------------------
 * Gutschein als PDF (lib/geschenk-pdf.js).
 *
 *   GET ?c=<CODE>&t=<PDF-Schlüssel>[&dl=1]  → application/pdf
 *
 * Der Schlüssel steht nur in den Gutschein-Mails und in der Danke-Ansicht.
 * Ohne passenden Schlüssel gibt es 404, auch für echte Codes.
 * ----------------------------------------------------------------------------
 */

const { schutz } = require('./lib/bremse');
const geschenk = require('./lib/geschenk');
const { codeNormalisieren } = require('./lib/gutschein-code');

exports.handler = async (event) => {
  const halt = await schutz(event, { name: 'gutscheinpdf', max: 40, maxKB: 4 });
  if (halt) return halt;
  const q = event.queryStringParameters || {};
  const code = codeNormalisieren(q.c);
  const nichts = { statusCode: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Gutschein nicht gefunden.' };
  if (!code || !q.t) return nichts;
  const d = await geschenk.store('vouchers').get('gd:' + code, { type: 'json' });
  if (!d || !geschenk.tokenStimmt(d, q.t)) return nichts;
  const v = await geschenk.store('vouchers').get('c:' + code, { type: 'json' });
  if (!v || v.active === false) return nichts;
  const pdf = await require('./lib/geschenk-pdf').gutscheinPdf(d);
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': (q.dl ? 'attachment' : 'inline') + '; filename="Gutschein-' + code + '.pdf"',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    },
    body: pdf.toString('base64'),
    isBase64Encoded: true,
  };
};
