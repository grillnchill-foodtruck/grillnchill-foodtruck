'use strict';
/**
 * office-meldungen.js (geplant, stündlich um :20, arbeitet einmal je Nacht ab 01:00 Uhr Berlin)
 * Baut die Meldungen der letzten 14 Tage fürs GNC Office und schickt sie (Plan 2).
 * Tagesmeldungen gehen jede Nacht für das ganze Fenster raus: Das Office ignoriert gleiche Fassungen und
 * meldet geänderte als abweichend. Das ist der nächtliche Summenabgleich. Rechnungen und Zahlungen gehen nur,
 * bis das Office sie angenommen hat. Hat ein Tag, für den schon gemeldet wurde, keine Posten mehr, geht er mit
 * posten [] raus (das Office legt das als abweichend ab). Gibt es nichts zu senden, geht ein leeres Paket als
 * Lebenszeichen raus; die Antwort bringt den Stand der Nachtsicherung im Office.
 * Scheitert ein Lauf (Office nicht erreichbar, Lesefehler im Shop), versucht es die nächste Stunde wieder.
 * Bewusst nicht in orders-reconcile: Der Lauf bestätigt Zahlungen und darf nicht ins 30-Sekunden-Limit laufen.
 *
 * SumUp-Auszahlungen fehlen hier bewusst: Sie kommen mit Plan 3, weil sie Truck-Kartenumsätze und einen
 * Einbehalt der SumUp-Finanzierung enthalten.
 *
 * Blob-Store office-lauf: fertig:<Tag>, versuch:<Tag> ({ n, gemeldet }), gesendet:<Tag>:<Meldungsschlüssel>,
 * hinweis:<Tag>:<Hash>, fehler-gemeldet:<Tag>:<Meldungsschlüssel>:<Fassung>, abweichung-gemeldet:<Tag>:<Meldungsschlüssel>:<Fassung>,
 * start (Stichtag JJJJ-MM-TT, optional: früher meldet der Lauf nichts).
 *
 * Umzug auf die echte Datenbank des Office (31.12.2026)
 * Reihenfolge ist Pflicht: Schritt 1 (Stichtag) VOR dem Umschalten des Office auf die echte Datenbank, spätestens vor
 * dem Lauf um 01:20 am ersten Tag. Schaltet das Office zuerst um, landen die letzten 14 Tage der Probe in der echten
 * Datenbank und lassen sich dort nur noch per Storno korrigieren. Den Stichtag früher zu setzen schadet nicht: bis zum
 * Umzug geht dann nur das Lebenszeichen raus.
 * Bis dahin landen die Meldungen in der Probe-Datenbank. Die Befehle laufen aus einem Ordner ohne .netlify, mit
 * Kubis Netlify-Konto (netlify switch), und geben nur Schlüssel und das Datum aus, nie ein Geheimnis:
 *   export NETLIFY_SITE_ID=7cbf3f1b-5d01-44ba-bd5a-f71eb9b82893
 *   1. Stichtag setzen (erster Tag der echten Datenbank), dann prüfen:
 *        netlify blobs:set office-lauf start 2027-01-01 --force
 *        netlify blobs:get office-lauf start
 *   2. Vermerke der Probe-Datenbank leeren. Ohne gesendet:-Vermerke meldet der Lauf jede Rechnung und Zahlung im Fenster
 *      ab dem Stichtag neu (auch solche, die schon in die Probe-Datenbank gingen); ohne die beiden anderen meldet er
 *      Fehler und Abweichungen der echten Datenbank wieder an Kubi:
 *        for p in gesendet: fehler-gemeldet: abweichung-gemeldet:; do
 *          netlify blobs:list office-lauf --prefix "$p" --json \
 *            | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>JSON.parse(s).blobs.forEach((b)=>console.log(b.key)))' \
 *            | while read -r k; do netlify blobs:delete office-lauf "$k" --force; done
 *        done
 *      Prüfen, dass nichts übrig ist: netlify blobs:list office-lauf --prefix gesendet:
 *   3. Nach der ersten Nacht im Netlify-Log die Zeile {"lauf":"office-meldungen",…} ansehen (status fertig) und im Office
 *      unter „Shop“ prüfen, dass die Tage ab dem Stichtag angekommen sind.
 *   Rechnungen mit Datum vor dem Stichtag meldet der Lauf nicht mehr. Ist so eine Rechnung noch offen, scheitert ihre
 *   Zahlung im Office (posten_fehlt) und kommt als „Nicht gebucht“ zu Kubi: diese offenen Posten im Office von Hand anlegen.
 */
