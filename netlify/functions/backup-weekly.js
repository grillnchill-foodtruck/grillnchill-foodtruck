/**
 * backup-weekly.js
 * ----------------------------------------------------------------------------
 * Wöchentliche Datensicherung. Geplant über netlify.toml (montags 03:15 UTC).
 *
 * Liest alle Blob-Speicher aus, packt sie als ZIP und legt das Archiv im
 * Speicher "backups" ab. Die letzten AUFBEWAHREN Stände bleiben erhalten,
 * ältere werden entfernt.
 *
 * Bewusst NICHT per Mail verschickt: das Archiv enthält Namen, Anschriften,
 * Telefonnummern und die Passwort-Hashes der Team-Zugänge. So etwas gehört
 * nicht in ein Postfach. Der Inhaber bekommt nur eine kurze Meldung, dass die
 * Sicherung durchlief; heruntergeladen wird sie im Admin-Tool.
 * ----------------------------------------------------------------------------
 */

const { sammle, baueArchiv, store } = require('./lib/sicherung');

/* Acht Wochen Vorlauf: lange genug, um ein Versehen zu bemerken, das erst
   nach ein paar Wochen auffällt – und klein genug, dass der Speicher nicht
   unbemerkt zuläuft. */
const AUFBEWAHREN = 8;

async function melde(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  try {
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML' }),
    });
  } catch (e) { /* eine ausgefallene Meldung darf die Sicherung nicht kippen */ }
}

exports.handler = async () => {
  const start = Date.now();
  try {
    const daten = await sammle();
    const zip = baueArchiv(daten);

    const gesamt = daten.bericht.reduce((n, b) => n + b.eintraege, 0);
    const fehlend = daten.bericht.filter((b) => !b.ok);
    const tag = daten.stand.slice(0, 10);
    const key = 'bak:' + daten.stand;

    const s = store('backups');
    await s.set(key, zip);
    // Kopf getrennt ablegen: die Liste im Admin-Tool soll nicht jedes Archiv
    // herunterladen müssen, nur um Datum und Größe anzuzeigen.
    await s.setJSON('kopf:' + daten.stand, {
      stand: daten.stand, bytes: zip.length,
      eintraege: gesamt, bericht: daten.bericht,
    });

    // Alte Stände entfernen
    let entfernt = 0;
    try {
      const { blobs } = await s.list({ prefix: 'kopf:' });
      const staende = blobs.map((b) => b.key.slice(5)).sort().reverse();
      for (const alt of staende.slice(AUFBEWAHREN)) {
        try { await s.delete('kopf:' + alt); await s.delete('bak:' + alt); entfernt++; } catch (e) {}
      }
    } catch (e) { console.error('backup-weekly: Aufräumen fehlgeschlagen:', e); }

    const mb = (zip.length / 1048576).toFixed(2).replace('.', ',');
    console.log(`backup-weekly: ${gesamt} Einträge, ${zip.length} Bytes, ${entfernt} alte entfernt`);

    await melde(fehlend.length
      ? `⚠️ <b>Datensicherung mit Lücken</b>\n${tag} · ${gesamt} Einträge · ${mb} MB\n`
        + `Nicht gelesen: ${fehlend.map((b) => b.speicher).join(', ')}\nBitte im Admin-Tool prüfen.`
      : `💾 <b>Datensicherung erstellt</b>\n${tag} · ${gesamt} Einträge · ${mb} MB\n`
        + `Im Admin-Tool unter „Rechnungen“ herunterladbar.`);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, stand: daten.stand, bytes: zip.length,
        eintraege: gesamt, entfernt, dauerMs: Date.now() - start }),
    };
  } catch (e) {
    console.error('backup-weekly:', e);
    // Eine stillschweigend ausgefallene Sicherung ist schlimmer als gar keine –
    // deshalb hier auf jeden Fall Bescheid geben.
    await melde(`❌ <b>Datensicherung FEHLGESCHLAGEN</b>\n${String((e && e.message) || e).slice(0, 300)}`);
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: String(e && e.message) }) };
  }
};
