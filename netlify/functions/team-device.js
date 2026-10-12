/**
 * team-device.js
 * ----------------------------------------------------------------------------
 * Team-Geraete koppeln (Apple Watch, Cockpit-Widget). Logik in lib/team-device.js.
 *
 *   POST { action:'create', password }           (Admin)
 *        -> { ok, code, expiresAt }              6 Ziffern, 10 Min, einmalig
 *   POST { action:'redeem', code, device }       (App, ohne Anmeldung)
 *        -> { ok, token, name, role }            401 { error:'invalid_code' }
 *   POST { action:'check', token }               (App)
 *        -> { ok, name, role }                   401 { error:'unauthorized' }
 *   POST { action:'list', password }             (Admin)
 *        -> { ok, devices:[{ id, device, name, createdAt, lastSeen }] }
 *   POST { action:'revoke', password, id }       (Admin)
 *        -> { ok }                               404 { error:'not_found' }
 *
 * password = Admin-Passwort oder Sitzungs-Token aus dem Admin-Tool
 * (lib/admin-sitzung.js). Koppeln, Auflisten und Entkoppeln nur mit Rolle
 * admin - dieselbe Pruefung wie in order-status.js.
 *
 * Bremse (lib/auth-guard.js): Passwort-Wege wie ueberall. Beim Einloesen
 * zaehlen Fehlversuche mit (Schutz gegen Raten der 6 Ziffern), ein Erfolg
 * setzt den Zaehler aber NICHT zurueck. Sonst koennte, wer einen Code hat,
 * damit die Sperre fuer das Passwort-Raten immer wieder aufheben.
 * 'check' ist ungebremst: ein Token aus 32 Zufallsbytes laesst sich nicht
 * raten, und eine entkoppelte Uhr im Truck-WLAN soll nicht das Tablet
 * aussperren.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung } = require('./lib/admin-sitzung');
const geraete = require('./lib/team-device');

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

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

/* Wie in order-status.js: admin (ADMIN_PASSWORD oder Team-Admin) oder staff. */
async function authRole(pw) {
  if (!pw) return null;
  const admin = process.env.ADMIN_PASSWORD || '';
  if (admin && pw === admin) return { role: 'admin', name: 'Kubi', owner: true };   // Inhaber
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

async function auditLog(who, area, text) {
  try {
    const key = 'a:' + new Date().toISOString() + '_' + Math.random().toString(36).slice(2, 7);
    await store('audit').setJSON(key, {
      at: new Date().toISOString(),
      name: (who && who.name) || '?',
      role: (who && who.role) || '?',
      action: area,
      detail: String(text || '').slice(0, 300),
    });
  } catch (e) {}
}

/* Admin pruefen. Gibt { who } oder { antwort } (fertige Fehlerantwort) zurueck. */
async function nurAdmin(event, input) {
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return { antwort: gesperrt };
  const who = await authRole(await passwortAusSitzung(input.password));
  await meldeErgebnis(event, !!who);
  if (!who) return { antwort: json(401, { error: 'unauthorized' }) };
  if (who.role !== 'admin') return { antwort: json(403, { error: 'forbidden', hint: 'Nur Admins können Geräte koppeln.' }) };
  return { who };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }
  const action = String(input.action || '');

  try {
    if (action === 'create') {
      const a = await nurAdmin(event, input);
      if (a.antwort) return a.antwort;
      const r = await geraete.erstelleCode(a.who);
      await auditLog(a.who, 'Team-Gerät', 'Kopplungscode erzeugt');
      return json(200, { ok: true, code: r.code, expiresAt: r.expiresAt });
    }

    if (action === 'redeem') {
      const gesperrt = await pruefeSperre(event);
      if (gesperrt) return gesperrt;
      const r = await geraete.loeseEin(input.code, input.device);
      if (!r) {
        await meldeErgebnis(event, false);
        return json(401, { error: 'invalid_code', hint: 'Code ungültig oder abgelaufen.' });
      }
      await auditLog({ role: r.role, name: r.name }, 'Team-Gerät', 'Gerät gekoppelt: ' + (String(input.device || '').slice(0, 40) || 'Gerät'));
      return json(200, { ok: true, token: r.token, name: r.name, role: r.role });
    }

    if (action === 'check') {
      const dev = await geraete.pruefeTeamToken(input.token);
      if (!dev) return json(401, { error: 'unauthorized' });
      return json(200, { ok: true, name: dev.name, role: dev.role });
    }

    if (action === 'list') {
      const a = await nurAdmin(event, input);
      if (a.antwort) return a.antwort;
      return json(200, { ok: true, devices: await geraete.liste() });
    }

    if (action === 'revoke') {
      const a = await nurAdmin(event, input);
      if (a.antwort) return a.antwort;
      const weg = await geraete.widerrufe(input.id);
      if (!weg) return json(404, { error: 'not_found' });
      await auditLog(a.who, 'Team-Gerät', 'Gerät entkoppelt: ' + weg.device + ' (' + weg.name + ')');
      return json(200, { ok: true });
    }
  } catch (e) {
    console.error('team-device:', e && e.message);
    return json(500, { error: 'storage_failed' });
  }

  return json(400, { error: 'unknown_action' });
};