const crypto = require('crypto');
const { sammeln, store } = require('./lib/office-sammeln');
const { baueMeldungen, berlinTag, echterTag } = require('./lib/office-tag');
const { senden } = require('./lib/office-meldung');
const { geheimnisHolen } = require('./lib/geheimnisse');
const { telegram, esc } = require('./lib/telegram');

const FENSTER_TAGE = 14;
const AB_STUNDE = 1;
const MELDEN_BEIM_VERSUCH = 3;
const SICHERUNG_MAX_ALTER_TAGE = 2;
// Netlify bricht geplante Funktionen nach 30 Sekunden ab: ab dem Start höchstens 24 Sekunden für Sammeln und Senden
const BUDGET_MS = 24000;
const OFFICE = 'https://office.grillnchill-foodtruck.de/#/shop';
// Telegram: höchstens 25 Zeilen, je Zeile höchstens 500 Zeichen vor dem Maskieren, alles zusammen deutlich unter 4000
const MAX_ZEILEN = 25;
const MAX_ZEILE = 500;
const MAX_ZEICHEN = 3500;
const MAX_LISTE = 10;

const plusTage = (tag, n) => new Date(Date.parse(tag + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
// de-DE liefert "00 Uhr", deshalb parseInt statt Number
const berlinStunde = (d) => parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).format(d), 10);
const tagText = (t) => `${t.slice(8, 10)}.${t.slice(5, 7)}.${t.slice(0, 4)}`;
const hashVon = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
const fassungVon = (m) => hashVon(JSON.stringify(m.daten)).slice(0, 12);

function lesbar(schluessel) {
  const [art, wert] = schluessel.split(':');
  if (art === 'tag') return 'Tag ' + tagText(wert);
  if (art === 'rechnung') return 'Rechnung ' + wert;
  if (art === 'zahlung') return 'Zahlung zu ' + wert;
  return schluessel;
}

const aufzaehlen = (liste) => (liste.length <= MAX_LISTE ? liste.join(', ') : liste.slice(0, MAX_LISTE).join(', ') + ` und ${liste.length - MAX_LISTE} weitere`);

// Telegram-Nachricht aus Textzeilen (Rohtext). Gekürzt wird vor dem Maskieren, so schneidet nichts eine HTML-Entität.
function nachricht(teile) {
  const zeilen = [];
  let zeichen = 0;
  for (const t of teile) {
    const roh = [...String(t)];
    const z = esc(roh.length > MAX_ZEILE ? roh.slice(0, MAX_ZEILE - 1).join('') + '…' : roh.join(''));
    if (zeilen.length >= MAX_ZEILEN || (zeilen.length && zeichen + z.length > MAX_ZEICHEN)) break;
    zeilen.push(z);
    zeichen += z.length + 1;
  }
  const rest = teile.length - zeilen.length;
  if (rest > 0) zeilen.push(`und ${rest} weitere, Details im Office`);
  return ['<b>GNC Office</b>', ...zeilen, OFFICE].join('\n');
}

// Warum ein Lauf gescheitert ist, in einem Satz für Kubi
function ursache(fehler, lesefehler) {
  const f = String(fehler || '');
  if (f === 'frist' || f === 'zeitlimit') return 'Das Office hat zu langsam geantwortet.';
  if (f === 'nicht_eingerichtet') return 'Das gemeinsame Geheimnis fehlt im Shop.';
  if (f.startsWith('office_401')) return 'Das Office hat die Signatur abgelehnt.';
  if (f.startsWith('netz')) return 'Das Office war nicht erreichbar.';
  if (f === 'lesefehler') return `Der Shop konnte ${lesefehler === 1 ? 'einen Datensatz' : lesefehler + ' Datensätze'} nicht lesen. Gib Pasquale Bescheid.`;
  if (f === 'start_ungueltig') return 'Der Stichtag für die Office-Meldungen ist ungültig. Gib Pasquale Bescheid.';
  return `Das Office hat mit einem Fehler geantwortet (${f.slice(0, 60)}).`;
}

// Stichtag aus office-lauf/start: null = keiner, false = unlesbar. netlify blobs:set speichert Text, setJSON einen JSON-Text.
function stichtag(roh) {
  const s = String(roh == null ? '' : roh).trim().replace(/^"(.*)"$/, '$1');
  if (!s) return null;
  return echterTag(s) ? s : false;
}

