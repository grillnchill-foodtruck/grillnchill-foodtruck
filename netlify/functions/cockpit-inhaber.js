/**
 * cockpit-inhaber.js
 * ----------------------------------------------------------------------------
 * Auswertungen im Cockpit, nur für den Inhaber: Hauptpasswort (superadmin,
 * mit Zwei-Faktor-Sitzung) oder ein Team-Gerät, das Kubi selbst gekoppelt
 * hat (owner). Gleiche Regel wie der Umsatz in cockpit-data.js.
 *
 *   POST { password | teamToken, action }
 *
 *   action 'speisekarte'       Menü-Engineering der letzten 30 Tage bis gestern
 *     → { ok, zeitraum:{von,bis,tage}, bestellungen, ohne, gruppen,
 *         artikel:[{ id, name, cat, preis, satz, extra, qty, haupt, umsatz,
 *                    nettoUmsatz, nettoKarte, nettoSchnitt, cost, db, quote, updatedAt }],
 *         tafeln:{ burger|sides|dips|drinks|alle: { n, gesamt, schwelleAnteil,
 *                  schwelleStueck, schnittDb, leer, punkte:{ id:{anteil,beliebt,hoch,feld,hinweis} } } } }
 *   action 'kosten_speichern'  { kosten: { <artikel-id>: Zahl | null } }
 *     Speichert den Wareneinsatz je Stück im Store 'kosten', Schlüssel
 *     'artikel' ({ id: { cost, updatedAt } }). null oder '' löscht den Wert.
 *     → wie 'speisekarte'
 *   action 'bericht_vorschau'  → { ok, text, von, bis }
 *   action 'bericht_senden'    → { ok, gesendet, text, von, bis }
 * ----------------------------------------------------------------------------
 */

const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung } = require('./lib/admin-sitzung');
const { mitglied } = require('./lib/team-passwort');
const { schutz } = require('./lib/bremse');
const tw = require('./lib/tageswerte');
const ma = require('./lib/menue-analyse');
const wb = require('./lib/wochenbericht');

const SK = require('../../speisekarte.js');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
  body: JSON.stringify(data),
});

const TAGE = 30;
const MAX_KOSTEN = 50;   // Euro je Stück; alles darüber ist ein Tippfehler

/* Anmeldung wie in cockpit-data.js */
async function authRole(pw) {
  if (!pw) return null;
  const admin = process.env.ADMIN_PASSWORD || '';
  if (admin && pw === admin) return { role: 'superadmin', name: 'Kubi' };
  try {
    const t = tw.store('team');
    const { blobs } = await t.list({ prefix: 'u:' });
    const { key, u } = (await mitglied(t, pw, blobs)) || {};
    if (u) return { role: u.role === 'admin' ? 'admin' : 'staff', name: u.name || key.slice(2) };
  } catch (e) {}
  return null;
}
function teamPruefer() {
  try {
    const m = require('./lib/team-device');
    return (m && typeof m.pruefeTeamToken === 'function') ? m.pruefeTeamToken : null;
  } catch (e) {
    return null;
  }
}

/* Inhaber? Liefert { who, antwort }. antwort ist gesetzt, wenn abgelehnt wird. */
async function anmeldung(event, input) {
  let who = null;
  if (input.password) {
    who = await authRole(await passwortAusSitzung(String(input.password).slice(0, 200)));
    await meldeErgebnis(event, !!who);
  } else if (input.teamToken) {
    const pruefe = teamPruefer();
    if (!pruefe) return { antwort: json(401, { error: 'unauthorized' }) };
    let res = null;
    try { res = await pruefe(String(input.teamToken).slice(0, 200)); } catch (e) { res = null; }
    await meldeErgebnis(event, !!res);
    if (res) who = { role: 'team', name: res.name || 'Team-Gerät', owner: !!res.owner };
  }
  if (!who) return { antwort: json(401, { error: 'unauthorized' }) };
  const owner = who.role === 'superadmin' || who.owner === true;
  if (!owner) return { antwort: json(403, { error: 'forbidden', hint: 'Nur für den Inhaber.' }) };
  return { who };
}

/* ---------------- Wareneinsatz ---------------- */
async function liesKosten() {
  try {
    const k = await tw.store('kosten').get('artikel', { type: 'json' });
    return k && typeof k === 'object' && !Array.isArray(k) ? k : {};
  } catch (e) {
    return {};
  }
}

