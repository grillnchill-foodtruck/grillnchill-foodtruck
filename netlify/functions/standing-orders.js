/**
 * standing-orders.js
 * ----------------------------------------------------------------------------
 * Stehende Bestellungen ("jeden Donnerstag, 12:30").
 *
 *   POST { action, email, token, ... }       (Kundenkonto)
 *     create   { weekday, time, mode, items, note?, remind }  → { ok, order }
 *     list     { }                                            → { ok, orders }
 *     pause    { id }                                         → { ok, order }
 *     resume   { id, weekday?, time? }                        → { ok, order }
 *     move     { id, weekday, time }  Zeitfenster aendern     → { ok, order }
 *     skipNext { id }                                         → { ok, order }
 *     remind   { id, remind }   Erinnerungen an/aus           → { ok, order }
 *     delete   { id }                                         → { ok }
 *
 *   POST ohne Anmeldung
 *     slots    { weekday, mode? }   → { ok, weekday, capacity, slots:[{ time, taken, free }] }
 *     byLink   { id, linkToken }    → { ok, order }   (aus der Erinnerungsmail)
 *
 *   POST Team
 *     plan     { password | teamToken, date:'JJJJ-MM-TT' }
 *              → { ok, date, weekday, capacity, slots:[{ time, orders, patties,
 *                  items:[{ name, qty }] }], totalOrders, totalPatties }
 *     settings { password, slotCapacity? }   (nur Admin)  → { ok, slotCapacity }
 *
 * ZEITFENSTER: Die Uhrzeit ist ein 15-Minuten-Fenster innerhalb der
 * Oeffnungszeiten des Wochentags (Regeln in lib/standing.js). Eine Zeit
 * ausserhalb des Rasters wird abgelehnt ('bad_slot'), nie still gerundet.
 * Je Wochentag und Fenster gibt es hoechstens slotCapacity aktive Reihen
 * (Store 'standing', Schluessel 'settings', Standard 6). Ist das Fenster
 * voll, antworten create, resume und move mit
 *     { ok:false, error:'slot_full', free:[bis zu 4 naechste freie Fenster] }
 * Bekannte Grenze: Zaehlen und Speichern sind kein atomarer Schritt. Legen
 * zwei Kunden im selben Augenblick die letzte Reihe an, kann ein Fenster
 * einmal um eins ueberbucht werden. Fuer eine Planungshilfe ist das tragbar.
 *
 * WICHTIG – Einwilligung:
 * Erinnerungen sind standardmäßig AUS. Der Kunde muss sie beim Anlegen oder
 * später ausdrücklich einschalten (remind: true). Ohne diese Zustimmung
 * verschicken wir keine einzige Erinnerungsmail. Der Zeitpunkt der Zustimmung
 * wird als remindConsentAt festgehalten, damit sie nachweisbar ist.
 *
 * Es wird NICHTS automatisch bestellt. Die stehende Bestellung erzeugt nur
 * eine Erinnerung mit vorbereitetem Warenkorb – bezahlt wird wie immer im
 * normalen Bestellvorgang. Ohne hinterlegte Zahlungsermächtigung wäre eine
 * automatische Bestellung weder technisch sauber noch dem Kunden gegenüber
 * fair.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const {
  naechsterTermin, berlinDatum, berlinZeitpunkt,
  wochentagAus, kapazitaetAus, slotUebersicht, pruefeSlot, tagesplan,
  KAPAZITAET_MAX,
} = require('./lib/standing');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung } = require('./lib/admin-sitzung');

/* Speisekarte fuer die Patty-Zaehlung im Tagesplan. Fehlt sie wider
   Erwarten im Buendel, zaehlt der Plan ueber den Artikelnamen weiter. */
let SK = null;
try { SK = require('../../speisekarte.js'); } catch (e) {
  console.error('standing-orders: speisekarte.js nicht ladbar:', e && e.message);
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, body) => ({
  statusCode, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(body),
});

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

/* Muss zeichengenau zu account.js passen: dort ist der Schluessel
   'c:' + sha256(normEmail) als VOLLER Hex-Wert. Vorher auf 32 Zeichen
   gekuerzt – damit wurde der Kundendatensatz nie gefunden. */
const normEmail = (e) => String(e || '').trim().toLowerCase().slice(0, 120);
const emailKey = (e) => 'c:' + crypto.createHash('sha256')
  .update(normEmail(e)).digest('hex');

