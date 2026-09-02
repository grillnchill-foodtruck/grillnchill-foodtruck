/**
 * dienstplan.js
 * ----------------------------------------------------------------------------
 * Personalplanung fuer den Truck (Seite /dienstplan).
 *
 *   POST { password, action, ... }
 *     'lesen'     { woche }             → { personal, schichten, rolle }
 *                 jede Team-Rolle: das Personal darf den Plan mit dem eigenen
 *                 Team-Passwort ansehen
 *     'personal'  { personal: [...] }   → Mitarbeiterliste speichern (nur Admin)
 *     'speichern' { woche, schichten }  → ganze Woche speichern (nur Admin)
 *
 * Datenmodell (Blobs-Store 'dienstplan'):
 *   'personal'        → [{ id, name, farbe }]
 *   'w:<montag>'      → { schichten: { '<YYYY-MM-DD>': [{ pid, von, bis, notiz }] } }
 * Der Schluessel ist der Montag der Woche (YYYY-MM-DD) – einfach, sortierbar,
 * und "Vorwoche uebernehmen" ist ein einziger get/set.
 *
 * Auth wie ueberall: Anmeldebremse + Sitzungs-Token-Aufloesung + authRole.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung } = require('./lib/admin-sitzung');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify(data),
});

function store(name) {
  const opts = { name, consistency: 'strong' };
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

/* Wochen-Schluessel absichern: nur ein Montag im ISO-Format kommt durch. */
function montagKey(w) {
  const s = String(w || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T12:00:00Z');
  if (isNaN(d)) return null;
  if (d.getUTCDay() !== 1) return null;   // 1 = Montag
  return s;
}

const clean = (x, n) => String(x == null ? '' : x).replace(/[<>]/g, '').trim().slice(0, n);

function bereinigePersonal(roh) {
  if (!Array.isArray(roh)) return [];
  return roh.slice(0, 30).map((p) => ({
    id: clean(p.id, 12) || Math.random().toString(36).slice(2, 8),
    name: clean(p.name, 40),
    farbe: /^#[0-9a-fA-F]{6}$/.test(String(p.farbe || '')) ? p.farbe : '#E85A24',
  })).filter((p) => p.name);
}

function bereinigeSchichten(roh) {
  const aus = {};
  if (!roh || typeof roh !== 'object') return aus;
  for (const [tag, liste] of Object.entries(roh)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tag)) continue;
    if (!Array.isArray(liste)) continue;
    aus[tag] = liste.slice(0, 20).map((s) => ({
      pid: clean(s.pid, 12),
      von: /^\d{2}:\d{2}$/.test(String(s.von || '')) ? s.von : '12:00',
      bis: /^\d{2}:\d{2}$/.test(String(s.bis || '')) ? s.bis : '20:30',
      notiz: clean(s.notiz, 80),
    })).filter((s) => s.pid);
  }
  return aus;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }

  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;
  const who = await authRole(await passwortAusSitzung(input.password));
  await meldeErgebnis(event, !!who);
  if (!who) return json(401, { error: 'unauthorized' });

  const s = store('dienstplan');

  if (input.action === 'lesen') {
    const woche = montagKey(input.woche);
    if (!woche) return json(400, { error: 'bad_week', hint: 'woche muss ein Montag im Format JJJJ-MM-TT sein' });
    const personal = (await s.get('personal', { type: 'json' })) || [];
    const plan = (await s.get('w:' + woche, { type: 'json' })) || { schichten: {} };
    return json(200, { ok: true, rolle: who.role, name: who.name, personal, schichten: plan.schichten || {} });
  }

  // Ab hier: nur der Chef plant
  if (who.role !== 'admin') return json(403, { error: 'forbidden', hint: 'Nur Admins dürfen den Plan ändern' });

  if (input.action === 'personal') {
    const personal = bereinigePersonal(input.personal);
    await s.setJSON('personal', personal);
    return json(200, { ok: true, personal });
  }

  if (input.action === 'speichern') {
    const woche = montagKey(input.woche);
    if (!woche) return json(400, { error: 'bad_week' });
    const schichten = bereinigeSchichten(input.schichten);
    await s.setJSON('w:' + woche, { schichten, stand: new Date().toISOString() });
    return json(200, { ok: true });
  }

  return json(400, { error: 'unknown_action' });
};
