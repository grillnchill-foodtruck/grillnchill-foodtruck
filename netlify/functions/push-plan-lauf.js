/**
 * push-plan-lauf.js
 * ----------------------------------------------------------------------------
 * Zeitplan alle 5 Minuten (netlify.toml): verschickt geplante Push-Nachrichten,
 * deren Zeitpunkt erreicht ist (lib/push-plan.js). Das Admin-Tool bietet
 * deshalb Uhrzeiten in 5-Minuten-Schritten an; eine Nachricht für 11:30 geht
 * mit dem Lauf um 11:30 raus.
 * ----------------------------------------------------------------------------
 */
const { faelligeSenden } = require('./lib/push-plan');

exports.handler = async () => {
  try {
    const bericht = await faelligeSenden();
    if (bericht.gesendet || bericht.unklar) console.log('push-plan-lauf:', JSON.stringify(bericht));
    return { statusCode: 200, body: JSON.stringify(bericht) };
  } catch (e) {
    console.error('push-plan-lauf:', (e && e.message) || e);
    return { statusCode: 500, body: JSON.stringify({ error: 'lauf_failed' }) };
  }
};
