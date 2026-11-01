/**
 * lib/tageswerte.js
 * ----------------------------------------------------------------------------
 * Tageswerte aus den Bestell-Datensätzen (o:GNC-<ms>) für die Auswertungen im
 * Cockpit (Speisekarte) und den Wochenbericht.
 *
 * Je Kalendertag (Europe/Berlin, nach Abschlusszeit wie in cockpit-data.js
 * und revenue-stats.js) entsteht ein kleiner Datensatz:
 *
 *   { v, date, at, final,
 *     orders, revenue, pickup, delivery,      Bestellungen, Umsatz (order.total)
 *     haupt:   { <artikel-id>: Stück },       Hauptartikel je Warenkorb-Zeile
 *     artikel: { <artikel-id>: [Stück, Brutto] },  alle Bestandteile mit Anteil
 *     ohne }                                  Zeilen ohne Warenkorb-Daten
 *
 * Gezählt wird status 'completed' ohne Gutschein-Käufe und Testbestellungen,
 * genau wie im Cockpit. Bestellungen aus Telefon oder Truck (quelle) zählen
 * normal mit.
 *
 * MENÜS ZERLEGEN
 * --------------
 * Ein Menü ist Burger + Beilage + Getränk + Dip zu einem Preis. Für die
 * Speisekarten-Auswertung zählt jeder Bestandteil als eigener Artikel. Der
 * Zeilenpreis wird so aufgeteilt wie in der Steuerlogik (splitVat in
 * index.html, nur gelesen, nicht verändert): das Getränk zu seinem
 * Einzelpreis, der Rest anteilig nach Einzelpreisen auf Burger, Beilage und
 * Dip. Ein Double Patty zählt als eigener Bestandteil 'extra-double'. Ein Dip,
 * der bei Pommes oder Nuggets inklusive ist, bekommt ebenfalls seinen Anteil.
 *
 * TEMPO
 * -----
 * Gelesen werden nur Datensätze, deren Schlüssel-Zeitstempel in das Fenster
 * fallen kann. Fertige Tage liegen im Speicher der Function und im Blob-Store
 * 'cockpit' (Schlüssel tag:v1:YYYY-MM-DD). Ein Tag gilt drei Stunden nach
 * Mitternacht als fertig; vorher wird er höchstens 10 Minuten gemerkt, weil
 * Online-Zahlungen noch nachlaufen können.
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

let SK = null;
function speisekarte() {
  if (!SK) SK = require('../../../speisekarte.js');
  return SK;
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

function versatz(ms) {
  const p = {};
  for (const x of fmtParts.formatToParts(new Date(ms))) p[x.type] = x.value;
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
/* Alle Tage von a bis b (beide eingeschlossen) */
function tageVonBis(a, b) {
  const out = [];
  for (let d = a; d <= b && out.length < 400; d = plusTage(d, 1)) out.push(d);
  return out;
}

/* ---------------- Bestellungen ---------------- */
const r2 = (x) => Math.round(x * 100) / 100;
/* Puffer vor dem Fenster: Online-Zahlungen werden erst nach dem Anlegen
   abgeschlossen, und die Uhr des Kunden-Geräts kann etwas falsch gehen. */
const PUFFER_MS = 3 * 60 * 60 * 1000;
const FERTIG_NACH_MS = 3 * 60 * 60 * 1000;
const VORLAEUFIG_MS = 10 * 60 * 1000;

/* Zeitstempel aus dem Schlüssel (o:GNC-1760000000000). null = unbekannt,
   dann wird der Datensatz sicherheitshalber gelesen. */
function keyZeit(key) {
  const m = /^[a-z]+:GNC-(\d{12,14})$/.exec(key);
  return m ? Number(m[1]) : null;
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
    total: Number.isFinite(total) ? total : 0,
    delivery: o.mode === 'delivery',
    korb: (o.cartSnapshot && typeof o.cartSnapshot === 'object' && !Array.isArray(o.cartSnapshot)) ? o.cartSnapshot : null,
    items: Array.isArray(o.items) ? o.items : [],
  };
}

const EXTRA_DOUBLE = 'extra-double';

/**
 * Eine Warenkorb-Zeile in ihre Bestandteile zerlegen.
 * entry: { menuId, qty, double, isMenu, side, drink, dip } wie im cartSnapshot.
 * @returns {{ id, qty, teile: Array<{id, brutto}> } | null}  brutto = für alle Stück der Zeile
 */
