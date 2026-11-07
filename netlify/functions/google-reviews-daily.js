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
 *
 * Vorher holt der Lauf die neuesten Rezensionen aus dem Google-Unternehmens-
 * profil (lib/google-profil.js), falls es im Admin-Tool verbunden ist. Gibt
 * Google das Projekt frei, kommt einmal eine Telegram-Nachricht; endet die
 * Verbindung, höchstens einmal pro Woche ein Hinweis.
 * ----------------------------------------------------------------------------
 */

const g = require('./lib/google-bewertungen');
const profil = require('./lib/google-profil');

const PROFIL_HINWEIS = {
  neu_verbinden: 'Google hat die Verbindung zum Unternehmensprofil beendet. Bitte im Admin-Tool unter Feedback neu verbinden.',
  kein_standort: 'Das verbundene Google-Konto verwaltet das Profil von Grill\'n Chill nicht. Bitte mit dem Inhaber- oder Manager-Konto neu verbinden.',
  api_nicht_aktiviert: 'Im Google-Cloud-Projekt ist eine Business-Profile-API nicht aktiviert. Details im Admin-Tool unter Feedback.',
};

async function profilAbruf() {
  const r = await profil.aktualisiereProfil({});
  try {
    if (r.freigabe === 'ok' && r.vorher && r.vorher !== 'ok') {
      await g.melde('✅ <b>Google-Unternehmensprofil</b> ist verbunden. Neue Rezensionen kommen ab jetzt jeden Morgen von selbst auf die Website (' + (r.total || '?') + ' Bewertungen).');
    } else if (PROFIL_HINWEIS[r.freigabe]) {
      const s = await profil.leseStatus();
      if (!s.gemeldetAm || Date.now() - s.gemeldetAm > g.MELDE_PAUSE_MS) {
        if (await g.melde('⚠️ <b>Google-Rezensionen</b>: ' + PROFIL_HINWEIS[r.freigabe])) await profil.schreibeStatus({ gemeldetAm: Date.now() });
      }
    }
  } catch (e) { /* Meldung ist Zugabe */ }
  return r.freigabe;
}

function datum(ms) {
  return new Date(ms).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' });
}

exports.handler = async () => {
  const profilStand = await profilAbruf().catch(() => 'fehler');
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
  console.log('google-reviews-daily: ok', JSON.stringify({ ergebnis, profil: profilStand, quellen: erste.quellen }));
  return { statusCode: 200, body: JSON.stringify({ ok: true, ergebnis, profil: profilStand, quellen: erste.quellen }) };
};