/* Anmeldung prüfen. WICHTIG: rec.tokens ist ein OBJEKT { token: zeitstempel },
   kein Array – genau wie checkToken() in account.js. Vorher stand hier ein
   .some() auf dem Objekt; das wirft, wurde vom catch geschluckt und endete
   als 401. Deshalb schlug "Bestellung anlegen" fehl.

   Danach stand hier ein direktes rec.tokens[token]. Das nahm auch geerbte
   Eigenschaften an ("__proto__" & Co.) und liess jeden, der eine E-Mail-
   Adresse kannte, an die stehenden Bestellungen dieses Kontos. Die Prüfung
   liegt deshalb jetzt in lib/kunden-token.js – dort steht die ganze
   Begründung. */
const { tokenGueltig } = require('./lib/kunden-token');
async function authCustomer(email, token) {
  if (!email || !token) return null;
  try {
    const rec = await store('customers').get(emailKey(email), { type: 'json' });
    if (!tokenGueltig(rec, token)) return null;
    return rec;
  } catch (e) { return null; }
}

/* --- Team-Anmeldung: wie in dienstplan.js / orders-action.js -------------
   admin (ADMIN_PASSWORD) oder Team-Mitglied aus dem Store 'team'. Davor
   loest admin-sitzung einen Sitzungs-Token in das Passwort auf. */
async function authRole(pw) {
  if (!pw) return null;
  const admin = process.env.ADMIN_PASSWORD || '';
  if (admin && pw === admin) return { role: 'admin', name: 'Kubi' };
  try {
    const t = store('team');
    const { blobs } = await t.list({ prefix: 'u:' });
    const h = crypto.createHash('sha256').update(String(pw)).digest('hex');
    for (const b of blobs) {
      const u = await t.get(b.key, { type: 'json' });
      if (u && u.pwHash === h) return { role: u.role === 'admin' ? 'admin' : 'staff', name: u.name || b.key.slice(2) };
    }
  } catch (e) {}
  return null;
}

/* Geraete-Token fuer Team-Tablets. lib/team-device.js ist optional: fehlt die
   Datei, wird ein teamToken schlicht abgelehnt. Erwartet wird
   pruefeTeamToken(token) -> Wahrheitswert oder Objekt (ok:false = abgelehnt),
   synchron oder als Promise. */
async function authTeamToken(token) {
  if (!token || typeof token !== 'string') return null;
  let mod = null;
  try { mod = require('./lib/team-device'); } catch (e) { return null; }
  if (!mod || typeof mod.pruefeTeamToken !== 'function') return null;
  try {
    const r = await mod.pruefeTeamToken(token.slice(0, 512));
    if (!r || r.ok === false) return null;
    return { role: 'device', name: (r && typeof r === 'object' && (r.name || r.label)) || 'Team-Geraet' };
  } catch (e) { return null; }
}

/* Anmeldung mit Bremse (lib/auth-guard.js). Gibt { who } oder { antwort }. */
async function teamZugang(event, b, mitGeraet) {
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return { antwort: gesperrt };
  let who = null;
  if (b.password) who = await authRole(await passwortAusSitzung(String(b.password)));
  if (!who && mitGeraet && b.teamToken) who = await authTeamToken(String(b.teamToken));
  await meldeErgebnis(event, !!who);
  if (!who) return { antwort: json(401, { ok: false, error: 'unauthorized' }) };
  return { who };
}

const clean = (v, max) => String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, max);

/* Alle Dauerbestellungen aller Kunden - fuer Belegung und Tagesplan. */
async function alleReihen(s) {
  const { blobs } = await s.list({ prefix: 'so:' });
  const out = [];
  for (const x of blobs) {
    const r = await s.get(x.key, { type: 'json' });
    if (r) out.push(r);
  }
  return out;
}

async function leseKapazitaet(s) {
  try { return kapazitaetAus(await s.get('settings', { type: 'json' })); }
  catch (e) { return kapazitaetAus(null); }
}

/* Liegt der gespeicherte naechste Termin in der Vergangenheit, wird er
   nachgezogen. Sonst wuerde skipNext auf einen laengst vergangenen Termin
   zielen und gar nichts aussetzen. */
function termineNachziehen(rec) {
  if (!rec || rec.paused) return false;
  const alt = rec.nextRun;
  if (alt && new Date(alt).getTime() > Date.now()) return false;
  rec.nextRun = naechsterTermin(Number(rec.weekday), rec.time, rec.skipUntil);
  return rec.nextRun !== alt;
}

/* Neues Fenster setzen. Eine Aussetzung gilt einem bestimmten Termin: bleibt
   der Wochentag, wandert sie auf die neue Uhrzeit desselben Tages mit; bei
   einem anderen Wochentag verfaellt sie. */
function setzeFenster(rec, weekday, time) {
  if (rec.skipUntil && new Date(rec.skipUntil).getTime() > Date.now()) {
    rec.skipUntil = Number(rec.weekday) === weekday
      ? berlinZeitpunkt(berlinDatum(new Date(rec.skipUntil)), time).toISOString()
      : null;
  }
  rec.weekday = weekday;
  rec.time = time;
  rec.nextRun = naechsterTermin(weekday, time, rec.skipUntil);
}