/* Eingabe prüfen: nur bekannte Artikel, Zahl von 0 bis 50 Euro, Komma erlaubt. */
function pruefeKosten(roh) {
  if (!roh || typeof roh !== 'object' || Array.isArray(roh)) return { fehler: 'Keine Werte übergeben.' };
  const ids = ma.erlaubteIds(SK);
  const namen = {};
  for (const a of ma.artikelListe(SK)) namen[a.id] = a.name;
  const keys = Object.keys(roh);
  if (keys.length > 100) return { fehler: 'Zu viele Werte.' };
  const aus = {};
  for (const id of keys) {
    if (!ids.has(id)) return { fehler: 'Unbekannter Artikel.' };
    const v = roh[id];
    if (v === null || v === '' || v === undefined) { aus[id] = null; continue; }
    let x = NaN;
    if (typeof v === 'number') x = v;
    else if (typeof v === 'string' && /^\s*\d{1,3}([.,]\d{1,3})?\s*$/.test(v)) x = Number(v.trim().replace(',', '.'));
    if (!Number.isFinite(x) || x < 0 || x > MAX_KOSTEN) {
      return { fehler: 'Wareneinsatz für ' + namen[id] + ' ist keine Zahl von 0 bis ' + MAX_KOSTEN + ' €.' };
    }
    aus[id] = Math.round(x * 100) / 100;
  }
  return { werte: aus };
}

async function speichereKosten(werte) {
  const s = tw.store('kosten');
  const alt = await liesKosten();
  const neu = { ...alt };
  const jetzt = new Date().toISOString();
  for (const [id, cost] of Object.entries(werte)) {
    if (cost === null) { delete neu[id]; continue; }
    if (!neu[id] || neu[id].cost !== cost) neu[id] = { cost, updatedAt: jetzt };
  }
  await s.setJSON('artikel', neu);
  return neu;
}

/* ---------------- Auswertung ---------------- */
async function speisekarte(kosten) {
  const jetzt = Date.now();
  const heute = tw.berlinDate(jetzt);
  const bis = tw.plusTage(heute, -1);
  const von = tw.plusTage(heute, -TAGE);
  const tage = await tw.liesTage(tw.tageVonBis(von, bis), { jetzt });
  const summe = tw.summiere(tw.tageVonBis(von, bis).map((d) => tage[d]));
  const a = ma.auswerten(SK, summe, kosten);
  return {
    ok: true,
    zeitraum: { von, bis, tage: TAGE },
    bestellungen: summe.orders,
    ohne: summe.ohne,
    gruppen: ma.GRUPPEN,
    artikel: a.artikel,
    tafeln: a.tafeln,
    stand: new Date(jetzt).toISOString(),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  const halt = await schutz(event, { name: 'cockpit-inhaber', max: 120, maxKB: 32 });
  if (halt) return halt;

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return json(400, { error: 'invalid_json' });

  // Bremse gegen Durchprobieren, siehe lib/auth-guard.js
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;
  const { antwort } = await anmeldung(event, input);
  if (antwort) return antwort;

  const action = String(input.action || '');
  try {
    if (action === 'speisekarte') {
      return json(200, await speisekarte(await liesKosten()));
    }
    if (action === 'kosten_speichern') {
      const { werte, fehler } = pruefeKosten(input.kosten);
      if (fehler) return json(400, { error: 'ungueltig', hint: fehler });
      const kosten = await speichereKosten(werte);
      return json(200, await speisekarte(kosten));
    }
    if (action === 'bericht_vorschau' || action === 'bericht_senden') {
      const senden = action === 'bericht_senden';
      if (senden) {
        // Telegram nicht fluten, auch nicht mit gültiger Anmeldung
        const bremse = await schutz(event, { name: 'wochenbericht-jetzt', max: 6, fensterMin: 10 });
        if (bremse) return bremse;
      }
      const r = await wb.sendeWochenbericht({ nurVorschau: !senden });
      return json(200, { ok: true, gesendet: senden ? r.gesendet : false, text: r.text, von: r.von, bis: r.bis });
    }
    return json(400, { error: 'unknown_action' });
  } catch (e) {
    console.error('cockpit-inhaber ' + action + ':', e && e.message);
    return json(500, { error: 'failed', hint: 'Gerade nicht möglich. Bitte gleich noch einmal versuchen.' });
  }
};
