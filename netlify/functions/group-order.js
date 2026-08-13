/**
 * group-order.js
 * ----------------------------------------------------------------------------
 * Gruppenbestellung ("Team-Mittag"): Ein Gastgeber erstellt einen teilbaren
 * Link, Kolleg:innen legen darüber ihre Auswahl mit Namen in eine gemeinsame
 * Liste, der Gastgeber übernimmt alles in EINEN Checkout (eine Lieferung,
 * eine Zahlung). Für die Küche landet die Pro-Person-Aufschlüsselung in der
 * Bestell-Notiz.
 *
 *   POST { action: 'create', host }                → { id, hostKey }
 *   POST { action: 'get', id }                     → { group } (ohne hostKey)
 *   POST { action: 'add', id, person, entries, lines, total }
 *   POST { action: 'close', id, hostKey }          → { group } (sperrt Beiträge)
 *
 * Sicherheit: Die Gruppen-ID ist der Zugriffs-Schlüssel (Capability-Link),
 * der hostKey berechtigt zusätzlich zum Schließen. Preise werden hier NICHT
 * vertraut – der Gastgeber-Warenkorb berechnet beim Import alles neu aus der
 * Speisekarte. Gruppen verfallen nach 48 Stunden (Lazy-Cleanup + Cron).
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const GROUP_TTL_MS = 48 * 3600 * 1000;
const MAX_CONTRIBUTIONS = 30;
const MAX_ENTRY_BYTES = 20000;

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

function store() {
  const opts = { name: 'groups', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomId(n) {
  const buf = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHA[buf[i] % ALPHA.length];
  return out;
}

const cleanId = (x) => String(x || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 8);
const cleanText = (x, n) => String(x || '').replace(/[<>]/g, '').trim().slice(0, n);

function publicView(g) {
  const { hostKey, ...rest } = g;
  return rest;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }
  const action = String(input.action || '');
  const s = store();

  try {
    // ---------- Gruppe erstellen ----------
    if (action === 'create') {
      const host = cleanText(input.host, 40) || 'Team';
      let id = randomId(8);
      for (let i = 0; i < 4 && await s.get('g:' + id, { type: 'json' }); i++) id = randomId(8);
      const hostKey = randomId(12);
      const group = {
        id, host, hostKey,
        status: 'open',
        createdAt: new Date().toISOString(),
        contributions: [],
      };
      await s.setJSON('g:' + id, group);
      return json(200, { ok: true, id, hostKey, group: publicView(group) });
    }

    const id = cleanId(input.id);
    if (!id || id.length !== 8) return json(400, { error: 'bad_id' });
    const key = 'g:' + id;
    const g = await s.get(key, { type: 'json' });
    if (!g) return json(404, { error: 'not_found' });

    // Lazy-TTL: abgelaufene Gruppen entsorgen
    if (Date.now() - new Date(g.createdAt).getTime() > GROUP_TTL_MS) {
      try { await s.delete(key); } catch (e) {}
      return json(404, { error: 'expired' });
    }

    // ---------- Gruppe lesen ----------
    if (action === 'get') {
      return json(200, { ok: true, group: publicView(g) });
    }

    // ---------- Beitrag hinzufügen ----------
    if (action === 'add') {
      if (g.status !== 'open') return json(409, { error: 'closed' });
      if (g.contributions.length >= MAX_CONTRIBUTIONS) return json(409, { error: 'full' });
      const person = cleanText(input.person, 30);
      if (!person) return json(400, { error: 'missing_person' });
      const entries = input.entries && typeof input.entries === 'object' ? input.entries : null;
      const lines = Array.isArray(input.lines) ? input.lines.slice(0, 25).map(l => ({
        name: cleanText(l && l.name, 120),
        qty: Math.max(1, Math.min(20, parseInt(l && l.qty, 10) || 1)),
      })) : [];
      if (!entries || !lines.length) return json(400, { error: 'missing_items' });
      if (JSON.stringify(entries).length > MAX_ENTRY_BYTES) return json(413, { error: 'too_large' });
      g.contributions.push({
        person,
        entries,
        lines,
        total: Math.max(0, Math.min(500, parseFloat(input.total) || 0)), // nur Anzeige – Import rechnet neu
        at: new Date().toISOString(),
      });
      await s.setJSON(key, g);
      return json(200, { ok: true, group: publicView(g) });
    }

    // ---------- Gruppe schließen (nur Gastgeber) ----------
    if (action === 'close') {
      if (String(input.hostKey || '') !== g.hostKey) return json(403, { error: 'forbidden' });
      g.status = 'closed';
      g.closedAt = new Date().toISOString();
      await s.setJSON(key, g);
      return json(200, { ok: true, group: publicView(g) });
    }

    return json(400, { error: 'unknown_action' });
  } catch (e) {
    return json(500, { error: 'group_failed', detail: String((e && e.message) || e) });
  }
};
