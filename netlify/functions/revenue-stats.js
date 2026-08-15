/**
 * revenue-stats.js
 * ----------------------------------------------------------------------------
 * Umsatzübersicht für Admins (Rolle 'admin', inkl. Inhaber-Passwort).
 *
 *   POST { password, from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
 *   → { ok, days: [{date, oCount, oTotal, pickupCount, pickupTotal,
 *                   deliveryCount, deliveryTotal, gcCount, gcTotal}], backfilled }
 *
 * Datenbasis sind Tages-Aggregate (Key rev:YYYY-MM-DD im 'orders'-Store), die
 * bei jedem Abschluss fortgeschrieben werden (send-email für Bestellungen,
 * Webhook/Admin-Aktion für Gutschein-Käufe). So bleibt ein Jahresblick möglich,
 * obwohl Roh-Bestellungen nach 90 Tagen aufgeräumt werden.
 * Beim allerersten Aufruf werden vorhandene Bestellungen einmalig rückwirkend
 * in die Aggregate übernommen (meta:rev_backfill).
 * Hinweis: Rückerstattungen werden nicht abgezogen – die Übersicht zeigt
 * Brutto-Umsatz nach Abschluss.
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
    const h = crypto.createHash('sha256').update(String(pw)).digest('hex');
    for (const b of blobs) {
      const u = await t.get(b.key, { type: 'json' });
      if (u && u.pwHash === h) return { role: u.role === 'admin' ? 'admin' : 'staff', name: u.name || b.key.slice(2) };
    }
  } catch (e) {}
  return null;
}

function berlinDate(iso) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso || Date.now()));
  return parts; // en-CA liefert YYYY-MM-DD
}

const EMPTY = () => ({
  oCount: 0, oTotal: 0, pickupCount: 0, pickupTotal: 0,
  deliveryCount: 0, deliveryTotal: 0, gcCount: 0, gcTotal: 0,
});
const r2 = (x) => Math.round(x * 100) / 100;

async function backfillIfNeeded(s) {
  const meta = await s.get('meta:rev_backfill', { type: 'json' });
  if (meta && meta.done) return false;
  const days = {};
  try {
    const { blobs } = await s.list({ prefix: 'o:' });
    for (const b of blobs) {
      try {
        const rec = await s.get(b.key, { type: 'json' });
        if (!rec || rec.status !== 'completed') continue;
        const d = berlinDate(rec.completedAt || rec.createdAt);
        days[d] = days[d] || EMPTY();
        if (rec.kind === 'giftcard') {
          const amt = (rec.gift && rec.gift.amount) || rec.total || 0;
          days[d].gcCount += 1;
          days[d].gcTotal = r2(days[d].gcTotal + amt);
        } else {
          const o = rec.order || {};
          const total = typeof o.total === 'number' ? o.total : (rec.total || 0);
          days[d].oCount += 1;
          days[d].oTotal = r2(days[d].oTotal + total);
          if (o.mode === 'delivery') {
            days[d].deliveryCount += 1;
            days[d].deliveryTotal = r2(days[d].deliveryTotal + total);
          } else {
            days[d].pickupCount += 1;
            days[d].pickupTotal = r2(days[d].pickupTotal + total);
          }
        }
      } catch (e) {}
    }
    for (const [d, agg] of Object.entries(days)) {
      const existing = (await s.get('rev:' + d, { type: 'json' })) || EMPTY();
      // Backfill läuft nur einmal – vorhandene Live-Aggregate desselben Tages
      // stammen aus Abschlüssen NACH Deploy dieser Version; einfache Addition
      // würde diese doppelt zählen, daher gewinnt der größere Stand.
      const merged = {};
      for (const k of Object.keys(EMPTY())) merged[k] = Math.max(existing[k] || 0, agg[k]);
      await s.setJSON('rev:' + d, merged);
    }
    await s.setJSON('meta:rev_backfill', { done: true, at: new Date().toISOString(), days: Object.keys(days).length });
    return true;
  } catch (e) {
    return false;
  }
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
  if (who.role !== 'superadmin') return json(403, { error: 'forbidden', hint: 'Die Umsatzübersicht ist dem Inhaber vorbehalten' });

  const re = /^\d{4}-\d{2}-\d{2}$/;
  const from = String(input.from || '');
  const to = String(input.to || '');
  if (!re.test(from) || !re.test(to)) return json(400, { error: 'bad_range', hint: 'from/to als YYYY-MM-DD' });
  const fromD = new Date(from + 'T00:00:00Z');
  const toD = new Date(to + 'T00:00:00Z');
  if (!(fromD <= toD)) return json(400, { error: 'bad_range', hint: 'from muss vor to liegen' });
  const span = Math.round((toD - fromD) / 86400000) + 1;
  if (span > 400) return json(400, { error: 'range_too_long', hint: 'Maximal 400 Tage' });

  const s = store('orders');
  let backfilled = false;
  try { backfilled = await backfillIfNeeded(s); } catch (e) {}

  const dates = [];
  for (let i = 0; i < span; i++) {
    dates.push(new Date(fromD.getTime() + i * 86400000).toISOString().slice(0, 10));
  }
  const days = [];
  const CHUNK = 50; // parallel, aber in sanften Wellen (Jahres-Abfrage ohne Timeout)
  for (let i = 0; i < dates.length; i += CHUNK) {
    const part = dates.slice(i, i + CHUNK);
    const got = await Promise.all(part.map(function (d) {
      return s.get('rev:' + d, { type: 'json' }).catch(function () { return null; });
    }));
    part.forEach(function (d, j) { days.push({ date: d, ...(got[j] || EMPTY()) }); });
  }
  return json(200, { ok: true, days, backfilled });
};
