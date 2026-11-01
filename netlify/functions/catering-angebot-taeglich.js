/**
 * catering-angebot-taeglich.js
 * ----------------------------------------------------------------------------
 * Zeitplan (netlify.toml, täglich 08:00 UTC = 09:00/10:00 in Bielefeld):
 *
 * 1. Gesendete Angebote ohne Antwort bekommen nach 3 Kalendertagen genau
 *    eine freundliche Erinnerungsmail (Marker angebot-erinnerung:<id>).
 * 2. Nach Ablauf der Gültigkeit (oder nach dem Eventdatum) wird ein
 *    gesendetes Angebot "abgelaufen".
 * 3. Offene SumUp-Anzahlungen werden nachgesehen (Sicherheitsnetz hinter
 *    Webhook und Rückkehr des Kunden).
 * 4. Entwürfe, abgelehnte und abgelaufene Angebote verschwinden nach 365
 *    Tagen ohne Änderung. Angenommene und bezahlte bleiben (Geschäftsbrief).
 *
 * Kubi bekommt eine Telegram-Zeile, wenn erinnert wurde oder etwas abgelaufen ist.
 * ----------------------------------------------------------------------------
 */

const { taeglicherLauf } = require('./lib/catering-angebot');

exports.handler = async () => {
  try {
    const bericht = await taeglicherLauf(new Date());
    console.log('catering-angebot-taeglich:', JSON.stringify(bericht));
    return { statusCode: 200, body: JSON.stringify(bericht) };
  } catch (e) {
    console.error('catering-angebot-taeglich:', (e && e.stack) || e);
    return { statusCode: 500, body: JSON.stringify({ error: 'lauf_fehlgeschlagen' }) };
  }
};
