/**
 * cockpit-data.js
 * ----------------------------------------------------------------------------
 * Zahlen fürs Live-Cockpit (cockpit.html): ein Blick, ob der Tag läuft.
 *
 *   POST { password }     Passwort oder Sitzungs-Token aus dem Admin-Tool
 *                         (alle Rollen, auch Mitarbeiter)
 *   POST { teamToken }    Token eines Team-Geräts (lib/team-device.js).
 *                         Fehlt das Modul, werden Team-Tokens abgelehnt.
 *
 *   → { ok, role, owner,
 *       (revenue-Felder sind null, wenn owner false ist: Umsatz nur fuer den Inhaber)
 *       today:           { date, revenue, orders, pickup, delivery },
 *       sameDayLastWeek: { date, revenue, orders, revenueSoFar, ordersSoFar },
 *       top7d:           [ { name, qty } ]   (Top 5 der letzten 7 Tage nach Stückzahl)
 *       open:            Bestellungen von heute, noch nicht abgeholt/geliefert
 *       status:          { paused, pauseMessage, waitTime, deliveryOff, pickupOff },
 *       updatedAt }
 *
 * DATENBASIS
 * ----------
 * Gezählt wird aus den Bestell-Datensätzen (o:GNC-…), nicht aus den
 * Tages-Aggregaten rev:YYYY-MM-DD der Umsatzübersicht. Grund: die Aggregate
 * werden nur für Bestellungen mit E-Mail und bestätigter Zahlung
 * fortgeschrieben, das Cockpit soll aber zeigen, was gerade über den Tresen
 * geht, und braucht ohnehin die Datensätze für "offen" und die Artikel.
 * Der Vergleich mit der Vorwoche geht so auch "bis zur gleichen Uhrzeit".
 * Gezählt wird status 'completed' (ohne Gutscheine, Tests, Stornos,
 * Rückerstattungen, offene Online-Zahlungen). Tag = Abschlusszeit in
 * Europe/Berlin, wie in revenue-stats.js.
 *
 * TEMPO
 * -----
 * Der Schlüssel enthält den Zeitstempel der Bestellung (GNC-<ms>). Gelesen
 * werden nur Datensätze, die in das gefragte Fenster fallen können.
 * Die vergangenen Tage (Top-Liste und Vorwochentag) liegen 5 Minuten im
 * Speicher der Function und im Blob-Store 'cockpit'; bei jedem Aufruf frisch
 * gelesen werden nur die Bestellungen von heute.
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

/* Anmeldung wie in team.js / revenue-stats.js: Hauptpasswort = Inhaber,
   sonst Team-Passwort (admin oder staff). Lesen dürfen alle Rollen. */
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

/* Team-Gerät: das Modul legt ein anderer Baustein an. Solange es fehlt,
   kommt hier niemand mit einem Team-Token herein. */
function teamPruefer() {
  try {
    const m = require('./lib/team-device');
    return (m && typeof m.pruefeTeamToken === 'function') ? m.pruefeTeamToken : null;
  } catch (e) {
    return null;
  }
}

/* ---------------- Zeit in Europe/Berlin ---------------- */
const TZ = 'Europe/Berlin';
const DAY_MS = 86400000;
const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtParts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function berlinDate(ms) { return fmtDate.format(new Date(ms)); }   // YYYY-MM-DD

