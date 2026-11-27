'use strict';
/**
 * zeit.js
 * ----------------------------------------------------------------------------
 * Stempeln für die Zeiterfassung (Spec im GNC Office: docs/superpowers/specs/2026-11-26-zeiterfassung-4a-design.md).
 * Grill'n Chill speichert keine Zeiten. Diese Function prüft, wer stempelt, setzt Person, Gerät und geplante Schicht
 * aus dem Dienstplan und reicht signiert ans Office weiter (lib/office-zeit.js, POST /api/zeit).
 *
 * Anmeldung, eines von beiden:
 *   stempeluhr: <Token>   Kubis iPad am Truck (lib/team-device.js, Zweck stempeluhr): jede Person aus dem Dienstplan
 *   password: <Sitzung>   Handy, Team-Sitzung mit Zwei-Faktor: nur die Person, deren login der eigene Zugang ist
 *
 *   POST { aktion:'stand' }                                        → { ok, heute, geraet?, personen:[{ id, name, farbe, schicht, stand }] }
 *   POST { aktion:'stempeln', schluessel, person_id, art, zeit }   → Antwort des Office (200, 409 zustand, 400)
 *   POST { aktion:'zuruecknehmen', schluessel, person_id, bezug_schluessel, zeit }   → 200 oder 409 nicht_zuruecknehmbar
 *   POST { aktion:'woche', montag, person_id? }   nur Handy         → { ok, montag, tage, summe }
 *
 * Fehler: 401 unauthorized, 403 keine_person | fremde_person | nur_handy, 404 person_fehlt, 400 eingabe,
 *         503 office_weg | speicher_gestoert (Office nicht erreichbar bzw. Geräte-Speicher gestört: das Gerät behält Token und
 *         Stempel und sendet später; ein Speicherfehler ist nie ein 401).
 *
 * Bremse: Ein Stempeluhr-Token besteht aus 32 Zufallsbytes und lässt sich nicht raten. Ein falscher Token zählt
 * deshalb NICHT als Fehlversuch (lib/auth-guard.js): ein entkoppeltes iPad, das jede Minute nachsendet, würde sonst
 * das Truck-WLAN für das Admin-Tool sperren. Die Team-Sitzung läuft durch die Bremse wie überall.
 * ----------------------------------------------------------------------------
 */
const { getStore } = require('@netlify/blobs');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { schutz } = require('./lib/bremse');
const { passwortAusSitzung } = require('./lib/admin-sitzung');
const { mitglied } = require('./lib/team-passwort');
const geraete = require('./lib/team-device');
const { anOffice } = require('./lib/office-zeit');
const D = require('./lib/zeit-dienst');

const ARTEN = ['beginn', 'pause_beginn', 'pause_ende', 'ende'];
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(data),
});
const fehler = (statusCode, code, hint) => json(statusCode, { ok: false, fehler: code, ...(hint ? { hint } : {}) });