const slotFehler = (p) => (p.error === 'slot_full'
  ? json(409, { ok: false, error: 'slot_full', free: p.free })
  : json(400, { ok: false, error: 'bad_slot' }));

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let b = {};
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad_json' }); }
  if (!b || typeof b !== 'object') b = {};

  /* Freie Fenster eines Wochentags. Ohne Anmeldung, liefert nur Zahlen -
     keine Namen, keine Artikel, nichts Persoenliches. */
  if (b.action === 'slots') {
    const weekday = wochentagAus(b.weekday);
    if (weekday == null) return json(400, { ok: false, error: 'bad_weekday' });
    try {
      const s = store('standing');
      const capacity = await leseKapazitaet(s);
      const reihen = await alleReihen(s);
      const mode = b.mode === 'delivery' ? 'delivery' : 'pickup';
      return json(200, { ok: true, weekday, capacity, slots: slotUebersicht(reihen, weekday, capacity, mode) });
    } catch (e) {
      console.error('standing-orders slots:', e);
      return json(500, { ok: false, error: 'server_error' });
    }
  }

  /* Tagesplan fuer Kueche und Einkauf. */
  if (b.action === 'plan') {
    const z = await teamZugang(event, b, true);
    if (z.antwort) return z.antwort;
    const date = b.date == null || b.date === '' ? berlinDatum() : String(b.date);
    const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(date + 'T12:00:00Z') : null;
    if (!d || isNaN(d) || d.toISOString().slice(0, 10) !== date) {
      return json(400, { ok: false, error: 'bad_date' });
    }
    try {
      const s = store('standing');
      const [reihen, capacity] = [await alleReihen(s), await leseKapazitaet(s)];
      const p = tagesplan(reihen, date, SK);
      return json(200, { ok: true, date, weekday: p.weekday, capacity, slots: p.slots,
        totalOrders: p.totalOrders, totalPatties: p.totalPatties });
    } catch (e) {
      console.error('standing-orders plan:', e);
      return json(500, { ok: false, error: 'server_error' });
    }
  }

  /* Plaetze je Fenster - lesen fuer jedes Team-Mitglied mit Passwort,
     aendern nur fuer Admins. */
  if (b.action === 'settings') {
    const z = await teamZugang(event, b, false);
    if (z.antwort) return z.antwort;
    try {
      const s = store('standing');
      if (b.slotCapacity === undefined || b.slotCapacity === null || b.slotCapacity === '') {
        return json(200, { ok: true, slotCapacity: await leseKapazitaet(s) });
      }
      if (z.who.role !== 'admin' && z.who.role !== 'superadmin') {
        return json(403, { ok: false, error: 'forbidden', hint: 'Nur Admins duerfen die Plaetze je Zeitfenster aendern' });
      }
      const n = Number(b.slotCapacity);
      if (!Number.isInteger(n) || n < 0 || n > KAPAZITAET_MAX) {
        return json(400, { ok: false, error: 'bad_capacity', hint: `Ganze Zahl von 0 bis ${KAPAZITAET_MAX}` });
      }
      const alt = (await s.get('settings', { type: 'json' })) || {};
      await s.setJSON('settings', { ...alt, slotCapacity: n,
        updatedAt: new Date().toISOString(), updatedBy: z.who.name || '?' });
      return json(200, { ok: true, slotCapacity: n });
    } catch (e) {
      console.error('standing-orders settings:', e);
      return json(500, { ok: false, error: 'server_error' });
    }
  }

  /* Aufruf aus der Erinnerungsmail: nur Kennung + Link-Token, keine Anmeldung.
     Gibt ausschliesslich die Artikel dieser einen Reihe zurueck – kein
     Aendern, kein Loeschen, keine anderen Daten. */
  if (b.action === 'byLink') {
    const id = String(b.id || '').replace(/[^a-f0-9]/g, '').slice(0, 24);
    const secret = process.env.STATUS_SECRET || process.env.ADMIN_PASSWORD || 'gnc';
    const erwartet = crypto.createHmac('sha256', secret).update('so:' + id).digest('hex').slice(0, 16);
    if (!id || b.linkToken !== erwartet) return json(403, { error: 'forbidden' });
    try {
      const st = store('standing');
      const { blobs } = await st.list({ prefix: 'so:' });
      const treffer = blobs.find(x => x.key.endsWith(':' + id));
      if (!treffer) return json(404, { error: 'not_found' });
      const rec = await st.get(treffer.key, { type: 'json' });
      if (!rec) return json(404, { error: 'not_found' });
      return json(200, { ok: true, order: { id: rec.id, items: rec.items, mode: rec.mode, time: rec.time } });
    } catch (e) { return json(500, { error: 'server_error' }); }
  }

  const kunde = await authCustomer(b.email, b.token);
  if (!kunde) return json(401, { error: 'unauthorized' });

  const s = store('standing');
  const praefix = 'so:' + emailKey(b.email) + ':';

  async function alle() {
    const { blobs } = await s.list({ prefix: praefix });
    const out = [];
    for (const x of blobs) {
      const r = await s.get(x.key, { type: 'json' });
      if (!r) continue;
      if (termineNachziehen(r)) { try { await s.setJSON(x.key, r); } catch (e) {} }
      out.push(r);
    }
    out.sort((a, c) => (a.weekday - c.weekday) || String(a.time).localeCompare(String(c.time)));
    return out;
  }

  try {
    const action = String(b.action || '');

    if (action === 'list') return json(200, { ok: true, orders: await alle() });

    if (action === 'create') {
      const vorhandene = await alle();
      if (vorhandene.length >= 3) {
        return json(400, { error: 'limit', hint: 'Höchstens drei stehende Bestellungen je Konto' });
      }
      const items = Array.isArray(b.items) ? b.items.slice(0, 40) : [];
      if (!items.length) return json(400, { error: 'empty' });
      const mode = b.mode === 'delivery' ? 'delivery' : 'pickup';
      const weekday = wochentagAus(b.weekday);
      const time = String(b.time || '');
      const p = pruefeSlot(await alleReihen(s), weekday, time, await leseKapazitaet(s), mode, null);
      if (!p.ok) return slotFehler(p);

      const id = crypto.randomBytes(6).toString('hex');
      // Erinnerungen nur bei ausdrücklicher Zustimmung – Voreinstellung ist AUS.
      const remind = b.remind === true;
      const rec = {
        id,
        name: clean(b.name, 32),
        email: String(b.email).trim().toLowerCase(),
        weekday, time,
        mode,
        items,
        note: clean(b.note, 200),
        paused: false,
        remind,
        remindConsentAt: remind ? new Date().toISOString() : null,
        skipUntil: null,
        createdAt: new Date().toISOString(),
        lastRemindedFor: null,
      };
      rec.nextRun = naechsterTermin(weekday, time, null);
      await s.setJSON(praefix + id, rec);
      return json(200, { ok: true, order: rec });
    }

    const id = String(b.id || '').replace(/[^a-f0-9]/g, '').slice(0, 24);
    if (!id) return json(400, { error: 'bad_id' });
    const key = praefix + id;
    const rec = await s.get(key, { type: 'json' });
    if (!rec) return json(404, { error: 'not_found' });
    termineNachziehen(rec);

    if (action === 'delete') { await s.delete(key); return json(200, { ok: true }); }

    if (action === 'move' || action === 'resume') {
      // resume ohne Angaben: bisheriges Fenster pruefen (Altbestand mit
      // krummer Zeit -> bad_slot, der Kunde waehlt ein neues Fenster).
      const neuTag = action === 'move' || b.weekday != null ? wochentagAus(b.weekday) : Number(rec.weekday);
      const neuZeit = action === 'move' || b.time != null ? String(b.time || '') : String(rec.time || '');
      const wirdAktiv = action === 'resume' || !rec.paused;
      const reihen = await alleReihen(s);
      const kap = await leseKapazitaet(s);
      const p = wirdAktiv
        ? pruefeSlot(reihen, neuTag, neuZeit, kap, rec.mode, rec.id)
        // Pausierte Reihe belegt keinen Platz - nur das Raster pruefen
        : pruefeSlot([], neuTag, neuZeit, Infinity, rec.mode, rec.id);
      if (!p.ok) return slotFehler(p);
      if (neuTag !== Number(rec.weekday) || neuZeit !== rec.time) setzeFenster(rec, neuTag, neuZeit);
      if (action === 'resume') {
        rec.paused = false;
        rec.nextRun = naechsterTermin(rec.weekday, rec.time, rec.skipUntil);
      }
    }

    if (action === 'pause')  rec.paused = true;
    if (action === 'skipNext') {
      // Diesen einen Termin überspringen – die Reihe läuft danach weiter.
      rec.skipUntil = rec.nextRun;
      rec.nextRun = naechsterTermin(rec.weekday, rec.time, rec.skipUntil);
    }
    if (action === 'remind') {
      const an = b.remind === true;
      rec.remind = an;
      // Zustimmung mit Zeitpunkt festhalten; beim Abschalten wieder leeren.
      rec.remindConsentAt = an ? new Date().toISOString() : null;
    }
    await s.setJSON(key, rec);
    return json(200, { ok: true, order: rec });
  } catch (e) {
    console.error('standing-orders:', e);
    return json(500, { error: 'server_error' });
  }
};