function zerlegeZeile(entry, sk) {
  const K = sk || speisekarte();
  if (!entry || typeof entry !== 'object') return null;
  const item = K.MENU.find((m) => m.id === entry.menuId);
  if (!item) return null;
  const qty = Math.floor(Number(entry.qty));
  if (!(qty > 0) || qty > 99) return null;
  const preis = K.einzelpreis(entry);
  if (!(preis >= 0)) return null;
  const finde = (id, cat) => {
    const m = K.MENU.find((x) => x.id === id);
    return m && (!cat || m.cat === cat) ? m : null;
  };

  const teile = [{ id: item.id, einzel: item.price }];
  if (entry.double && K.DOUBLE_PATTY_EXCLUDE_IDS.indexOf(item.id) === -1) {
    teile.push({ id: EXTRA_DOUBLE, einzel: K.DOUBLE_PATTY_PRICE });
  }
  let getraenk = null;
  if (entry.isMenu) {
    const opt = K.MENU_SIDE_OPTIONS.find((s) => s.id === entry.side) || K.MENU_SIDE_OPTIONS[0];
    const beilage = opt && finde(opt.id);
    if (beilage) teile.push({ id: beilage.id, einzel: beilage.price });
    const g = K.MENU_DRINK_IDS.indexOf(entry.drink) !== -1 ? finde(entry.drink, 'drinks') : null;
    if (g) getraenk = { id: g.id, einzel: g.price };
  }
  const dip = entry.dip ? finde(entry.dip, 'dips') : null;
  if (dip && item.cat !== 'dips') teile.push({ id: dip.id, einzel: dip.price });

  // Wie splitVat: das Getränk zu seinem Einzelpreis, der Rest anteilig
  const getraenkAnteil = getraenk ? Math.min(getraenk.einzel, preis) : 0;
  const rest = preis - getraenkAnteil;
  const summe = teile.reduce((s, t) => s + t.einzel, 0);
  const aus = teile.map((t, i) => ({
    id: t.id,
    brutto: (summe > 0 ? rest * t.einzel / summe : (i === 0 ? rest : 0)) * qty,
  }));
  if (getraenk) aus.push({ id: getraenk.id, brutto: getraenkAnteil * qty });
  return { id: item.id, qty, teile: aus };
}

/* Warenkorb-Zeilen einer Bestellung. Ohne cartSnapshot werden nur Positionen
   genommen, die selbst eine menuId tragen; der Rest zählt als "ohne". */
function zeilenDerBestellung(b) {
  if (b.korb) return { zeilen: Object.keys(b.korb).slice(0, 80).map((k) => b.korb[k]), ohne: 0 };
  const zeilen = [];
  let ohne = 0;
  for (const it of b.items.slice(0, 80)) {
    if (it && typeof it === 'object' && typeof it.menuId === 'string') zeilen.push(it);
    else ohne += Math.max(0, Math.min(99, parseInt(it && it.qty, 10) || 0));
  }
  return { zeilen, ohne };
}

/** Tageswert aus den Datensätzen bauen (rein, ohne Speicher). */
function tagAggregat(datum, recs, sk) {
  const t = { v: 1, date: datum, orders: 0, revenue: 0, pickup: 0, delivery: 0, haupt: {}, artikel: {}, ohne: 0 };
  for (const rec of recs) {
    const b = bestellung(rec);
    if (!b || b.date !== datum) continue;
    t.orders += 1;
    t.revenue += b.total;
    if (b.delivery) t.delivery += 1; else t.pickup += 1;
    const { zeilen, ohne } = zeilenDerBestellung(b);
    t.ohne += ohne;
    for (const e of zeilen) {
      const z = zerlegeZeile(e, sk);
      if (!z) { t.ohne += Math.max(0, Math.min(99, parseInt(e && e.qty, 10) || 0)); continue; }
      t.haupt[z.id] = (t.haupt[z.id] || 0) + z.qty;
      for (const teil of z.teile) {
        const a = t.artikel[teil.id] || (t.artikel[teil.id] = [0, 0]);
        a[0] += z.qty;
        a[1] += teil.brutto;
      }
    }
  }
  t.revenue = r2(t.revenue);
  for (const id of Object.keys(t.artikel)) t.artikel[id][1] = r2(t.artikel[id][1]);
  return t;
}

