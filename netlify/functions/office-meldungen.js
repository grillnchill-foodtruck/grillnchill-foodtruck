'use strict';
/**
 * office-meldungen.js (geplant, stündlich um :20, arbeitet einmal je Nacht ab 01:00 Uhr Berlin)
 * Baut die Meldungen der letzten 14 Tage fürs GNC Office und schickt sie (Plan 2).
 * Tagesmeldungen gehen jede Nacht für das ganze Fenster raus: Das Office ignoriert gleiche Fassungen und
 * meldet geänderte als abweichend. Das ist der nächtliche Summenabgleich. Rechnungen und Zahlungen
 * gehen nur, bis das Office sie angenommen hat.
 * Scheitert ein Lauf (Office nicht erreichbar), versucht es die nächste Stunde wieder.
 * Bewusst nicht in orders-reconcile: Der Lauf bestätigt Zahlungen und darf nicht ins 30-Sekunden-Limit laufen.
 *
 * SumUp-Auszahlungen fehlen hier bewusst: Sie kommen mit Plan 3, weil sie Truck-Kartenumsätze und einen
 * Einbehalt der SumUp-Finanzierung enthalten.
 */
const crypto = require('crypto');
const { sammeln, store } = require('./lib/office-sammeln');
const { baueMeldungen, berlinTag } = require('./lib/office-tag');
const { senden } = require('./lib/office-meldung');
const { telegram, esc } = require('./lib/telegram');

const FENSTER_TAGE = 14;
const AB_STUNDE = 1;
const MELDEN_BEIM_VERSUCH = 3;
const SICHERUNG_MAX_ALTER_TAGE = 2;
// Netlify bricht geplante Funktionen nach 30 Sekunden ab: ab dem Start höchstens 24 Sekunden für Sammeln und Senden
const BUDGET_MS = 24000;
const OFFICE = 'https://office.grillnchill-foodtruck.de/#/shop';

const plusTage = (tag, n) => new Date(Date.parse(tag + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
// de-DE liefert "00 Uhr", deshalb parseInt statt Number
const berlinStunde = (d) => parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).format(d), 10);
const tagText = (t) => `${t.slice(8, 10)}.${t.slice(5, 7)}.${t.slice(0, 4)}`;
const hashVon = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);

function lesbar(schluessel) {
  const [art, wert] = schluessel.split(':');
  if (art === 'tag') return 'Tag ' + tagText(wert);
  if (art === 'rechnung') return 'Rechnung ' + wert;
  if (art === 'zahlung') return 'Zahlung zu ' + wert;
  return schluessel;
}

// Alte Vermerke ohne Datum im Schlüssel (frühere Fassung) und neue mit Datum: <Art>:<Tag>:<Rest>
const DATIERT = /^(?:gesendet|hinweis|fehler-gemeldet):(\d{4}-\d{2}-\d{2}):/;
const ohneTag = (key, art) => key.slice(art.length + 1).replace(/^\d{4}-\d{2}-\d{2}:/, '');

