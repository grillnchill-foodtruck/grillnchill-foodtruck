/**
 * lib/auth-guard.js
 * ----------------------------------------------------------------------------
 * Bremse gegen das Durchprobieren von Admin-Passwörtern.
 *
 * Vorher stand vor allen Admin-Endpunkten NICHTS: beliebig viele Versuche,
 * gleichbleibend schnelle Antwort, keine Sperre – weder im Code noch in der
 * netlify.toml. Mehrere Endpunkte sind GET (orders-list, invoices-list,
 * invoices-zip, invoice-pdf) und damit mit einer Zeile skriptbar. Seit das
 * Repo öffentlich ist, kann jeder die genaue Aufrufform nachlesen. Damit war
 * die Passwortlänge die einzige Schutzmaßnahme.
 *
 * Bewusst NICHT über einen Umbau von authRole gelöst: diese Funktion liegt in
 * 16 Dateien in leicht verschiedenen Fassungen (mal `true`, mal
 * `{role, name}`, mal `{role}`). Sie alle gleichzeitig umzubauen hätte
 * bedeutet, 16 Anmeldepfade auf einmal anzufassen – ein Fehler dabei sperrt
 * den Inhaber aus oder lässt jemanden herein. Dieser Wächter setzt sich
 * stattdessen DAVOR und lässt die vorhandene Prüfung unberührt.
 *
 * Verwendung im Handler:
 *
 *     const gesperrt = await pruefeSperre(event);
 *     if (gesperrt) return gesperrt;              // 429
 *     const who = await authRole(pw);
 *     await meldeErgebnis(event, !!who);
 *     if (!who) return json(401, ...);
 *
 * Zwei Entscheidungen, die erklärt gehören:
 *
 * 1. KEIN künstliches Warten. Naheliegend wäre, bei Fehlversuchen die Antwort
 *    zu verzögern. Auf einer Serverless-Plattform wird daraus aber ein Hebel
 *    gegen den Betreiber: jeder Fehlversuch hielte eine Function länger am
 *    Laufen, und bezahlt wird nach Laufzeit. Eine harte Sperre erreicht
 *    dasselbe Ziel, ohne diese Rechnung aufzumachen.
 *
 * 2. Im Störungsfall wird DURCHGELASSEN, nicht gesperrt. Ist der Blob-Speicher
 *    kurz nicht erreichbar, käme der Inhaber sonst mitten im Verkauf nicht
 *    mehr an seine Bestellungen. Das Passwort schützt weiterhin; die Bremse
 *    ist eine zusätzliche Schicht, keine tragende.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

/* Beobachtungsfenster: so lange zählen Fehlversuche zusammen. */
const FENSTER_MS = 15 * 60 * 1000;
/* Ab so vielen Fehlversuchen im Fenster wird gesperrt. Grosszuegig genug,
   dass ein paar Vertipper des Inhabers folgenlos bleiben. */
const SPERRE_AB = 8;
/* Dauer der Sperre. */
const SPERRE_MS = 15 * 60 * 1000;

function store() {
  const opts = { name: 'authguard', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

/**
 * Absender bestimmen.
 * x-nf-client-connection-ip setzt Netlify selbst aus der TCP-Verbindung und
 * überschreibt einen gleichnamigen Header des Aufrufers – anders als
 * x-forwarded-for, das der Aufrufer frei erfinden kann. Deshalb hat es
 * Vorrang; x-forwarded-for dient nur als Rückfallebene.
 * Die Adresse wird nur als Hash abgelegt, nie im Klartext.
 */
function absender(event) {
  const h = (event && event.headers) || {};
  const roh = h['x-nf-client-connection-ip']
    || String(h['x-forwarded-for'] || '').split(',')[0].trim()
    || '';
  if (!roh) return null;
  return 'ip:' + crypto.createHash('sha256').update(roh).digest('hex').slice(0, 32);
}

const antwort429 = (sekunden) => ({
  statusCode: 429,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Retry-After': String(sekunden),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  },
  // Bewusst dieselbe Auskunft für alle: ob das Passwort stimmte, verrät die
  // Sperre nicht. Sonst liesse sich an ihr ablesen, wann man richtig lag.
  body: JSON.stringify({
    error: 'too_many_attempts',
    hint: 'Zu viele Fehlversuche. Bitte in einigen Minuten erneut versuchen.',
    retryAfter: sekunden,
  }),
});

/**
 * Vor der Anmeldung aufrufen. Gibt eine fertige 429-Antwort zurück, wenn
 * gesperrt ist – sonst null.
 */
async function pruefeSperre(event) {
  const key = absender(event);
  if (!key) return null;                      // ohne Absender keine Zuordnung
  try {
    const rec = await store().get(key, { type: 'json' });
    if (!rec || !rec.gesperrtBis) return null;
    const rest = new Date(rec.gesperrtBis).getTime() - Date.now();
    if (rest <= 0) return null;
    return antwort429(Math.ceil(rest / 1000));
  } catch (e) {
    console.error('auth-guard pruefeSperre:', e);
    return null;                              // im Zweifel durchlassen
  }
}

/**
 * Nach der Anmeldung aufrufen – mit dem Ergebnis.
 * Erfolg löscht den Zähler, Misserfolg erhöht ihn und sperrt beim Erreichen
 * der Schwelle.
 */
async function meldeErgebnis(event, erfolg) {
  const key = absender(event);
  if (!key) return;
  try {
    const s = store();
    if (erfolg) { await s.delete(key); return; }

    const jetzt = Date.now();
    const rec = (await s.get(key, { type: 'json' })) || null;
    // Liegt der erste Fehlversuch laenger zurueck als das Fenster, faengt die
    // Zaehlung von vorne an – sonst summierten sich Vertipper ueber Wochen.
    const frisch = !rec || (jetzt - new Date(rec.seit || 0).getTime()) > FENSTER_MS;
    const fehl = frisch ? 1 : (Number(rec.fehl) || 0) + 1;
    const neu = {
      fehl,
      seit: frisch ? new Date(jetzt).toISOString() : rec.seit,
      gesperrtBis: fehl >= SPERRE_AB ? new Date(jetzt + SPERRE_MS).toISOString() : null,
    };
    await s.setJSON(key, neu);
    if (neu.gesperrtBis) {
      console.warn(`auth-guard: ${key} nach ${fehl} Fehlversuchen gesperrt bis ${neu.gesperrtBis}`);
    }
  } catch (e) {
    console.error('auth-guard meldeErgebnis:', e);
  }
}

module.exports = { pruefeSperre, meldeErgebnis, FENSTER_MS, SPERRE_AB, SPERRE_MS };
