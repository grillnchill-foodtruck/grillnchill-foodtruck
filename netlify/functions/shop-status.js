/**
 * shop-status.js
 * ----------------------------------------------------------------------------
 * Serverseitiger Laden-Status (gilt für ALLE Besucher, überlebt Reloads).
 * Persistenz via Netlify Blobs.
 *
 *   GET  /shop-status            → öffentlich lesen (Storefront fragt das ab)
 *   POST /shop-status            → schreiben, nur mit korrektem Passwort
 *        Body: { password, paused, pauseMessage, soldOut: [ ...ids ] }
 *
 * TAGES-BINDUNG: "Pausiert", "Lieferung/Abholung aus", "Wartezeit" und
 * "Ausverkauft" gelten nur für den Tag, an dem sie gesetzt wurden (Zeitzone
 * Europe/Berlin). Ab Mitternacht setzt sich alles automatisch zurück – niemand
 * kann vergessen, den Haken zu entfernen.
 * Das "Special der Woche" bleibt bewusst bestehen (wochenweise gedacht).
 *
 * AUTOMATISCHE WARTEZEIT (lib/wartezeit.js): waitAuto, waitBase,
 * waitPerBurger, waitMax sind Einstellungen und bleiben über Mitternacht
 * bestehen. Ist waitAuto an, liefert GET als waitTime den berechneten Wert
 * (offene Burger heute × waitPerBurger + waitBase, auf 5 Min. gerundet,
 * höchstens waitMax, außerhalb der Öffnungszeit 0) und dazu offeneBurger.
 * Der von Hand gesetzte Wert steht immer in waitManual und gilt nur bei AUS.
 * Fehlen die vier Felder in einem POST (z. B. Cockpit), bleiben sie, wie sie sind.
 *
 *   POST { password, action: 'vorschau' } → { ok, offeneBurger, offen }
 *        Für die Live-Vorschau im Admin („Jetzt wären es 25 Min."), auch
 *        wenn die Automatik noch aus ist. Schreibt nichts.
 *
 * Benötigte Environment Variable in Netlify:
 *   ADMIN_PASSWORD   = dein geheimes Admin-Passwort
 *
 * Netlify Blobs ist auf Netlify automatisch aktiv (kein manuelles Setup nötig),
 * sobald das Paket @netlify/blobs als Dependency vorhanden ist (package.json).
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung } = require('./lib/admin-sitzung');
const { mitglied } = require('./lib/team-passwort');
const wartezeit = require('./lib/wartezeit');
const zahlEinstellungen = require('./lib/zahl-einstellungen');

const STORE_NAME = 'shop-status';
const KEY = 'status';

const DEFAULT_STATUS = {
  paused: false,
  deliveryOff: false,    // Lieferung heute abgeschaltet (Abholung geht weiter)
  pickupOff: false,      // Abholung heute abgeschaltet (Lieferung geht weiter)
  waitTime: 0,           // Live-Wartezeit in Minuten (0 = keine Anzeige)
  pauseMessage: '',
  soldOut: [],
  special: null,        // { id, note } – "Special der Woche" fürs Best-of-Karussell
  ...wartezeit.STANDARD, // Automatische Wartezeit: Einstellung, kein Tageswert
  updatedAt: null,
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(statusCode, data, extraHeaders) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...CORS, ...(extraHeaders || {}) },
    body: JSON.stringify(data),
  };
}

function ordersStore() {
  const opts = { name: 'orders', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

function store() {
  // Strong consistency: Änderungen sind sofort überall sichtbar.
  const opts = { name: STORE_NAME, consistency: 'strong' };
  // Fallback für manuelle (Drag&Drop-)Deploys: Blobs ist dort nicht automatisch
  // konfiguriert → siteID + Token aus Environment-Variablen verwenden, falls gesetzt.
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

// Heutiges Datum in deutscher Zeit (YYYY-MM-DD) – Server laufen auf UTC!
function berlinDay(d) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(d || new Date());
}

async function readStatus() {
  try {
    const data = await store().get(KEY, { type: 'json' });
    if (!data || typeof data !== 'object') return { ...DEFAULT_STATUS };
    const status = {
      paused: !!data.paused,
      deliveryOff: !!data.deliveryOff,
      pickupOff: !!data.pickupOff,
      pauseMessage: typeof data.pauseMessage === 'string' ? data.pauseMessage : '',
      soldOut: Array.isArray(data.soldOut) ? data.soldOut.map(String) : [],
      waitTime: Math.max(0, Math.min(120, parseInt(data.waitTime, 10) || 0)),
      special: (data.special && typeof data.special === 'object' && data.special.id)
        ? { id: String(data.special.id), note: String(data.special.note || '').slice(0, 120) }
        : null,
      dayKey: data.dayKey || (data.updatedAt ? berlinDay(new Date(data.updatedAt)) : null),
      ...wartezeit.einstellungen(data),
      updatedAt: data.updatedAt || null,
    };

    // AUTO-RESET um Mitternacht: Pause + Ausverkauft gelten nur am Setz-Tag.
    const today = berlinDay();
    if (status.dayKey && status.dayKey !== today
        && (status.paused || status.deliveryOff || status.pickupOff || status.soldOut.length || status.waitTime)) {
      status.paused = false;
      status.deliveryOff = false;
      status.pickupOff = false;
      status.waitTime = 0;
      status.pauseMessage = '';
      status.soldOut = [];
      status.dayKey = today;
      // Zurückgesetzten Zustand persistieren (best effort – nur beim ersten
      // Aufruf nach Mitternacht, danach ist nichts mehr zurückzusetzen).
      try { await store().setJSON(KEY, { ...status, updatedAt: new Date().toISOString() }); } catch (e) {}
    }
    return status;
  } catch (e) {
    // Fail-open: Bei jedem Fehler gilt der Laden als geöffnet, nichts ausverkauft.
    return { ...DEFAULT_STATUS };
  }
}


// --- Team-Auth: admin (ADMIN_PASSWORD) oder staff (Team-Store, siehe team.js) ---
const { schutz } = require('./lib/bremse');
function _teamStore() {
  const opts = { name: 'team', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}
async function authRole(pw) {
  if (!pw) return null;
  const admin = process.env.ADMIN_PASSWORD || '';
  if (admin && pw === admin) return { role: 'admin', name: 'Kubi' };
  try {
    const t = _teamStore();
    const { blobs } = await t.list({ prefix: 'u:' });
    const { key, u } = (await mitglied(t, pw, blobs)) || {};
    if (u) return { role: u.role === 'admin' ? 'admin' : 'staff', name: u.name || key.slice(2) };
  } catch (e) {}
  return null;
}


// --- Änderungs-Protokoll (Store: audit) – best effort, blockiert nie ---
async function auditLog(who, action, detail) {
  try {
    const opts = { name: 'audit', consistency: 'strong' };
    if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
      opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
      opts.token = process.env.NETLIFY_BLOBS_TOKEN;
    }
    const s = getStore(opts);
    const key = 'a:' + new Date().toISOString() + '_' + Math.random().toString(36).slice(2, 7);
    await s.setJSON(key, {
      at: new Date().toISOString(),
      name: (who && who.name) || '?',
      role: (who && who.role) || '?',
      action,
      detail: String(detail || '').slice(0, 300),
    });
  } catch (e) {}
}

exports.handler = async (event) => {
  // Grundschutz: Anfragen je Absender und Größe begrenzen (lib/bremse.js)
  const bremseHalt = await schutz(event, { name: 'ladenstatus', max: 300, maxKB: 16 });
  if (bremseHalt) return bremseHalt;
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  // ---- GET: Status lesen (öffentlich) ----
  if (event.httpMethod === 'GET') {
    const status = await readStatus();
    // Von Hand gesetzter Wert, damit Admin und Cockpit ihn beim Speichern
    // nicht mit dem gerechneten verwechseln
    status.waitManual = status.waitTime;
    if (status.waitAuto) {
      try {
        const w = await wartezeit.aktuelleWartezeit(status, { store: ordersStore() });
        status.waitTime = w.minuten;
        status.offeneBurger = w.burger;
      } catch (e) {
        // Fail-open: im Zweifel der von Hand gesetzte Wert
        console.error('shop-status wartezeit:', e && e.message);
      }
    }
    // Bezahl-Schalter (Paket bezahlen): eigener Schlüssel, nicht tagesgebunden
    status.zahlung = zahlEinstellungen.oeffentlich(await zahlEinstellungen.lesen());
    // Jeder Seitenaufruf fragt hier nach. Das Netlify-CDN hält die Antwort
    // 10 Sekunden: Eine Pause oder „Ausverkauft“ kommt also spätestens nach
    // 10 Sekunden bei allen an. Admin-Tool und Cockpit hängen ?frisch=<Zeit>
    // an und bekommen immer den aktuellen Stand. Der Browser speichert nichts.
    return json(200, status, { 'Cache-Control': 'no-store', 'Netlify-CDN-Cache-Control': 'public, durable, s-maxage=10' });
  }

  // ---- POST: Status schreiben (passwortgeschützt) ----
  if (event.httpMethod === 'POST') {
    const adminPw = process.env.ADMIN_PASSWORD || '';
    if (!adminPw) {
      return json(500, {
        error: 'Admin nicht konfiguriert',
        hint: 'Bitte ADMIN_PASSWORD in den Netlify Environment Variables setzen.',
      });
    }

    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch (e) {
      return json(400, { error: 'Ungültiges JSON' });
    }

    // Bremse gegen Durchprobieren – siehe lib/auth-guard.js
    const gesperrt = await pruefeSperre(event);
    if (gesperrt) return gesperrt;
    const who = await authRole(await passwortAusSitzung(body.password));
    await meldeErgebnis(event, !!who);
    if (!who) {
      return json(401, { error: 'Falsches Passwort' });
    }

    // Bezahl-Einstellungen („Bezahlen ohne Umweg“, Burger-Pass). Eigener
    // Bereich, damit das Speichern im Reiter „Heute“ sie nie überschreibt.
    // Nur Admins: beides hat mit Geld und Steuer zu tun.
    if (body.bereich === 'zahlung') {
      if (who.role !== 'admin') return json(403, { error: 'forbidden', hint: 'Nur Admins dürfen das ändern.' });
      if (body.lesen === true) return json(200, { ok: true, zahlung: await zahlEinstellungen.lesen() });
      const vorher = await zahlEinstellungen.lesen();
      let neu;
      try {
        neu = await zahlEinstellungen.schreiben(body.zahlung, who.name);
      } catch (e) {
        console.error('shop-status zahlung:', e && e.message);
        return json(500, { error: 'Speichern fehlgeschlagen' });
      }
      const p = neu.pass;
      await auditLog(who, 'Bezahlen',
        'Ohne Umweg: ' + (vorher.direktZahlung ? 'an' : 'aus') + ' → ' + (neu.direktZahlung ? 'AN' : 'aus')
        + ' · Burger-Pass: ' + (vorher.pass.aktiv ? 'an' : 'aus') + ' → ' + (p.aktiv ? 'AN' : 'aus')
        + ' (' + p.name + ', ' + p.preis.toFixed(2) + ' €, ' + p.menus + ' Menüs, ' + p.tage + ' Tage)');
      return json(200, { ok: true, zahlung: neu });
    }

    // Live-Vorschau für den Admin: offene Burger jetzt, auch bei AUS
    if (body.action === 'vorschau') {
      try {
        const w = await wartezeit.aktuelleWartezeit(wartezeit.STANDARD, { store: ordersStore(), immerZaehlen: true, frisch: true });
        return json(200, { ok: true, offeneBurger: w.burger, offeneBestellungen: w.bestellungen, offen: w.offen });
      } catch (e) {
        console.error('shop-status vorschau:', e && e.message);
        return json(500, { error: 'Vorschau nicht möglich' });
      }
    }

    // Fehlen die Felder der Automatik (z. B. Speichern aus dem Cockpit),
    // gelten die gespeicherten weiter.
    const bisher = (body.waitAuto === undefined) ? await readStatus() : null;
    const autoQuelle = bisher || body;

    const newStatus = {
      paused: !!body.paused,
      deliveryOff: !!body.deliveryOff,
      pickupOff: !!body.pickupOff,
      waitTime: Math.max(0, Math.min(120, parseInt(body.waitTime, 10) || 0)),
      pauseMessage: String(body.pauseMessage || '').slice(0, 200),
      soldOut: Array.isArray(body.soldOut)
        ? [...new Set(body.soldOut.map(String))].slice(0, 200)
        : [],
      special: (body.special && typeof body.special === 'object' && body.special.id)
        ? { id: String(body.special.id).slice(0, 40), note: String(body.special.note || '').slice(0, 120) }
        : null,
      dayKey: berlinDay(),   // Pause/Ausverkauft gelten nur für diesen Tag
      ...wartezeit.einstellungen({
        waitAuto: autoQuelle.waitAuto === true,
        waitBase: autoQuelle.waitBase,
        waitPerBurger: autoQuelle.waitPerBurger,
        waitMax: autoQuelle.waitMax,
      }),
      updatedAt: new Date().toISOString(),
    };

    try {
      await store().setJSON(KEY, newStatus);
    } catch (e) {
      return json(500, { error: 'Speichern fehlgeschlagen', detail: String(e && e.message || e) });
    }

    await auditLog(who, 'Status',
      'Pause: ' + (newStatus.paused ? 'AN' + (newStatus.pauseMessage ? ' („' + newStatus.pauseMessage.slice(0, 60) + '")' : '') : 'aus')
      + ' · Lieferung: ' + (newStatus.deliveryOff ? 'AUS' : 'an')
      + ' · Abholung: ' + (newStatus.pickupOff ? 'AUS' : 'an')
      + ' · Ausverkauft: ' + newStatus.soldOut.length
      + ' · Special: ' + (newStatus.special ? newStatus.special.id : '–')
      + ' · Wartezeit: ' + (newStatus.waitAuto
        ? 'automatisch (' + newStatus.waitBase + ' + ' + newStatus.waitPerBurger + ' je Burger, höchstens ' + newStatus.waitMax + ' Min)'
        : (newStatus.waitTime ? '~' + newStatus.waitTime + ' Min' : 'aus')));

    return json(200, { ok: true, status: newStatus });
  }

  return json(405, { error: 'Method not allowed' });
};