// Was das Office angenommen hat, nicht noch einmal schicken. Ausnahmen: Format abgelehnt, an der Prüfung gescheitert (ungueltig_…,
// eine korrigierte Fassung soll ersetzen können) und Fassungen, die im Office noch fehlerhaft oder unfertig (neu) liegen.
const vermerken = (e) => !(e.status === 'ungueltig' || (e.status === 'fehler' && /^ungueltig/.test(e.fehler || ''))
  || (e.status === 'doppelt' && ['fehler', 'neu'].includes(e.zustand)));
const istAbweichend = (e) => e.status === 'abweichend' || (e.status === 'doppelt' && e.zustand === 'abweichend');

// Alte Vermerke ohne Datum im Schlüssel (frühere Fassung) und neue mit Datum: <Art>:<Tag>:<Rest>
const DATIERT = /^(?:gesendet|hinweis|fehler-gemeldet|abweichung-gemeldet):(\d{4}-\d{2}-\d{2}):/;
const ohneTag = (key, art) => key.slice(art.length + 1).replace(/^\d{4}-\d{2}-\d{2}:/, '');

async function lauf({ jetzt = new Date(), budgetMs = BUDGET_MS } = {}) {
  const start = Date.now();
  const heute = berlinTag(jetzt);
  if (berlinStunde(jetzt) < AB_STUNDE) return { status: 'zu_frueh' };
  const ls = store('office-lauf');
  if (await ls.get('fertig:' + heute)) return { status: 'schon_fertig' };
  const bis = plusTage(heute, -1);
  let von = plusTage(heute, -FENSTER_TAGE);
  const am = jetzt.toISOString();

  // Versuch zuerst zählen: Auch ein Lauf, den Netlify nach 30 Sekunden abbricht, zählt mit
  const vorher = (await ls.get('versuch:' + heute, { type: 'json' })) || {};
  const v = (vorher.n || 0) + 1;
  let gemeldet = !!vorher.gemeldet;
  await ls.setJSON('versuch:' + heute, { ...vorher, n: v });
  // Die vorigen Versuche dieser Nacht endeten ohne Ergebnis und ohne Nachricht: Sie sind abgebrochen. Gleich melden,
  // bevor auch dieser Lauf abbricht. (Gescheiterte Läufe mit Grund melden sich selbst beim dritten Versuch, siehe unten.)
  if ((vorher.n || 0) >= MELDEN_BEIM_VERSUCH && !gemeldet
    && await telegram(nachricht([`Die Office-Meldungen sind heute Nacht ${vorher.n}-mal abgebrochen. Der Shop versucht es stündlich weiter.`]), { html: true })) {
    gemeldet = true;
    await ls.setJSON('versuch:' + heute, { n: v, gemeldet: true });
  }

  const messung = { sammeln_ms: 0, senden_ms: 0, lesezugriffe: 0, lesefehler: 0, meldungen: 0, pakete: 0 };
  let fehlerText = null;
  let r = { ergebnisse: [], offen: null, sicherung: undefined };
  let hinweise = [];
  let zuSenden = [];
  const teile = [];
  const neueMerker = [];
  let hinweisGemeldet = new Set();

  // Ohne Geheimnis kann nichts raus: dann gar nicht erst Tausende Blobs lesen
  const geheimnis = await geheimnisHolen('office-eingang-secret', 'OFFICE_EINGANG_SECRET');
  if (geheimnis.length < 32) fehlerText = 'nicht_eingerichtet';

  // Stichtag (Umzug auf die echte Datenbank): davor meldet der Lauf nichts
  if (!fehlerText) {
    const s = stichtag(await ls.get('start'));
    if (s === false) fehlerText = 'start_ungueltig';
    else if (s && s > von) von = s;
  }

  let meldungen = [];
  if (!fehlerText && von <= bis) {
    const t0 = Date.now();
    const daten = await sammeln(von, bis);
    messung.sammeln_ms = Date.now() - t0;
    messung.lesezugriffe = daten.lesezugriffe;
    messung.lesefehler = daten.lesefehler;
    // Fail-closed: Mit lückenhaften Daten entstünden falsche Tagesmeldungen (und leere Tage)
    if (daten.lesefehler) fehlerText = 'lesefehler';
    else ({ meldungen, hinweise } = baueMeldungen({ von, bis, ...daten }));
  }

  if (!fehlerText) {
    // Vermerke einmal lesen (nur die Schlüssel)
    const schluessel = (await ls.list()).blobs.map((b) => b.key);
    const mengeVon = (art) => new Set(schluessel.filter((k) => k.startsWith(art + ':')).map((k) => ohneTag(k, art)));
    const gesendet = mengeVon('gesendet');
    hinweisGemeldet = mengeVon('hinweis');
    const fehlerGemeldet = mengeVon('fehler-gemeldet');
    const abweichungGemeldet = mengeVon('abweichung-gemeldet');

    // Schon angenommene Rechnungen und Zahlungen nicht noch einmal schicken. Tagesmeldungen gehen immer.
    zuSenden = meldungen.filter((m) => m.art === 'tag' || !gesendet.has(m.schluessel));
    // Ein Tag, für den schon gemeldet wurde, hat keine Posten mehr: mit posten [] melden, sonst bliebe die alte Fassung stehen
    const gebaut = new Set(meldungen.filter((m) => m.art === 'tag').map((m) => m.schluessel));
    const leer = [...gesendet].map((k) => /^tag:(\d{4}-\d{2}-\d{2}):online$/.exec(k)).filter((x) => x && x[1] >= von && x[1] <= bis && !gebaut.has(x[0]))
      .map((x) => x[1]).sort().map((tag) => ({ schluessel: `tag:${tag}:online`, art: 'tag', daten: { datum: tag, posten: [] } }));
    zuSenden.push(...leer);

    const t1 = Date.now();
    r = await senden(zuSenden, { geheimnis, frist: Math.max(0, budgetMs - (Date.now() - start)) });
    messung.senden_ms = Date.now() - t1;
    messung.meldungen = zuSenden.length;
    messung.pakete = r.pakete || 0;
    fehlerText = r.fehler;

    // Ergebnisse auswerten, auch im Fehlerlauf (das Office hat alles bis zum Fehler gespeichert).
    // Fehler und Abweichungen je Fassung einmal melden. Deren gesendet-Vermerk erst nach der Nachricht schreiben:
    // Geht die Nachricht nicht raus, kommt die Meldung wieder und wird dann gemeldet.
    const fassung = new Map(zuSenden.map((m) => [m.schluessel, fassungVon(m)]));
    // Ein Fehler kommt in der Folgenacht als „doppelt“ mit zustand „fehler“ zurück: auch dann einmal je Fassung melden,
    // sonst geht er verloren, wenn Telegram beim ersten Mal ausfiel oder der Lauf nach dem Senden abbrach.
    const istFehler = (e) => e.status === 'fehler' || (e.status === 'doppelt' && e.zustand === 'fehler');
    const sofort = [];
    const fehlerhaft = [];
    const abweichend = [];
    for (const e of r.ergebnisse) {
      const id = e.schluessel + ':' + fassung.get(e.schluessel);
      let melden = false;
      if (istFehler(e) && !fehlerGemeldet.has(id)) { fehlerhaft.push(e); neueMerker.push(`fehler-gemeldet:${heute}:${id}`); melden = true; }
      if (istAbweichend(e) && !abweichungGemeldet.has(id)) { abweichend.push(e); neueMerker.push(`abweichung-gemeldet:${heute}:${id}`); melden = true; }
      if (vermerken(e) && !gesendet.has(e.schluessel)) (melden ? neueMerker : sofort).push(`gesendet:${heute}:${e.schluessel}`);
    }
    await Promise.all(sofort.map((k) => ls.setJSON(k, { am })));
    if (fehlerhaft.length) teile.push('Nicht gebucht: ' + aufzaehlen(fehlerhaft.map((e) => `${lesbar(e.schluessel)} (${e.fehler})`)) + '.');
    if (abweichend.length) teile.push('Weicht ab vom ersten Stand: ' + aufzaehlen(abweichend.map((e) => lesbar(e.schluessel))) + '. Bitte im Office prüfen.');
  }

  let versuchMelden = false;
  if (!fehlerText) {
    const ungueltig = r.ergebnisse.filter((e) => e.status === 'ungueltig').map((e) => lesbar(e.schluessel));
    if (ungueltig.length) teile.push('Vom Office abgelehnt, bitte Pasquale Bescheid geben: ' + aufzaehlen(ungueltig) + '.');
    // Hinweise mit Tag gehen nur am Tag bis raus, Hinweise ohne Tag (zum Beispiel kaputtes Datum) genau einmal
    for (const h of hinweise) {
      if (h.tag === bis) teile.push(h.text);
      else if (h.tag == null) {
        const hash = hashVon(h.text);
        if (!hinweisGemeldet.has(hash)) { teile.push(h.text); neueMerker.push(`hinweis:${heute}:${hash}`); hinweisGemeldet.add(hash); }
      }
    }
    if (!teile.length && r.offen > 0) teile.push(`${r.offen} Meldung${r.offen === 1 ? '' : 'en'} im Office ${r.offen === 1 ? 'wartet' : 'warten'} noch auf deinen Blick.`);

    // Nachtsicherung im Office: nur prüfen, wenn die Antwort das Feld überhaupt hat (höchstens einmal am Tag, weil der Lauf nur einmal fertig wird)
    if (r.sicherung === null) teile.push('Im Office gibt es noch keine Nachtsicherung. Gib Pasquale Bescheid.');
    else if (r.sicherung !== undefined && String(r.sicherung) < plusTage(heute, -SICHERUNG_MAX_ALTER_TAGE)) teile.push(`Die letzte Nachtsicherung im Office ist vom ${tagText(String(r.sicherung))}. Gib Pasquale Bescheid.`);
  } else if (v >= MELDEN_BEIM_VERSUCH && !gemeldet) {
    versuchMelden = true;
    teile.push(`Die Office-Meldungen sind heute Nacht ${v}-mal gescheitert. ${ursache(fehlerText, messung.lesefehler)} Der Shop versucht es stündlich weiter.`);
  }

  let telegrammOk = true;
  if (teile.length) telegrammOk = await telegram(nachricht(teile), { html: true });
  if (telegrammOk) {
    await Promise.all(neueMerker.map((k) => ls.setJSON(k, { am })));
    if (versuchMelden) await ls.setJSON('versuch:' + heute, { n: v, gemeldet: true });
  }
  if (!fehlerText) await ls.setJSON('fertig:' + heute, { am, gesendet: zuSenden.length });
  if (heute.endsWith('-01')) await aufraeumen(ls, heute);
  const status = fehlerText ? 'fehler' : 'fertig';
  // Eine Zeile je Lauf fürs Netlify-Log, ohne personenbezogene Daten
  console.log(JSON.stringify({ lauf: 'office-meldungen', tag: heute, versuch: v, status, fehler: fehlerText ? String(fehlerText).slice(0, 60) : null, ...messung }));
  return { status, gesendet: zuSenden.length, ergebnisse: r.ergebnisse, fehler: fehlerText, offen: r.offen, lesefehler: messung.lesefehler };
}

