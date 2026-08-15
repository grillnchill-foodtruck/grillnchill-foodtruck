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
 * TAGES-BINDUNG: "Pausiert" und "Ausverkauft" gelten nur für den Tag, an dem
 * sie gesetzt wurden (Zeitzone Europe/Berlin). Ab Mitternacht setzt sich beides
 * automatisch zurück – niemand kann vergessen, den Haken zu entfernen.
 * Das "Special der Woche" bleibt bewusst bestehen (wochenweise gedacht).
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

const STORE_NAME = 'shop-status';
const KEY = 'status';

const DEFAULT_STATUS = {
  paused: false,
  waitTime: 0,           // Live-Wartezeit in Minuten (0 = keine Anzeige)
  pauseMessage: '',
  soldOut: [],
  special: null,        // { id, note } – "Special der Woche" fürs Best-of-Karussell
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
      pauseMessage: typeof data.pauseMessage === 'string' ? data.pauseMessage : '',
      soldOut: Array.isArray(data.soldOut) ? data.soldOut.map(String) : [],
      waitTime: Math.max(0, Math.min(120, parseInt(data.waitTime, 10) || 0)),
      special: (data.special && typeof data.special === 'object' && data.special.id)
        ? { id: String(data.special.id), note: String(data.special.note || '').slice(0, 120) }
        : null,
      dayKey: data.dayKey || (data.updatedAt ? berlinDay(new Date(data.updatedAt)) : null),
      updatedAt: data.updatedAt || null,
    };

    // AUTO-RESET um Mitternacht: Pause + Ausverkauft gelten nur am Setz-Tag.
    const today = berlinDay();
    if (status.dayKey && status.dayKey !== today && (status.paused || status.soldOut.length || status.waitTime)) {
      status.paused = false;
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
const _teamCrypto = require('crypto');
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
    const h = _teamCrypto.createHash('sha256').update(String(pw)).digest('hex');
    for (const b of blobs) {
      const u = await t.get(b.key, { type: 'json' });
      if (u && u.pwHash === h) return { role: u.role === 'admin' ? 'admin' : 'staff', name: u.name || b.key.slice(2) };
    }
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
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  // ---- GET: Status lesen (öffentlich) ----
  if (event.httpMethod === 'GET') {
    const status = await readStatus();
    return json(200, status, { 'Cache-Control': 'no-store' });
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
    const who = await authRole(body.password);
    await meldeErgebnis(event, !!who);
    if (!who) {
      return json(401, { error: 'Falsches Passwort' });
    }

    const newStatus = {
      paused: !!body.paused,
      waitTime: Math.max(0, Math.min(120, parseInt(body.waitTime, 10) || 0)),
      pauseMessage: String(body.pauseMessage || '').slice(0, 200),
      soldOut: Array.isArray(body.soldOut)
        ? [...new Set(body.soldOut.map(String))].slice(0, 200)
        : [],
      special: (body.special && typeof body.special === 'object' && body.special.id)
        ? { id: String(body.special.id).slice(0, 40), note: String(body.special.note || '').slice(0, 120) }
        : null,
      dayKey: berlinDay(),   // Pause/Ausverkauft gelten nur für diesen Tag
      updatedAt: new Date().toISOString(),
    };

    try {
      await store().setJSON(KEY, newStatus);
    } catch (e) {
      return json(500, { error: 'Speichern fehlgeschlagen', detail: String(e && e.message || e) });
    }

    await auditLog(who, 'Status',
      'Pause: ' + (newStatus.paused ? 'AN' + (newStatus.pauseMessage ? ' („' + newStatus.pauseMessage.slice(0, 60) + '")' : '') : 'aus')
      + ' · Ausverkauft: ' + newStatus.soldOut.length
      + ' · Special: ' + (newStatus.special ? newStatus.special.id : '–')
      + ' · Wartezeit: ' + (newStatus.waitTime ? '~' + newStatus.waitTime + ' Min' : 'aus'));

    return json(200, { ok: true, status: newStatus });
  }

  return json(405, { error: 'Method not allowed' });
};
