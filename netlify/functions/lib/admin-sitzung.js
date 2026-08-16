/**
 * lib/admin-sitzung.js
 * ----------------------------------------------------------------------------
 * "Angemeldet bleiben" im Admin-Tool – ohne das Passwort im Browser.
 *
 * WAS VORHER PASSIERTE
 * --------------------
 * Wer im Admin-Tool "angemeldet bleiben" wählte, dessen Browser legte das
 * Passwort im Klartext ab:
 *
 *     localStorage.setItem(PW_KEY + '_p', JSON.stringify({ pw, exp: … }))
 *
 * Dreissig Tage lang, lesbar für jeden mit Zugriff auf das Gerät – und es ist
 * nicht irgendein Passwort, sondern der Generalschlüssel: Bestellungen,
 * Umsätze, Rechnungen, Gutscheine, Team-Verwaltung. Ein verliehenes Tablet
 * oder ein verkauftes Handy genügte.
 *
 * WIE ES JETZT LÄUFT
 * ------------------
 * Der Browser merkt sich einen zufälligen Sitzungs-Token, nie das Passwort.
 *
 *     Anmeldung   Passwort -> Server prüft -> Server gibt Token zurück
 *     Danach      Browser schickt den Token, der Server löst ihn wieder auf
 *
 * Der Token läuft von selbst ab und lässt sich serverseitig widerrufen
 * (Abmelden löscht ihn). Am Bedienen ändert sich nichts.
 *
 * WARUM DAS PASSWORT VERSCHLÜSSELT ABGELEGT WIRD
 * ----------------------------------------------
 * Die Anmeldeprüfung (authRole) liegt in sechzehn Functions in leicht
 * verschiedenen Fassungen und gibt je nach Datei eine andere Form zurück
 * (mal {role, name}, mal {role}, mal einen Wahrheitswert). Sie alle umzubauen
 * hiesse, sechzehn Anmeldepfade gleichzeitig anzufassen – ein Fehler dabei
 * sperrt den Inhaber aus oder lässt jemanden herein. Deshalb löst diese Datei
 * den Token DAVOR in das Passwort auf; die vorhandene Prüfung bleibt Zeile für
 * Zeile, wie sie ist.
 *
 * Damit liegt das Passwort im Blob-Speicher – aber nicht lesbar: Es wird mit
 * einem Schlüssel verschlüsselt, der aus dem Token abgeleitet ist, und der
 * Token steht nirgends im Speicher (abgelegt ist nur sein Hash). Wer den
 * Speicher in die Hand bekommt, hat verschlüsselte Bytes und keinen Schlüssel
 * dazu. Wer den Token hat, hat ohnehin Zugang – für ihn ändert das nichts.
 *
 * SICHERHEITSNETZ
 * ---------------
 * Als Token gilt nur, was die Form 'gncs_' + 64 Hexzeichen hat. Alles andere
 * geht unverändert als Passwort weiter. Und selbst ein Wert in Token-Form,
 * zu dem keine Sitzung existiert, wird als Passwort durchgereicht statt
 * abgelehnt. Das Anmelden mit dem Passwort funktioniert also immer – auch
 * wenn an diesem Speicher etwas klemmt.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

/* Wie lange eine gemerkte Anmeldung gilt. Wie bisher im Browser: 30 Tage. */
const GUELTIG_MS = 30 * 24 * 60 * 60 * 1000;

const PRAEFIX = 'gncs_';
const FORM = /^gncs_[a-f0-9]{64}$/;

function store() {
  const opts = { name: 'sitzungen', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
/* Schlüssel zum Verschlüsseln – aus dem Token abgeleitet, mit einem anderen
   Zusatz als der Ablage-Schlüssel. Sonst wäre aus dem einen der andere zu
   berechnen. */
const ableiten = (token) => crypto.createHash('sha256').update('gnc-sitzung|' + token).digest();

/** Ist das überhaupt ein Sitzungs-Token? */
function istToken(x) {
  return typeof x === 'string' && FORM.test(x);
}

/**
 * Neue Sitzung anlegen. Nur aufrufen, NACHDEM das Passwort geprüft wurde.
 * @returns {Promise<{token: string, exp: string}|null>} null bei Störung
 */
async function erstelle(passwort, wer) {
  try {
    if (!passwort) return null;
    const token = PRAEFIX + crypto.randomBytes(32).toString('hex');
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', ableiten(token), iv);
    const daten = Buffer.concat([c.update(String(passwort), 'utf8'), c.final()]);
    const exp = new Date(Date.now() + GUELTIG_MS).toISOString();
    await store().setJSON('s:' + sha(token), {
      iv: iv.toString('base64'),
      tag: c.getAuthTag().toString('base64'),
      daten: daten.toString('base64'),
      exp,
      angelegt: new Date().toISOString(),
      // Nur zur Anzeige im Protokoll – gibt keinen Zugang
      name: (wer && wer.name) || '?',
      rolle: (wer && wer.role) || '?',
    });
    return { token, exp };
  } catch (e) {
    console.error('admin-sitzung erstelle:', e);
    return null;   // Anmeldung gelingt trotzdem, nur ohne "angemeldet bleiben"
  }
}

/**
 * Token wieder in das Passwort auflösen.
 * Alles, was kein Token ist, kommt unverändert zurück – so bleibt der
 * gewöhnliche Anmeldeweg unberührt.
 */
async function passwortAusSitzung(eingabe) {
  if (!istToken(eingabe)) return eingabe;
  try {
    const rec = await store().get('s:' + sha(eingabe), { type: 'json' });
    if (!rec) return eingabe;                       // unbekannt -> als Passwort weiter
    if (rec.exp && Date.now() > new Date(rec.exp).getTime()) {
      try { await store().delete('s:' + sha(eingabe)); } catch (e) {}
      return eingabe;                               // abgelaufen -> als Passwort weiter
    }
    const d = crypto.createDecipheriv('aes-256-gcm', ableiten(eingabe), Buffer.from(rec.iv, 'base64'));
    d.setAuthTag(Buffer.from(rec.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(rec.daten, 'base64')), d.final()]).toString('utf8');
  } catch (e) {
    console.error('admin-sitzung aufloesen:', e);
    return eingabe;                                 // im Zweifel den alten Weg
  }
}

/** Abmelden: Sitzung serverseitig löschen. */
async function beende(eingabe) {
  if (!istToken(eingabe)) return false;
  try { await store().delete('s:' + sha(eingabe)); return true; } catch (e) { return false; }
}

module.exports = { erstelle, passwortAusSitzung, beende, istToken, GUELTIG_MS };
