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

async function lauf({ jetzt = new Date() } = {}) {
  const heute = berlinTag(jetzt);
  if (berlinStunde(jetzt) < AB_STUNDE) return { status: 'zu_frueh' };
  const ls = store('office-lauf');
  if (await ls.get('fertig:' + heute)) return { status: 'schon_fertig' };
  const bis = plusTage(heute, -1);
  const von = plusTage(heute, -FENSTER_TAGE);

  const { meldungen, hinweise } = baueMeldungen({ von, bis, ...(await sammeln(von, bis)) });

  // Schon angenommene Rechnungen und Zahlungen nicht noch einmal schicken
  const gesendet = new Set((await ls.list({ prefix: 'gesendet:' })).blobs.map((b) => b.key.slice('gesendet:'.length)));
  const zuSenden = meldungen.filter((m) => m.art === 'tag' || !gesendet.has(m.schluessel));
  const r = await senden(zuSenden);
  for (const e of r.ergebnisse) {
    if (e.status !== 'ungueltig' && !e.schluessel.startsWith('tag:')) await ls.setJSON('gesendet:' + e.schluessel, { am: jetzt.toISOString() });
  }

  const teile = [];
  const abweichend = r.ergebnisse.filter((e) => e.status === 'abweichend').map((e) => lesbar(e.schluessel));
  const fehlerhaft = r.ergebnisse.filter((e) => e.status === 'fehler').map((e) => `${lesbar(e.schluessel)} (${e.fehler})`);
  const ungueltig = r.ergebnisse.filter((e) => e.status === 'ungueltig').map((e) => lesbar(e.schluessel));
  if (abweichend.length) teile.push('Weicht ab vom ersten Stand: ' + abweichend.join(', ') + '. Bitte im Office prüfen.');
  if (fehlerhaft.length) teile.push('Nicht gebucht: ' + fehlerhaft.join(', ') + '.');
  if (ungueltig.length) teile.push('Vom Office abgelehnt, bitte Pasquale Bescheid geben: ' + ungueltig.join(', ') + '.');

  const fehlerText = r.fehler;
  const neueMerker = [];
  if (!fehlerText) {
    // Hinweise mit Tag gehen nur am Tag bis raus, Hinweise ohne Tag (zum Beispiel kaputtes Datum) genau einmal
    for (const h of hinweise) {
      if (h.tag === bis) teile.push(h.text);
      else if (h.tag == null) {
        const merker = 'hinweis:' + hashVon(h.text);
        if (!(await ls.get(merker))) { teile.push(h.text); neueMerker.push(merker); }
      }
    }
    if (!teile.length && r.offen > 0) teile.push(`${r.offen} Meldung${r.offen === 1 ? '' : 'en'} im Office ${r.offen === 1 ? 'wartet' : 'warten'} noch auf deinen Blick.`);

    // Nachtsicherung im Office: nur prüfen, wenn die Antwort das Feld überhaupt hat, höchstens einmal am Tag
    if (r.sicherung !== undefined && !(await ls.get('sicherung:' + heute))) {
      if (r.sicherung === null) teile.push('Im Office gibt es noch keine Nachtsicherung. Gib Pasquale Bescheid.');
      else if (String(r.sicherung) < plusTage(heute, -SICHERUNG_MAX_ALTER_TAGE)) teile.push(`Die letzte Nachtsicherung im Office ist vom ${tagText(String(r.sicherung))}. Gib Pasquale Bescheid.`);
      if (teile.length && (r.sicherung === null || String(r.sicherung) < plusTage(heute, -SICHERUNG_MAX_ALTER_TAGE))) await ls.setJSON('sicherung:' + heute, { am: jetzt.toISOString() });
    }
  } else {
    const v = (((await ls.get('versuch:' + heute, { type: 'json' })) || {}).n || 0) + 1;
    await ls.setJSON('versuch:' + heute, { n: v });
    if (v === MELDEN_BEIM_VERSUCH) teile.push(`Das Office war heute Nacht ${v}-mal nicht erreichbar (${fehlerText}). Der Shop versucht es stündlich weiter.`);
  }

  let telegrammOk = true;
  if (teile.length) telegrammOk = await telegram('<b>GNC Office</b>\n' + teile.map(esc).join('\n') + '\n' + OFFICE, { html: true });
  if (telegrammOk) for (const m of neueMerker) await ls.setJSON(m, { am: jetzt.toISOString() });
  if (!fehlerText) await ls.setJSON('fertig:' + heute, { am: jetzt.toISOString(), gesendet: zuSenden.length });
  if (heute.endsWith('-01')) await aufraeumen(ls, heute);
  return { status: fehlerText ? 'fehler' : 'fertig', gesendet: zuSenden.length, ergebnisse: r.ergebnisse, fehler: fehlerText };
}

// Einmal im Monat: Vermerke älter als 60 Tage weg (Fenster 14 Tage, Rest ist Puffer)
async function aufraeumen(ls, heute) {
  const grenze = plusTage(heute, -60);
  for (const b of (await ls.list()).blobs) {
    if (/^(fertig|versuch|sicherung):/.test(b.key) && b.key.slice(b.key.indexOf(':') + 1) < grenze) await ls.delete(b.key);
    if (/^(gesendet|hinweis):/.test(b.key)) {
      const v = await ls.get(b.key, { type: 'json' });
      if (!v || String(v.am).slice(0, 10) < grenze) await ls.delete(b.key);
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
