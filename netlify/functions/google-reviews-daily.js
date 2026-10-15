/**
 * google-reviews-daily.js
 * ----------------------------------------------------------------------------
 * Frischt jeden Morgen die Google-Bewertungen für alle 8 Sprachen auf
 * (Zeitplan in netlify.toml). Vorher hing die Auffrischung daran, dass nach
 * Ablauf der 24 h zufällig jemand die Seite öffnet.
 *
 * Erst Deutsch: Lehnt Google schon das ab, ist es fast immer der Schlüssel
 * oder das Abrechnungskonto. Dann werden die übrigen Sprachen gar nicht erst
 * angefragt, und der Inhaber bekommt höchstens einmal pro Woche eine kurze
 * Telegram-Meldung. Läuft der Abruf danach wieder, folgt eine Entwarnung.
 * ----------------------------------------------------------------------------
 */

const g = require('./lib/google-bewertungen');

function datum(ms) {
  return new Date(ms).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' });
}

exports.handler = async () => {
  const status = await g.leseStatus();
  const jetzt = Date.now();
  let erste;
  try {
    erste = await g.aktualisiere('de');
  } catch (e) {
    const diag = e.diag || null;
    const fehlerSeit = status.fehlerSeit || jetzt;
    console.error('google-reviews-daily: Google lehnt ab', JSON.stringify(diag));
    const neu = { letzterVersuch: jetzt, fehlerSeit, letzterFehler: String(e.message || e), diag, schluessel: g.schluesselMarke() };
    if (!status.gemeldetAm || jetzt - status.gemeldetAm > g.MELDE_PAUSE_MS) {
      const cache = await g.leseCache('de');
      const grund = (diag && diag.neu && (diag.neu.details ? diag.neu.details.status : diag.neu.status)) || (diag && diag.status) || 'unbekannt';
      const ok = await g.melde(
        '⚠️ <b>Google-Bewertungen</b> werden seit ' + datum(fehlerSeit) + ' nicht mehr aktualisiert.\n'
        + 'Google antwortet: ' + grund + '.\n'
        + 'Die Website zeigt so lange den letzten Stand'
        + (cache ? ' (' + cache.total + ' Bewertungen vom ' + datum(cache.fetchedAt) + ')' : '') + '.\n'
        + 'Zu prüfen in der Google Cloud Console: Abrechnungskonto aktiv, „Places API (New)“ aktiviert, API-Schlüssel nicht eingeschränkt.'
      );
      if (ok) neu.gemeldetAm = jetzt;
    }
    await g.schreibeStatus(neu);
    return { statusCode: 200, body: JSON.stringify({ ok: false, diag }) };
  }

  const ergebnis = { de: erste.total };
  for (const lang of g.LANGS.filter(l => l !== 'de')) {
    try { ergebnis[lang] = (await g.aktualisiere(lang)).total; }
    catch (e) { ergebnis[lang] = 'fehler'; }
  }

  if (status.fehlerSeit && status.gemeldetAm) {
    await g.melde('✅ <b>Google-Bewertungen</b> laufen wieder: ' + erste.total + ' Bewertungen, ' + erste.rating.toFixed(1).replace('.', ',') + ' Sterne.');
  }
  await g.schreibeStatus({ letzterVersuch: jetzt, letzterErfolg: erste.fetchedAt, fehlerSeit: null, letzterFehler: null, diag: null, gemeldetAm: null, quellen: erste.quellen, schluessel: g.schluesselMarke() });
  console.log('google-reviews-daily: ok', JSON.stringify({ ergebnis, quellen: erste.quellen }));
  return { statusCode: 200, body: JSON.stringify({ ok: true, ergebnis, quellen: erste.quellen }) };
};