function berlinTeile(ms) {
  const p = {};
  for (const x of fmtParts.formatToParts(new Date(ms))) p[x.type] = x.value;
  return p;
}
/* Minute des Tages in Berlin (0 bis 1439) */
function berlinMinute(ms) {
  const p = berlinTeile(ms);
  return (parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10);
}
/* Abstand Berlin zu UTC in ms zum Zeitpunkt ms */
function versatz(ms) {
  const p = berlinTeile(ms);
  const alsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return alsUtc - Math.floor(ms / 1000) * 1000;
}
/* Mitternacht des Berliner Tages d als Zeitstempel */
function berlinMitternacht(d) {
  const utc = Date.parse(d + 'T00:00:00Z');
  let t = utc - versatz(utc);
  const v2 = versatz(t);
  if (utc - v2 !== t) t = utc - v2;   // Zeitumstellung zwischen Schätzung und Ergebnis
  return t;
}
function plusTage(d, n) {
  return new Date(Date.parse(d + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
}

/* ---------------- Bestellungen lesen ---------------- */
const r2 = (x) => Math.round(x * 100) / 100;
/* Puffer vor dem Fenster: Online-Zahlungen werden erst nach dem Anlegen
   abgeschlossen, und die Uhr des Kunden-Geräts kann etwas falsch gehen. */
const PUFFER_MS = 2 * 60 * 60 * 1000;

/* Zeitstempel aus dem Schlüssel (o:GNC-1760000000000). null = unbekannt,
   dann wird der Datensatz sicherheitshalber gelesen. */
function keyZeit(key) {
  const m = /^o:GNC-(\d{12,14})$/.exec(key);
  return m ? Number(m[1]) : null;
}

async function liesAlleSchluessel(s) {
  const { blobs } = await s.list({ prefix: 'o:' });
  return blobs.map((b) => b.key).filter((k) => !/^o:GNC-GC-/.test(k));   // Gutschein-Käufe nie
}

async function liesDatensaetze(s, keys) {
  const out = [];
  const CHUNK = 40;   // parallel, aber in sanften Wellen
  for (let i = 0; i < keys.length; i += CHUNK) {
    const teil = keys.slice(i, i + CHUNK);
    const got = await Promise.all(teil.map((k) => s.get(k, { type: 'json' }).catch(() => null)));
    got.forEach((rec) => { if (rec) out.push(rec); });
  }
  return out;
}

/* Zählt diese Bestellung? Liefert die aufbereiteten Felder oder null. */
function bestellung(rec) {
  if (!rec || rec.status !== 'completed' || rec.kind === 'giftcard') return null;
  const o = rec.order || {};
  if (o.isTest) return null;
  const ms = new Date(rec.completedAt || rec.createdAt || 0).getTime();
  if (!ms) return null;
  const total = typeof o.total === 'number' ? o.total : (typeof rec.total === 'number' ? rec.total : 0);
  return {
    ms,
    date: berlinDate(ms),
    total,
    delivery: o.mode === 'delivery',
    fstate: rec.fstate || 'confirmed',
    items: Array.isArray(o.items) ? o.items : [],
  };
}

/* Artikelnamen zusammenfassen: "Classic Burger-Menü (Double Patty) [Pommes, …]"
   zählt als "Classic Burger". Sonst zerfiele ein Renner in viele Varianten. */
function artikelName(n) {
  return String(n || '')
    .replace(/\s*\[[^\]]*\]\s*$/, '')
    .replace(/\s*\(Double Patty\)/i, '')
    .replace(/-Men(ü|ue|u)(?=\s|$)/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}
function zaehleArtikel(ziel, items) {
  for (const it of items) {
    const name = artikelName(it && it.name);
    const qty = Math.max(0, Math.min(999, parseInt(it && it.qty, 10) || 0));
    if (!name || !qty) continue;
    ziel[name] = (ziel[name] || 0) + qty;
  }
}

/* ---------------- Zwischenspeicher für vergangene Tage ---------------- */
const CACHE_MS = 5 * 60 * 1000;
const CACHE_KEY = 'vergangen:v1';
let memCache = null;   // überlebt, solange die Function warm ist

/* Vergangene Tage: Artikel der letzten 6 Tage vor heute + der Tag vor einer
   Woche (je Bestellung Minute, Betrag). */
async function vergangeneTage(s, alleKeys, heute) {
  const jetzt = Date.now();
  if (memCache && memCache.heute === heute && jetzt - memCache.at < CACHE_MS) return memCache;
  let cs = null;
  try { cs = store('cockpit'); } catch (e) {}
  if (cs) {
    try {
      const c = await cs.get(CACHE_KEY, { type: 'json' });
      if (c && c.heute === heute && jetzt - c.at < CACHE_MS) { memCache = c; return c; }
    } catch (e) {}
  }

  const vorwoche = plusTage(heute, -7);
  const von = berlinMitternacht(vorwoche) - PUFFER_MS;
  const bis = berlinMitternacht(heute) + PUFFER_MS;
  const keys = alleKeys.filter((k) => { const t = keyZeit(k); return t === null || (t >= von && t < bis); });
  const recs = await liesDatensaetze(s, keys);

  const ersterTopTag = plusTage(heute, -6);
  const artikel = {};
  const vorwocheListe = [];
  for (const rec of recs) {
    const b = bestellung(rec);
    if (!b || b.date >= heute) continue;
    if (b.date === vorwoche) vorwocheListe.push([berlinMinute(b.ms), r2(b.total)]);
    if (b.date >= ersterTopTag) zaehleArtikel(artikel, b.items);
  }
  const c = { heute, at: jetzt, artikel, vorwoche: vorwocheListe };
  memCache = c;
  if (cs) { try { await cs.setJSON(CACHE_KEY, c); } catch (e) {} }
  return c;
}

/* ---------------- Laden-Status (nur lesen) ---------------- */
/* Gleiche Regeln wie readStatus() in shop-status.js, aber ohne zu schreiben:
   was an einem anderen Tag gesetzt wurde, gilt heute nicht mehr. */
async function liesStatus(heute) {
  const leer = { paused: false, pauseMessage: '', waitTime: 0, deliveryOff: false, pickupOff: false };
  try {
    const d = await store('shop-status').get('status', { type: 'json' });
    if (!d || typeof d !== 'object') return leer;
    const tag = d.dayKey || (d.updatedAt ? berlinDate(new Date(d.updatedAt).getTime()) : null);
    if (tag && tag !== heute) return leer;
    return {
      paused: !!d.paused,
      pauseMessage: typeof d.pauseMessage === 'string' ? d.pauseMessage : '',
      waitTime: Math.max(0, Math.min(120, parseInt(d.waitTime, 10) || 0)),
      deliveryOff: !!d.deliveryOff,
      pickupOff: !!d.pickupOff,
    };
  } catch (e) {
    return leer;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }

  // Bremse gegen Durchprobieren, siehe lib/auth-guard.js
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;

  let who = null;
  if (input.password) {
    who = await authRole(await passwortAusSitzung(String(input.password)));
    await meldeErgebnis(event, !!who);
  } else if (input.teamToken) {
    const pruefe = teamPruefer();
    // Ohne Modul kein Fehlversuch zählen: ein Team-Gerät, das alle 30 s
    // fragt, würde sonst die Adresse des Trucks sperren, auch fürs Admin-Tool.
    if (!pruefe) return json(401, { error: 'unauthorized', hint: 'Team-Geräte werden noch nicht unterstützt' });
    let res = null;
    try { res = await pruefe(String(input.teamToken)); } catch (e) { res = null; }
    const ok = !!res && res.ok !== false && res.valid !== false;
    await meldeErgebnis(event, ok);
    if (ok) who = { role: 'team', name: (res && typeof res === 'object' && res.name) || 'Team-Gerät', owner: !!(res && res.owner) };
  }
  if (!who) return json(401, { error: 'unauthorized' });

  const jetzt = Date.now();
  const heute = berlinDate(jetzt);
  const vorwoche = plusTage(heute, -7);
  const minuteJetzt = berlinMinute(jetzt);

  try {
    const s = store('orders');
    const alleKeys = await liesAlleSchluessel(s);

    const [vergangen, status, heuteRecs] = await Promise.all([
      vergangeneTage(s, alleKeys, heute),
      liesStatus(heute),
      (async () => {
        const ab = berlinMitternacht(heute) - PUFFER_MS;
        const keys = alleKeys.filter((k) => { const t = keyZeit(k); return t === null || t >= ab; });
        return liesDatensaetze(s, keys);
      })(),
    ]);

    const t = { date: heute, revenue: 0, orders: 0, pickup: 0, delivery: 0 };
    let open = 0;
    const artikel = { ...vergangen.artikel };
    for (const rec of heuteRecs) {
      const b = bestellung(rec);
      if (!b || b.date !== heute) continue;
      t.revenue += b.total;
      t.orders += 1;
      if (b.delivery) t.delivery += 1; else t.pickup += 1;
      if (b.fstate !== 'picked_up' && b.fstate !== 'delivered') open += 1;
      zaehleArtikel(artikel, b.items);
    }
    t.revenue = r2(t.revenue);

    const lw = { date: vorwoche, revenue: 0, orders: 0, revenueSoFar: 0, ordersSoFar: 0 };
    for (const [minute, total] of vergangen.vorwoche) {
      lw.revenue += total; lw.orders += 1;
      if (minute <= minuteJetzt) { lw.revenueSoFar += total; lw.ordersSoFar += 1; }
    }
    lw.revenue = r2(lw.revenue);
    lw.revenueSoFar = r2(lw.revenueSoFar);

    const top7d = Object.entries(artikel)
      .map(([name, qty]) => ({ name, qty }))
      .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name, 'de'))
      .slice(0, 5);

    // Umsatz bleibt dem Inhaber vorbehalten (wie revenue-stats.js): Hauptpasswort
    // oder ein Geraet, das Kubi selbst gekoppelt hat. Alle anderen sehen Anzahlen.
    const owner = who.role === 'superadmin' || who.owner === true;
    if (!owner) {
      t.revenue = null;
      lw.revenue = null; lw.revenueSoFar = null;
    }

    return json(200, {
      ok: true,
      role: who.role,
      owner,
      today: t,
      sameDayLastWeek: lw,
      top7d,
      open,
      status,
      updatedAt: new Date(jetzt).toISOString(),
    });
  } catch (e) {
    console.error('cockpit-data:', e && e.message);
    return json(500, { error: 'read_failed' });
  }
};
