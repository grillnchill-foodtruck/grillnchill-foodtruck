/**
 * giftcard-pdf.js
 * ----------------------------------------------------------------------------
 * Gutschein als PDF (lib/geschenk-pdf.js).
 *
 *   GET ?c=<CODE>&t=<PDF-Schlüssel>[&dl=1]            → Gutschein (PDF)
 *   GET ?c=<CODE>&t=<PDF-Schlüssel>&art=beleg[&dl=1]  → Kaufbeleg (PDF)
 *
 * Der Schlüssel steht nur in den Gutschein-Mails und in der Danke-Ansicht.
 * Der Beleg hat einen eigenen Schlüssel (nur Käufer-Mail und Danke-Ansicht),
 * weil das Gutschein-PDF auch an die beschenkte Person geht. Ohne passenden
 * Schlüssel gibt es 404, auch für echte Codes.
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
  const beleg = q.art === 'beleg';
  // Eigener Schlüssel für den Beleg: das Gutschein-PDF bekommt auch die beschenkte Person
  if (!d || !geschenk.tokenStimmt(d, q.t, beleg ? 'beleg' : '')) return nichts;
  const v = await geschenk.store('vouchers').get('c:' + code, { type: 'json' });
  if (!v || (v.active === false && !beleg)) return nichts;
  let pdf, name;
  if (beleg) {
    const b = require('./lib/geschenk-beleg');
    const archiv = await geschenk.store('invoices').get('gs:' + d.reference, { type: 'json' }).catch(() => null);
    pdf = await b.belegPdf(archiv || b.belegDaten(d));
    name = 'Kaufbeleg-' + d.reference;
  } else {
    pdf = await require('./lib/geschenk-pdf').gutscheinPdf(d);
    name = 'Gutschein-' + code;
  }
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': (q.dl ? 'attachment' : 'inline') + '; filename="' + name + '.pdf"',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex',
    },
    body: pdf.toString('base64'),
    isBase64Encoded: true,
  };
};