async function lauf({ jetzt = new Date(), budgetMs = BUDGET_MS } = {}) {
  const start = Date.now();
  const heute = berlinTag(jetzt);
  if (berlinStunde(jetzt) < AB_STUNDE) return { status: 'zu_frueh' };
  const ls = store('office-lauf');
  if (await ls.get('fertig:' + heute)) return { status: 'schon_fertig' };
  const bis = plusTage(heute, -1);
  const von = plusTage(heute, -FENSTER_TAGE);

  // Versuch zuerst zählen: Auch ein Lauf, den Netlify nach 30 Sekunden abbricht, zählt mit
  const vorher = (await ls.get('versuch:' + heute, { type: 'json' })) || {};
  const v = (vorher.n || 0) + 1;
  await ls.setJSON('versuch:' + heute, { ...vorher, n: v });

  const { meldungen, hinweise } = baueMeldungen({ von, bis, ...(await sammeln(von, bis)) });

  // Vermerke einmal lesen (nur die Schlüssel): gesendet, schon gemeldete Hinweise, schon gemeldete Fehler
  const schluessel = (await ls.list()).blobs.map((b) => b.key);
  const mengeVon = (art) => new Set(schluessel.filter((k) => k.startsWith(art + ':')).map((k) => ohneTag(k, art)));
  const gesendet = mengeVon('gesendet');
  const hinweisGemeldet = mengeVon('hinweis');
  const fehlerGemeldet = mengeVon('fehler-gemeldet');

  // Schon angenommene Rechnungen und Zahlungen nicht noch einmal schicken
  const zuSenden = meldungen.filter((m) => m.art === 'tag' || !gesendet.has(m.schluessel));
  const r = await senden(zuSenden, { frist: Math.max(0, budgetMs - (Date.now() - start)) });
  const fehlerText = r.fehler;
  for (const e of r.ergebnisse) {
    if (e.status === 'ungueltig' || e.schluessel.startsWith('tag:')) continue;
    // Abweichung im Fehlerlauf nicht vermerken: Der nächste Lauf schickt sie wieder und meldet sie dann
    if (e.status === 'abweichend' && fehlerText) continue;
    await ls.setJSON(`gesendet:${heute}:${e.schluessel}`, { am: jetzt.toISOString() });
  }

  const teile = [];
  const neueMerker = [];
  // Fehlerzeilen sind schon als gesendet vermerkt und kommen nicht wieder: immer melden, aber je Meldung einmal
  const fehlerhaft = r.ergebnisse.filter((e) => e.status === 'fehler' && !fehlerGemeldet.has(e.schluessel));
  if (fehlerhaft.length) {
    teile.push('Nicht gebucht: ' + fehlerhaft.map((e) => `${lesbar(e.schluessel)} (${e.fehler})`).join(', ') + '.');
    for (const e of fehlerhaft) neueMerker.push(`fehler-gemeldet:${heute}:${e.schluessel}`);
  }

  let versuchMelden = false;
  if (!fehlerText) {
    // Im Fehlerlauf bleiben Abweichungen und Ablehnungen stehen: Der Erfolgslauf bekommt sie wieder und meldet sie dann
    const abweichend = r.ergebnisse.filter((e) => e.status === 'abweichend').map((e) => lesbar(e.schluessel));
    const ungueltig = r.ergebnisse.filter((e) => e.status === 'ungueltig').map((e) => lesbar(e.schluessel));
    if (abweichend.length) teile.push('Weicht ab vom ersten Stand: ' + abweichend.join(', ') + '. Bitte im Office prüfen.');
    if (ungueltig.length) teile.push('Vom Office abgelehnt, bitte Pasquale Bescheid geben: ' + ungueltig.join(', ') + '.');
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
  } else if (v >= MELDEN_BEIM_VERSUCH && !vorher.gemeldet) {
    versuchMelden = true;
    teile.push(/frist/.test(fehlerText)
      ? `Das Office hat zu langsam geantwortet (${v}. Versuch heute Nacht, ${fehlerText}). Der Shop versucht es stündlich weiter.`
      : `Das Office war heute Nacht ${v}-mal nicht erreichbar (${fehlerText}). Der Shop versucht es stündlich weiter.`);
  }

  let telegrammOk = true;
  if (teile.length) telegrammOk = await telegram('<b>GNC Office</b>\n' + teile.map(esc).join('\n') + '\n' + OFFICE, { html: true });
  if (telegrammOk) {
    for (const m of neueMerker) await ls.setJSON(m, { am: jetzt.toISOString() });
    if (versuchMelden) await ls.setJSON('versuch:' + heute, { n: v, gemeldet: true });
  }
  if (!fehlerText) await ls.setJSON('fertig:' + heute, { am: jetzt.toISOString(), gesendet: zuSenden.length });
  if (heute.endsWith('-01')) await aufraeumen(ls, heute);
  return { status: fehlerText ? 'fehler' : 'fertig', gesendet: zuSenden.length, ergebnisse: r.ergebnisse, fehler: fehlerText, offen: r.offen };
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
exports.handler = async () => {
  try {
    const r = await lauf();
    return { statusCode: 200, body: JSON.stringify({ ok: true, status: r.status, gesendet: r.gesendet || 0, fehler: r.fehler || null }) };
  } catch (e) {
    console.error('office-meldungen', e && e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false }) };
  }
};
