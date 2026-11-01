/**
 * wochenbericht.js
 * ----------------------------------------------------------------------------
 * Geplant über netlify.toml: montags 07:00 UTC (08:00 Winterzeit, 09:00
 * Sommerzeit). Schickt Kubi den Bericht der Vorwoche per Telegram, siehe
 * lib/wochenbericht.js.
 *
 * Je Woche geht höchstens ein geplanter Bericht raus (Merker im Blob-Store
 * 'cockpit', Schlüssel wochenbericht:<Montag>). Ein zweiter Lauf derselben
 * Woche, etwa ein Wiederholungsversuch, schickt nichts doppelt. Zum Testen
 * gibt es im Cockpit den Knopf "Bericht jetzt senden" (cockpit-inhaber.js),
 * der den Merker nicht braucht.
 * ----------------------------------------------------------------------------
 */

const { sammleWochendaten, baueWochenbericht, letzteWoche } = require('./lib/wochenbericht');
const { telegram } = require('./lib/telegram');
const tw = require('./lib/tageswerte');

exports.handler = async () => {
  const jetzt = Date.now();
  const woche = letzteWoche(jetzt);
  const merker = 'wochenbericht:' + woche.von;
  let cs = null;
  try {
    cs = tw.store('cockpit');
    const schon = await cs.get(merker, { type: 'json' });
    if (schon && schon.gesendet) return { statusCode: 200, body: JSON.stringify({ ok: true, schon: true }) };
  } catch (e) { /* ohne Merker lieber senden als schweigen */ }

  try {
    const daten = await sammleWochendaten({ jetzt });
    const text = baueWochenbericht(daten);
    const gesendet = await telegram(text, { html: true });
    if (cs && gesendet) {
      try { await cs.setJSON(merker, { gesendet: true, at: new Date(jetzt).toISOString() }); } catch (e) {}
    }
    if (!gesendet) console.error('wochenbericht: Telegram hat nicht angenommen oder ist nicht eingerichtet');
    return { statusCode: 200, body: JSON.stringify({ ok: true, gesendet }) };
  } catch (e) {
    console.error('wochenbericht:', e && e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false }) };
  }
};
