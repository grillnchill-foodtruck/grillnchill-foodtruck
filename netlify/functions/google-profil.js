/**
 * google-profil.js
 * ----------------------------------------------------------------------------
 * Verbindung zum Google-Unternehmensprofil (Rezensionen, lib/google-profil.js).
 *
 *   POST { password, action:'status' }    → Zustand für das Admin-Tool
 *   POST { password, action:'start' }     → { url } zur Google-Anmeldung
 *   POST { password, action:'testen' }    → sofort abrufen (Übersetzung inklusive)
 *   POST { password, action:'trennen' }   → Token widerrufen und löschen
 *   GET  /google-profil/rueckruf?code&state  → Rücksprung von Google
 *
 * Nur Admins und der Inhaber, keine Minijobber. Der Rücksprung prüft den
 * einmaligen state-Wert (15 Minuten gültig) und leitet danach zurück ins
 * Admin-Tool: /admin?google=verbunden|abgebrochen|abgelaufen|fehler
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung } = require('./lib/admin-sitzung');
const { mitglied } = require('./lib/team-passwort');
const { schutz } = require('./lib/bremse');
const gp = require('./lib/google-profil');

const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(data),
});
const zurueck = (ergebnis) => ({
  statusCode: 302,
  headers: { Location: '/admin?google=' + encodeURIComponent(ergebnis), 'Cache-Control': 'no-store' },
  body: '',
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
  if (admin && pw === admin) return { role: 'superadmin', name: 'Kubi' };
  try {
    const t = store('team');
    const { blobs } = await t.list({ prefix: 'u:' });
    const { key, u } = (await mitglied(t, pw, blobs)) || {};
    if (u) return { role: u.role === 'admin' ? 'admin' : 'staff', name: u.name || key.slice(2) };
  } catch (e) {}
  return null;
}

async function protokoll(who, text) {
  try {
    await store('audit').setJSON('a:' + new Date().toISOString() + '_' + Math.random().toString(36).slice(2, 7), {
      at: new Date().toISOString(), name: (who && who.name) || '?', role: (who && who.role) || '?',
      action: 'Google-Profil', detail: String(text || '').slice(0, 300),
    });
  } catch (e) {}
}

async function rueckruf(event) {
  const q = event.queryStringParameters || {};
  if (q.error) return zurueck(q.error === 'access_denied' ? 'abgebrochen' : 'fehler');
  const st = await gp.stateEinloesen(q.state);
  if (!st) return zurueck('abgelaufen');
  if (!q.code || !gp.eingerichtet()) return zurueck('fehler');
  try {
    const r = await gp.verbinden(String(q.code), st.wer);
    if (!r.ok) {
      console.error('google-profil: Verbinden fehlgeschlagen', r.grund);
      return zurueck('fehler');
    }
    await protokoll({ name: st.wer || '?', role: 'admin' }, 'Google-Profil verbunden' + (r.konto ? ' (' + r.konto + ')' : '') + ', Freigabe: ' + r.freigabe);
    return zurueck('verbunden');
  } catch (e) {
    console.error('google-profil: Rückruf', e && e.message);
    return zurueck('fehler');
  }
}

exports.handler = async (event) => {
  const bremseHalt = await schutz(event, { name: 'google-profil', max: 30, maxKB: 8 });
  if (bremseHalt) return bremseHalt;

  if (event.httpMethod === 'GET') return rueckruf(event);
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }

  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;
  const who = await authRole(await passwortAusSitzung(input.password));
  await meldeErgebnis(event, !!who);
  if (!who) return json(401, { error: 'unauthorized' });
  if (who.role === 'staff') return json(403, { error: 'forbidden', hint: 'Das verwalten Admins und der Inhaber.' });

  if (input.action === 'status') return json(200, { ok: true, profil: await gp.uebersicht() });

  if (input.action === 'start') {
    if (!gp.eingerichtet()) {
      return json(409, { error: 'nicht_eingerichtet', hint: 'In Netlify fehlen GOOGLE_PROFIL_CLIENT_ID und GOOGLE_PROFIL_CLIENT_SECRET.' });
    }
    return json(200, { ok: true, url: await gp.startUrl(who.name) });
  }

  if (input.action === 'testen') {
    const r = await gp.aktualisiereProfil({});
    return json(200, { ok: r.freigabe === 'ok', ergebnis: { freigabe: r.freigabe, anzahl: r.anzahl || 0, total: r.total || null }, profil: await gp.uebersicht() });
  }

  if (input.action === 'trennen') {
    await gp.trennen();
    await protokoll(who, 'Google-Profil getrennt');
    return json(200, { ok: true, profil: await gp.uebersicht() });
  }

  return json(400, { error: 'unknown_action' });
};
