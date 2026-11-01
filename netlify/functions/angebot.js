/**
 * angebot.js
 * ----------------------------------------------------------------------------
 * Öffentliche Seite eines Catering-Angebots (angebot.html unter /angebot).
 * Zugang nur mit Angebots-ID und dem zufälligen Token aus dem Mail-Link.
 * Falsche ID und falscher Token sehen gleich aus (404), damit niemand
 * herausfinden kann, welche IDs es gibt.
 *
 *   GET  ?id=…&t=…              -> { angebot }   (Kundenansicht, ohne Mail/Telefon)
 *   GET  ?id=…&t=…&pruefen=1    -> wie oben, prüft vorher eine offene Zahlung bei SumUp
 *   GET  ?id=…&t=…&pdf=1        -> PDF
 *   POST { id, t, aktion: 'annehmen', haken: true, lang }
 *   POST { id, t, aktion: 'zahlen' }   -> { url }  (nur mit Schalter "Anzahlung online")
 *
 * Bremse: lib/bremse.js je Absender, Annahme und Kasse zusätzlich enger.
 * ----------------------------------------------------------------------------
 */

const { schutz, saeubern, absender } = require('./lib/bremse');
const A = require('./lib/catering-angebot');

const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  body: JSON.stringify(data),
});
const nichtGefunden = () => json(404, { error: 'nicht_gefunden' });
const SPRACHEN = ['de', 'en', 'tr', 'it', 'es', 'pt', 'fr', 'nl'];

exports.handler = async (event) => {
  const halt = await schutz(event, { name: 'angebot', max: 60, maxKB: 8 });
  if (halt) return halt;
  const methode = event.httpMethod;
  if (methode !== 'GET' && methode !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input = {};
  if (methode === 'POST') {
    try { input = saeubern(JSON.parse(event.body || '{}'), { maxText: 200 }); } catch (e) { return json(400, { error: 'bad_json' }); }
  } else {
    input = event.queryStringParameters || {};
  }
  const id = String(input.id || '');
  const token = String(input.t || '');
  if (!A.ID_FORM.test(id) || !A.TOKEN_FORM.test(token)) return nichtGefunden();

  try {
    if (methode === 'GET') {
      const s = A.store();
      let a = await A.laden(s, id);
      if (!a || a.status === 'entwurf' || !A.tokenStimmt(a, token)) return nichtGefunden();
      const e = await A.einstellungenLesen(s);
      if (input.pdf) {
        const pdf = await require('./lib/angebot-pdf').angebotPdf(a, e);
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'inline; filename="Angebot-' + a.nummer + '.pdf"',
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex',
          },
          body: pdf.toString('base64'),
          isBase64Encoded: true,
        };
      }
      if (input.pruefen && a.zahlung && a.zahlung.status === 'PENDING') {
        await A.zahlungPruefen(a, 'rueckkehr');
        a = (await A.laden(s, id)) || a;
      }
      return json(200, { angebot: A.kundenAnsicht(a, e) });
    }

    if (input.aktion === 'annehmen') {
      const enger = await schutz(event, { name: 'angebot-annahme', max: 10, maxKB: 8 });
      if (enger) return enger;
      if (input.haken !== true) return json(400, { error: 'haken_fehlt' });
      const lang = SPRACHEN.includes(input.lang) ? input.lang : 'de';
      const ip = absender(event);
      const r = await A.annehmen(id, token, { lang, ipHash: ip ? ip.slice(0, 16) : '' });
      if (r.code === 404) return nichtGefunden();
      const ansicht = r.a ? A.kundenAnsicht(r.a, r.e) : null;
      if (r.code !== 200) return json(r.code, { error: r.fehler, angebot: ansicht });
      return json(200, { ok: true, angebot: ansicht });
    }

    if (input.aktion === 'zahlen') {
      const enger = await schutz(event, { name: 'angebot-zahlung', max: 10, maxKB: 8 });
      if (enger) return enger;
      const r = await A.zahlungStarten(id, token);
      if (r.code === 404) return nichtGefunden();
      if (r.code !== 200) return json(r.code, { error: r.fehler });
      return json(200, { ok: true, url: r.url });
    }

    return json(400, { error: 'bad_action' });
  } catch (err) {
    console.error('angebot:', (err && err.stack) || err);
    return json(500, { error: 'server_error' });
  }
};