function teamStore() {
  const opts = { name: 'team', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

/* Team-Zugang zum Passwort aus der Sitzung. Kubi (Hauptpasswort) hat keinen Login und damit keine Person. */
async function teamLogin(pw) {
  if (!pw) return null;
  const admin = process.env.ADMIN_PASSWORD || '';
  if (admin && pw === admin) return { login: null, name: 'Kubi' };
  try {
    const { key, u } = (await mitglied(teamStore(), pw)) || {};
    if (u) return { login: key.slice(2), name: u.name || key.slice(2) };
  } catch (e) {}
  return null;
}

async function anmeldung(event, input) {
  if (typeof input.stempeluhr === 'string' && input.stempeluhr) {
    const dev = await geraete.pruefeStempeluhr(input.stempeluhr.slice(0, 200));
    // Speicher gestört: 503, nicht 401. Das iPad behält Token und Stempel und sendet später (kein Fehlversuch)
    if (dev && dev.speicher) return { antwort: fehler(503, 'speicher_gestoert', 'Gerade nicht erreichbar. Der Stempel bleibt auf dem iPad.') };
    if (!dev) return { antwort: fehler(401, 'unauthorized', 'Dieses iPad ist nicht mehr als Stempeluhr gekoppelt.') };
    return { wer: { art: 'stempeluhr', id: dev.id, geraet: dev.name } };
  }
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return { antwort: gesperrt };
  const t = await teamLogin(await passwortAusSitzung(String(input.password || '').slice(0, 200)));
  await meldeErgebnis(event, !!t);
  if (!t) return { antwort: fehler(401, 'unauthorized') };
  return { wer: { art: 'handy', login: t.login, name: t.name } };
}

const herkunft = (wer) => (wer.art === 'stempeluhr'
  ? { quelle: 'stempeluhr', geraet: String(wer.geraet || 'iPad Truck').slice(0, 40), von: 'geraet:' + wer.id }
  : { quelle: 'handy', geraet: 'Handy', von: D.vonLogin(wer.login) });
const weiter = (r) => json(r.status, r.daten);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return fehler(405, 'method_not_allowed');
  const halt = await schutz(event, { name: 'zeit', max: 240, maxKB: 8 });
  if (halt) return halt;
  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return fehler(400, 'eingabe'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fehler(400, 'eingabe');

  const a = await anmeldung(event, input);
  if (a.antwort) return a.antwort;
  const wer = a.wer;
  const aktion = String(input.aktion || '');

  try {
    const personal = await D.lesePersonal();
    let eigene = null;
    if (wer.art === 'handy') {
      eigene = wer.login ? personal.find((p) => p.login === wer.login) || null : null;
      if (!eigene) return fehler(403, 'keine_person', 'Kubi muss dich im Dienstplan deinem Login zuordnen.');
      if (input.person_id !== undefined && input.person_id !== eigene.id) return fehler(403, 'fremde_person');
    }
    const heute = D.berlinTag(Date.now());

    if (aktion === 'stand') {
      const liste = D.personenListe(eigene ? [eigene] : personal, await D.lesePlan(D.montagVon(heute)), heute);
      const r = await anOffice({ aktion: 'stand', heute, personen: liste.map((p) => ({ id: p.id, name: p.name, schicht: p.schicht })) });
      if (r.status !== 200) return weiter(r);
      const je = new Map((r.daten.personen || []).map((x) => [x.id, x]));
      return json(200, { ok: true, heute, geraet: wer.art === 'stempeluhr' ? wer.geraet : null, personen: liste.map((p) => ({ ...p, stand: je.get(p.id) || null })) });
    }

    if (aktion === 'woche') {
      if (!eigene) return fehler(403, 'nur_handy');
      if (!D.istMontag(input.montag)) return fehler(400, 'eingabe');
      return weiter(await anOffice({ aktion: 'woche', person_id: eigene.id, montag: input.montag }));
    }

    if (aktion !== 'stempeln' && aktion !== 'zuruecknehmen') return fehler(400, 'aktion');
    const person = eigene || personal.find((p) => p.id === input.person_id);
    if (!person) return fehler(404, 'person_fehlt');
    const zeit = String(input.zeit || '');
    if (!UUID4.test(String(input.schluessel || '')) || !ISO.test(zeit) || !Number.isFinite(Date.parse(zeit))) return fehler(400, 'eingabe');

    if (aktion === 'zuruecknehmen') {
      if (!UUID4.test(String(input.bezug_schluessel || ''))) return fehler(400, 'eingabe');
      return weiter(await anOffice({ aktion: 'zuruecknehmen', schluessel: input.schluessel, person_id: person.id, bezug_schluessel: input.bezug_schluessel, zeit, ...herkunft(wer) }));
    }
    if (!ARTEN.includes(input.art)) return fehler(400, 'eingabe');
    // Schicht am Tag des Stempels (aus der Warteschlange kann er von gestern sein)
    const tag = D.berlinTag(Date.parse(zeit));
    const schicht = D.schichtAm(await D.lesePlan(D.montagVon(tag)), tag, person.id);
    return weiter(await anOffice({ aktion: 'stempeln', schluessel: input.schluessel, person: { id: person.id, name: person.name }, art: input.art, zeit, ...herkunft(wer), schicht }));
  } catch (e) {
    console.error('zeit:', e && e.message);
    return fehler(503, 'office_weg');
  }
};
