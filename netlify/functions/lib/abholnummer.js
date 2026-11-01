/**
 * lib/abholnummer.js
 * ----------------------------------------------------------------------------
 * Kurze Nummer für jede Bestellung („Nr. 47"), je Kalendertag in
 * Europe/Berlin neu ab 1. Am Truck ruft das Team die Nummer auf, der Gast
 * sieht sie in der Bestätigung, auf der Statusseite und in den Mails.
 *
 * SPEICHER
 * --------
 * Store "abholnr", Schlüssel t:<YYYY-MM-DD>, Wert
 *   { n: <zuletzt vergebene Nummer>, refs: { <Bestellnummer>: <Nr> }, at }
 *
 * GLEICHZEITIGE BESTELLUNGEN
 * --------------------------
 * Lesen, hochzählen, schreiben allein reicht nicht: zwei Bestellungen in
 * derselben Sekunde lesen denselben Stand und bekämen dieselbe Nummer.
 * Deshalb wird bedingt geschrieben (@netlify/blobs v10): mit dem ETag des
 * gelesenen Stands (onlyIfMatch) bzw. onlyIfNew für den ersten Eintrag des
 * Tages. Hat inzwischen jemand anderes geschrieben, meldet der Speicher
 * modified: false; dann wird neu gelesen und weitergezählt.
 *
 * WIEDERHOLTE AUFRUFE
 * -------------------
 * Eine Online-Bestellung läuft oft zweimal durch send-email (SumUp-Webhook
 * und Rückkehr des Kunden, nach einem Mailfehler der 15-Minuten-Abgleich).
 * Die Liste refs im Tagesdokument sorgt dafür, dass dieselbe Bestellung
 * dieselbe Nummer behält. Zählen und Zuordnen stehen im selben bedingten
 * Schreibvorgang, dazwischen passt nichts.
 *
 * WELCHER TAG
 * -----------
 * Der Tag, an dem das Essen über den Tresen geht. Sofortbestellung = heute.
 * Vorbestellung außerhalb der Öffnungszeit (abends, nachts, sonntags) =
 * nächster Öffnungstag laut OEFFNUNG in lib/standing.js. Sonst bekäme eine
 * Vorbestellung von Montagabend eine Montagsnummer und könnte am Dienstag
 * mit einer gleichen Nummer zusammenfallen. Feiertage kennt der Server nicht
 * (nur index.html); eine Vorbestellung über einen Feiertag hinweg zählt
 * dann im Feiertag mit. Das bleibt harmlos, solange am Feiertag zu ist.
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');

let OEFFNUNG = null;
try { OEFFNUNG = require('./standing').OEFFNUNG; } catch (e) { OEFFNUNG = null; }

function store() {
  const opts = { name: 'abholnr', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

/* ---------------- Zeit in Europe/Berlin ---------------- */
const TZ = 'Europe/Berlin';
const fmtTag = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtUhr = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });

/** YYYY-MM-DD in Berlin */
function berlinTag(ms) {
  return fmtTag.format(new Date(ms == null ? Date.now() : ms));
}
/** Minute des Tages in Berlin (0 bis 1439) */
function berlinMinute(ms) {
  const p = {};
  for (const x of fmtUhr.formatToParts(new Date(ms == null ? Date.now() : ms))) p[x.type] = x.value;
  return (parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10);
}
/* Mit Datumstexten rechnen statt mit +24 h: bei der Zeitumstellung hat ein
   Tag 23 oder 25 Stunden, +24 h würde dann einen Tag überspringen. */
function plusTage(tag, n) {
  return new Date(Date.parse(tag + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}
function wochentag(tag) {
  return new Date(tag + 'T12:00:00Z').getUTCDay();
}
function minuten(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Öffnungszeit für einen Tag oder null (Ruhetag). */
function oeffnungAm(tag) {
  if (!OEFFNUNG) return null;
  return OEFFNUNG[wochentag(tag)] || null;
}

/** Hat der Truck laut OEFFNUNG gerade offen? */
function istGeoeffnet(ms) {
  const jetzt = ms == null ? Date.now() : ms;
  const h = oeffnungAm(berlinTag(jetzt));
  if (!h) return false;
  const m = berlinMinute(jetzt);
  const auf = minuten(h.open), zu = minuten(h.close);
  return auf != null && zu != null && m >= auf && m < zu;
}

/**
 * Abholtag einer Bestellung (siehe Kopf). jetzt in ms, Standard Date.now().
 */
function abholTagFuer(order, jetzt) {
  const ms = jetzt == null ? Date.now() : jetzt;
  const heute = berlinTag(ms);
  const vorbestellt = !!(order && (order.isPreorder || order.scheduledFor));
  if (!vorbestellt || !OEFFNUNG) return heute;
  const minute = berlinMinute(ms);
  for (let i = 0; i < 8; i++) {
    const tag = plusTage(heute, i);
    const h = oeffnungAm(tag);
    if (!h) continue;
    if (i === 0 && minute >= (minuten(h.close) || 0)) continue;   // heute schon zu
    return tag;
  }
  return heute;
}

const warte = (versuch) => new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 25) * (versuch + 1)));

/**
 * Vergibt die Nummer für eine Bestellung am Tag `tag` (YYYY-MM-DD).
 * Gleiche Bestellnummer = gleiche Nummer. Wirft nach 12 verlorenen
 * Schreibversuchen; Aufrufer fangen das ab (eine Bestellung ohne Nummer ist
 * besser als keine Bestellung).
 * @returns {Promise<{nr:number, tag:string, neu:boolean}>}
 */
async function vergebeAbholnr(ref, tag, optionen) {
  const s = (optionen && optionen.store) || store();
  const t = /^\d{4}-\d{2}-\d{2}$/.test(String(tag || '')) ? tag : berlinTag();
  const key = 't:' + t;
  const r = String(ref || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 60);

  for (let versuch = 0; versuch < 12; versuch++) {
    let roh = null, etag = null;
    if (typeof s.getWithMetadata === 'function') {
      const g = await s.getWithMetadata(key, { type: 'json' });
      if (g) { roh = g.data; etag = g.etag || null; }
    } else {
      roh = await s.get(key, { type: 'json' });
    }
    const stand = (roh && typeof roh === 'object') ? roh : null;
    const refs = (stand && stand.refs && typeof stand.refs === 'object') ? stand.refs : {};
    if (r && Number.isInteger(refs[r]) && refs[r] > 0) return { nr: refs[r], tag: t, neu: false };

    const n = Math.max(0, parseInt(stand && stand.n, 10) || 0) + 1;
    const neu = { n, refs: r ? { ...refs, [r]: n } : refs, at: new Date().toISOString() };
    const bedingung = stand ? (etag ? { onlyIfMatch: etag } : {}) : { onlyIfNew: true };
    const res = await s.setJSON(key, neu, bedingung);
    if (res && res.modified === false) { await warte(versuch); continue; }
    return { nr: n, tag: t, neu: true };
  }
  throw new Error('abholnr: nach 12 Versuchen keine Nummer frei');
}

/** Anzeige wie überall: „Nr. 47" */
function nrText(nr) {
  return Number.isInteger(nr) && nr > 0 ? 'Nr. ' + nr : '';
}

module.exports = {
  vergebeAbholnr, abholTagFuer, nrText,
  berlinTag, berlinMinute, plusTage, wochentag, istGeoeffnet, oeffnungAm,
};
