/**
 * orders-list.js
 * ----------------------------------------------------------------------------
 * Bestell-Archiv fürs Admin-Tool (Tab "Bestellungen").
 *
 *   GET /.netlify/functions/orders-list?password=...&days=30
 *   → { orders: [ { reference, status, fstate, createdAt, completedAt, payStatus,
 *                   arrivedAt?, order:{...} } ], days }
 *
 * Anmeldung, eins von beiden:
 *   password=<Passwort oder Sitzungs-Token>      Admin-Tool (wie bisher)
 *   teamToken=<Token>                            gekoppeltes Team-Gerät
 *     oder als Header  X-GNC-Team-Token: <Token>  (bevorzugt, landet in keinem
 *     URL-Protokoll). Token aus team-device.js (action 'redeem').
 * Ist ein Team-Token da, gilt nur er. Fehlversuche zählen in die Bremse,
 * ein Erfolg setzt sie nicht zurück. Die App soll nach 401 nicht weiter
 * abfragen (Gerät entkoppelt), sonst sperrt sie ihre IP.
 *
 * arrivedAt: Zeitpunkt, zu dem der Gast "Ich bin da" gemeldet hat
 * (order-status.js, action 'arrived'). Fehlt, solange niemand da ist.
 *
 * status: completed (abgeschlossen & benachrichtigt) · pending (Online-Zahlung
 * offen, wird alle 15 Min. abgeglichen) · abandoned (Zahlungsabbruch).
 * Aufbewahrung: 90 Tage (Aufräumen in orders-reconcile.js).
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-GNC-Team-Token',
};
const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify(data),
});

function store() {
  const opts = { name: 'orders', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}


// --- Team-Auth: admin (ADMIN_PASSWORD) oder staff (Team-Store, siehe team.js) ---
const _teamCrypto = require('crypto');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung, nachweis } = require('./lib/admin-sitzung');
const { pruefeTeamToken } = require('./lib/team-device');
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

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'GET') return json(405, { error: 'method_not_allowed' });

  const p = event.queryStringParameters || {};
  // Bremse gegen Durchprobieren – siehe lib/auth-guard.js
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;
  const h = event.headers || {};
  const teamToken = h['x-gnc-team-token'] || h['X-GNC-Team-Token'] || p.teamToken || '';
  let who = null;
  if (teamToken) {
    who = await pruefeTeamToken(teamToken);
    if (!who) await meldeErgebnis(event, false);
  } else {
    who = await authRole(await passwortAusSitzung(nachweis(event, p.password)));
    await meldeErgebnis(event, !!who);
  }
  if (!who) return json(401, { error: 'unauthorized' });

  const days = Math.min(parseInt(p.days || '30', 10) || 30, 90);
  const since = Date.now() - days * 86400000;

  try {
    const s = store();
    const { blobs } = await s.list({ prefix: 'o:' });
    /* Vorher wurde jede Bestellung der letzten 90 Tage einzeln und nacheinander
       gelesen, bei jedem Neuladen des Admin-Tools. Der Schlüssel trägt aber den
       Zeitpunkt der Bestellung (o:GNC-<ms>, wie in cockpit-data.js): Ältere
       als der Zeitraum werden gar nicht erst gelesen (zwei Tage Puffer für
       Vorbestellungen), der Rest parallel in Wellen und neueste zuerst.
       Schlüssel ohne Zeitstempel (z. B. Gutschein-Käufe) werden wie bisher gelesen. */
    const zeit = (k) => { const m = /^o:GNC-(\d{12,14})$/.exec(k); return m ? Number(m[1]) : null; };
    const keys = blobs.map((b) => b.key)
      .filter((k) => { const t = zeit(k); return t == null || t >= since - 2 * 86400000; })
      .sort((a, b2) => (zeit(b2) || Infinity) - (zeit(a) || Infinity));
    const out = [];
    const WELLE = 40;
    for (let i = 0; i < keys.length && out.length < 400; i += WELLE) {
      const teil = keys.slice(i, i + WELLE);
      const recs = await Promise.all(teil.map((k) => s.get(k, { type: 'json' }).catch(() => null)));
      for (let j = 0; j < teil.length; j++) {
        const b = { key: teil[j] };
        const rec = recs[j];
        if (out.length >= 400) break;
        if (!rec) continue;
        // Stornierte Vorgänge (Rückzieher im Zahlungsfenster, Supersede, Admin-Storno)
        // bleiben unsichtbar – sie existieren nur noch als Sicherheitsnetz für den
        // Webhook (Zahlung schlägt Storno) und werden nach 14 Tagen aufgeräumt.
        if (rec.status === 'cancelled') continue;
        if (rec.kind === 'giftcard') continue; // Gutschein-Käufe: eigener Bereich im Gutschein-Tab
        const ts = new Date(rec.completedAt || rec.createdAt || 0).getTime();
        if (ts < since) continue;
        out.push({
          reference: (rec.order && rec.order.reference) || b.key.slice(2),
          status: rec.status || 'completed',
          fstate: rec.fstate || null,
          createdAt: rec.createdAt || null,
          completedAt: rec.completedAt || null,
          payStatus: rec.payStatus || null,
          ...(rec.arrivedAt ? { arrivedAt: rec.arrivedAt } : {}),
          order: rec.order || null,
        });
      }
    }
    out.sort((a, b2) => new Date(b2.completedAt || b2.createdAt) - new Date(a.completedAt || a.createdAt));
    return json(200, { orders: out, days });
  } catch (e) {
    return json(500, { error: 'read_failed', detail: String((e && e.message) || e) });
  }
};