// Einmal im Monat: Vermerke älter als 60 Tage weg (Fenster 14 Tage, Rest ist Puffer).
// Schlüssel mit Datum werden nur nach dem Namen beurteilt, nur alte Schlüssel ohne Datum muss es lesen.
async function aufraeumen(ls, heute) {
  const grenze = plusTage(heute, -60);
  for (const b of (await ls.list()).blobs) {
    const datiert = DATIERT.exec(b.key);
    if (datiert) { if (datiert[1] < grenze) await ls.delete(b.key); continue; }
    if (/^(fertig|versuch|sicherung):/.test(b.key)) {
      if (b.key.slice(b.key.indexOf(':') + 1, b.key.indexOf(':') + 11) < grenze) await ls.delete(b.key);
    } else if (/^(gesendet|hinweis|fehler-gemeldet):/.test(b.key)) {
      const w = await ls.get(b.key, { type: 'json' });
      if (!w || String(w.am).slice(0, 10) < grenze) await ls.delete(b.key);
    }
  }
  const es = store('office-ereignisse');
  for (const b of (await es.list({ prefix: 'erstattung:' })).blobs) if (b.key.slice(11, 21) < grenze) await es.delete(b.key);
}

exports.lauf = lauf;
exports.nachricht = nachricht;
exports.handler = async () => {
  try {
    const r = await lauf();
    return { statusCode: 200, body: JSON.stringify({ ok: true, status: r.status, gesendet: r.gesendet || 0, fehler: r.fehler || null }) };
  } catch (e) {
    console.error('office-meldungen', e && e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false }) };
  }
};
