/**
 * office-ticket.js
 * POST { password: <Sitzungstoken> } -> { ok, url }
 * Nur Admins (Kubi oder Team-Admin) mit Zwei-Faktor-Sitzung. Das Ticket gilt
 * 60 Sekunden und einmal; das Office öffnet damit eine eigene Sitzung.
 */
const { getStore } = require('@netlify/blobs');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung, istToken, sitzungMitZweiFaktor } = require('./lib/admin-sitzung');
const { mitglied } = require('./lib/team-passwort');
const { ticketFuer } = require('./lib/office-ticket');

const json = (statusCode, d) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(d) });

function teamStore() {
  const o = { name: 'team', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) { o.siteID = process.env.NETLIFY_BLOBS_SITE_ID; o.token = process.env.NETLIFY_BLOBS_TOKEN; }
  return getStore(o);
}

async function wer(pw) {
  if (!pw) return null;
  if (process.env.ADMIN_PASSWORD && pw === process.env.ADMIN_PASSWORD) return { sub: 'kubi', name: 'Kubi', role: 'superadmin' };
  try {
    const { key, u } = (await mitglied(teamStore(), pw)) || {};
    // Eigene Kennung mit Präfix t-: Ein Team-Zugang namens „Kubi“ (Slug kubi) fiele sonst im Office
    // mit dem Inhaber (sub kubi) zusammen und erbte dessen Rolle.
    if (u) return { sub: 't-' + key.slice(2), name: u.name || key.slice(2), role: u.role === 'admin' ? 'admin' : 'staff' };
  } catch (e) {}
  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;
  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad_json' }); }
  const token = String(input.password || '');
  if (!istToken(token)) { await meldeErgebnis(event, false); return json(401, { error: 'sitzung_noetig' }); }
  const w = await wer(await passwortAusSitzung(token));
  await meldeErgebnis(event, !!w);
  if (!w) return json(401, { error: 'sitzung_noetig' });
  if (w.role !== 'superadmin' && w.role !== 'admin') return json(403, { error: 'rolle' });
  if (!(await sitzungMitZweiFaktor(token))) return json(403, { error: 'zwei_faktor_noetig' });
  const geheimnis = process.env.OFFICE_TICKET_SECRET || '';
  if (geheimnis.length < 32) return json(500, { error: 'nicht_eingerichtet' });
  const basis = (process.env.OFFICE_URL || 'https://office.grillnchill-foodtruck.de').replace(/\/$/, '');
  return json(200, { ok: true, url: basis + '/anmelden#t=' + ticketFuer(w, geheimnis) });
};