/* ---------------- Lesen mit Zwischenspeicher ---------------- */
const CACHE_PREFIX = 'tag:v1:';
const memCache = new Map();   // überlebt, solange die Function warm ist

function noch(c, jetzt) {
  return c && c.v === 1 && (c.final || jetzt - c.at < VORLAEUFIG_MS);
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

/* Lückenlose Folgen von Tagen bilden, damit zwischen zwei fehlenden Tagen
   nicht die schon gemerkten Tage noch einmal gelesen werden. */
function folgen(tage) {
  const out = [];
  for (const d of tage.slice().sort()) {
    const letzte = out[out.length - 1];
    if (letzte && plusTage(letzte[letzte.length - 1], 1) === d) letzte.push(d);
    else out.push([d]);
  }
  return out;
}

/**
 * Tageswerte für die gewünschten Tage. Nur vergangene Tage (vor heute).
 * @param {string[]} tage  YYYY-MM-DD
 * @param {object} [o]     { jetzt, sk }
 * @returns {Promise<Object<string, object>>}  date -> Tageswert
 */
async function liesTage(tage, o) {
  const opt = o || {};
  const jetzt = opt.jetzt || Date.now();
  const heute = berlinDate(jetzt);
  const gesucht = [...new Set(tage)].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < heute);
  const ergebnis = {};
  const fehlt = [];

  let cs = null;
  try { cs = store('cockpit'); } catch (e) {}

  await Promise.all(gesucht.map(async (d) => {
    const m = memCache.get(d);
    if (noch(m, jetzt)) { ergebnis[d] = m; return; }
    if (cs) {
      try {
        const c = await cs.get(CACHE_PREFIX + d, { type: 'json' });
        if (noch(c, jetzt)) { memCache.set(d, c); ergebnis[d] = c; return; }
      } catch (e) {}
    }
    fehlt.push(d);
  }));
  if (!fehlt.length) return ergebnis;

  const s = store('orders');
  const { blobs } = await s.list({ prefix: 'o:' });
  const alleKeys = blobs.map((b) => b.key).filter((k) => !/^o:GNC-GC-/.test(k));   // Gutschein-Käufe nie

  for (const folge of folgen(fehlt)) {
    const von = berlinMitternacht(folge[0]) - PUFFER_MS;
    const bis = berlinMitternacht(plusTage(folge[folge.length - 1], 1)) + PUFFER_MS;
    const keys = alleKeys.filter((k) => { const t = keyZeit(k); return t === null || (t >= von && t < bis); });
    const recs = await liesDatensaetze(s, keys);
    for (const d of folge) {
      const agg = tagAggregat(d, recs, opt.sk);
      agg.at = jetzt;
      agg.final = jetzt >= berlinMitternacht(plusTage(d, 1)) + FERTIG_NACH_MS;
      ergebnis[d] = agg;
      memCache.set(d, agg);
      if (cs) { try { await cs.setJSON(CACHE_PREFIX + d, agg); } catch (e) {} }
    }
  }
  return ergebnis;
}

/** Tageswerte zusammenzählen. */
function summiere(liste) {
  const s = { tage: 0, orders: 0, revenue: 0, pickup: 0, delivery: 0, haupt: {}, artikel: {}, ohne: 0 };
  for (const t of liste) {
    if (!t) continue;
    s.tage += 1;
    s.orders += t.orders || 0;
    s.revenue += t.revenue || 0;
    s.pickup += t.pickup || 0;
    s.delivery += t.delivery || 0;
    s.ohne += t.ohne || 0;
    for (const [id, n] of Object.entries(t.haupt || {})) s.haupt[id] = (s.haupt[id] || 0) + n;
    for (const [id, a] of Object.entries(t.artikel || {})) {
      const z = s.artikel[id] || (s.artikel[id] = [0, 0]);
      z[0] += a[0]; z[1] += a[1];
    }
  }
  s.revenue = r2(s.revenue);
  for (const id of Object.keys(s.artikel)) s.artikel[id][1] = r2(s.artikel[id][1]);
  return s;
}

function _leereZwischenspeicher() { memCache.clear(); }

module.exports = {
  liesTage, summiere, tagAggregat, zerlegeZeile, bestellung, keyZeit,
  berlinDate, berlinMitternacht, plusTage, tageVonBis, store,
  EXTRA_DOUBLE, _leereZwischenspeicher,
};
