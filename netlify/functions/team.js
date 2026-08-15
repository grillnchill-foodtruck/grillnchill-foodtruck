/**
 * team.js
 * ----------------------------------------------------------------------------
 * Team-Logins fürs Admin-Tool.
 *
 * Rollen:
 *   admin = ADMIN_PASSWORD (Kubi) – Vollzugriff inkl. Push-Marketing, Zahlen,
 *           Rückerstattungen und Team-Verwaltung.
 *   staff = Mitarbeiter-Passwörter (hier verwaltet) – Laden-Status (Pause,
 *           Ausverkauft, Special) und Bestellungen (prüfen/abschließen).
 *
 * Es gibt bewusst KEINE Benutzernamen im Login: Jedes Team-Mitglied bekommt
 * ein eigenes, eindeutiges Passwort – das Passwort identifiziert die Person.
 * Passwörter werden ausschließlich als SHA-256-Hash gespeichert.
 *
 *   POST { password, action, ... }
 *     action = "whoami"                    → { role, name }        (alle)
 *     action = "list"                      → { staff: [...] }      (admin)
 *     action = "add",    name, staffPassword → legt Mitarbeiter an (admin)
 *     action = "remove", name              → entfernt Mitarbeiter  (admin)
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');

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

function teamStore() {
  const opts = { name: 'team', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
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

const hash = (pw) => crypto.createHash('sha256').update(String(pw)).digest('hex');
const slug = (name) => String(name || '').trim().toLowerCase().replace(/[^a-z0-9äöüß-]/g, '-').slice(0, 30);

async function authRole(pw) {
  if (!pw) return null;
  const admin = process.env.ADMIN_PASSWORD || '';
  if (admin && pw === admin) return { role: 'superadmin', name: 'Kubi' };
  try {
    const t = teamStore();
    const { blobs } = await t.list({ prefix: 'u:' });
    const h = hash(pw);
    for (const b of blobs) {
      const u = await t.get(b.key, { type: 'json' });
      if (u && u.pwHash === h) return { role: u.role === 'admin' ? 'admin' : 'staff', name: u.name || b.key.slice(2) };
    }
  } catch (e) {}
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }

  // Bremse gegen Durchprobieren – siehe lib/auth-guard.js
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;
  const who = await authRole(input.password);
  await meldeErgebnis(event, !!who);
  if (!who) return json(401, { error: 'unauthorized' });

  const action = String(input.action || 'whoami');

  if (action === 'whoami') return json(200, { ok: true, role: who.role, name: who.name });

  // Ab hier: Admin oder Superadmin
  const isSuper = who.role === 'superadmin';
  if (!isSuper && who.role !== 'admin') return json(403, { error: 'forbidden', hint: 'Nur für den Admin-Zugang' });

  const t = teamStore();
  try {
    if (action === 'list') {
      const { blobs } = await t.list({ prefix: 'u:' });
      const staff = [];
      for (const b of blobs) {
        const u = await t.get(b.key, { type: 'json' });
        if (u) staff.push({ name: u.name || b.key.slice(2), role: u.role === 'admin' ? 'admin' : 'staff', createdAt: u.createdAt || null });
      }
      staff.sort((a, b2) => (a.name || '').localeCompare(b2.name || ''));
      return json(200, { ok: true, staff });
    }

    if (action === 'add') {
      const name = String(input.name || '').trim().slice(0, 40);
      const pw = String(input.staffPassword || '');
      if (!name) return json(400, { error: 'missing_name' });
      if (pw.length < 6) return json(400, { error: 'weak_password', hint: 'Mindestens 6 Zeichen' });
      if (pw === (process.env.ADMIN_PASSWORD || '')) return json(400, { error: 'reserved_password' });
      const key = 'u:' + slug(name);
      if (await t.get(key, { type: 'json' })) return json(409, { error: 'name_exists', hint: 'Name schon vergeben – bitte anderen wählen' });
      // Passwort-Kollision mit anderem Mitarbeiter verhindern (Passwort = Identität)
      const { blobs } = await t.list({ prefix: 'u:' });
      const h = hash(pw);
      for (const b of blobs) {
        const u = await t.get(b.key, { type: 'json' });
        if (u && u.pwHash === h) return json(409, { error: 'password_exists', hint: 'Dieses Passwort ist bereits vergeben' });
      }
      const role = input.role === 'admin' ? 'admin' : 'staff';
      if (role === 'admin' && !isSuper) return json(403, { error: 'forbidden', hint: 'Admins kann nur der Superadmin anlegen' });
      await t.setJSON(key, { name, pwHash: h, role, createdAt: new Date().toISOString() });
      await auditLog(who, 'Team', 'Zugang angelegt: ' + name + ' (' + (role === 'admin' ? 'Admin' : 'Mitarbeiter') + ')');
      return json(200, { ok: true, name, role });
    }

    if (action === 'setpassword') {
      const key = 'u:' + slug(input.name);
      const u = await t.get(key, { type: 'json' });
      if (!u) return json(404, { error: 'not_found' });
      if (u.role === 'admin' && !isSuper) return json(403, { error: 'forbidden', hint: 'Admin-Passwörter kann nur der Superadmin ändern' });
      const pw = String(input.staffPassword || '');
      if (pw.length < 6) return json(400, { error: 'weak_password', hint: 'Mindestens 6 Zeichen' });
      if (pw === (process.env.ADMIN_PASSWORD || '')) return json(400, { error: 'reserved_password' });
      // Kollision mit anderem Team-Mitglied verhindern (Passwort = Identität)
      const h = hash(pw);
      const { blobs } = await t.list({ prefix: 'u:' });
      for (const b of blobs) {
        if (b.key === key) continue;
        const other = await t.get(b.key, { type: 'json' });
        if (other && other.pwHash === h) return json(409, { error: 'password_exists', hint: 'Dieses Passwort ist bereits vergeben' });
      }
      u.pwHash = h;
      u.passwordChangedAt = new Date().toISOString();
      await t.setJSON(key, u);
      await auditLog(who, 'Team', 'Passwort geändert für: ' + u.name);
      return json(200, { ok: true, name: u.name });
    }

    if (action === 'setrole') {
      if (!isSuper) return json(403, { error: 'forbidden', hint: 'Rollen kann nur der Superadmin ändern' });
      const key = 'u:' + slug(input.name);
      const u = await t.get(key, { type: 'json' });
      if (!u) return json(404, { error: 'not_found' });
      u.role = input.role === 'admin' ? 'admin' : 'staff';
      await t.setJSON(key, u);
      await auditLog(who, 'Team', 'Rolle geändert: ' + u.name + ' → ' + (u.role === 'admin' ? 'Admin' : 'Mitarbeiter'));
      return json(200, { ok: true, name: u.name, role: u.role });
    }

    if (action === 'remove') {
      const key = 'u:' + slug(input.name);
      const u = await t.get(key, { type: 'json' });
      if (u && u.role === 'admin' && !isSuper) return json(403, { error: 'forbidden', hint: 'Admins kann nur der Superadmin entfernen' });
      await t.delete(key);
      await auditLog(who, 'Team', 'Zugang entfernt: ' + (u ? u.name : input.name));
      return json(200, { ok: true });
    }
  } catch (e) {
    return json(500, { error: 'team_failed', detail: String((e && e.message) || e) });
  }
  return json(400, { error: 'unknown_action' });
};
