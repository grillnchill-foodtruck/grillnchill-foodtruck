/**
 * lib/wartezeit.js
 * ----------------------------------------------------------------------------
 * Wartezeit, die sich selbst rechnet (Admin: Heute → Live-Wartezeit →
 * „Automatisch"). Liest shop-status.js für die Kundenseite und
 * cockpit-data.js fürs Cockpit.
 *
 *   Minuten = waitBase + offene Burger heute × waitPerBurger,
 *             auf 5 Minuten gerundet, höchstens waitMax.
 *
 * Offen heißt: Bestellung abgeschlossen (status 'completed'), Status
 * 'confirmed' oder 'preparing', Abholtag heute (Feld abholTag aus
 * lib/abholnummer.js, bei älteren Datensätzen der Tag des Abschlusses).
 * Testbestellungen und Gutschein-Käufe zählen nicht.
 *
 * Burger zählen über speisekarte.js: jede Warenkorb-Zeile, deren Artikel in
 * der Kategorie 'burger' steht, mit ihrer Menge. Ein Menü ist eine solche
 * Zeile mit isMenu, zählt also mit. Fehlt der Warenkorb, werden die
 * Artikelnamen mit den Burgernamen der Karte verglichen.
 *
 * Außerhalb der Öffnungszeit (OEFFNUNG in lib/standing.js) ist die
 * Wartezeit 0, sonst stünde sonntags „ca. 10 Min." auf der Seite.
 *
 * Das Ergebnis liegt 20 Sekunden im Speicher der Function. Zusammen mit dem
 * 10-s-CDN-Cache von shop-status liest das höchstens alle 20 s die
 * Bestellungen der letzten 36 Stunden.
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');
const { berlinTag, istGeoeffnet } = require('./abholnummer');

function ordersStore() {
  const opts = { name: 'orders', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

let SK = null;
try { SK = require('../../../speisekarte.js'); } catch (e) { SK = null; }

const STANDARD = { waitAuto: false, waitBase: 10, waitPerBurger: 3, waitMax: 60 };
const OFFEN = ['confirmed', 'preparing'];
const FENSTER_MS = 36 * 3600 * 1000;
const MEMO_MS = 20 * 1000;

function klemme(v, min, max, std) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : std;
}

/** Einstellungen aus dem shop-status-Datensatz, geprüft und mit Standards. */
function einstellungen(d) {
  const x = (d && typeof d === 'object') ? d : {};
  return {
    waitAuto: x.waitAuto === true,
    waitBase: klemme(x.waitBase, 0, 60, STANDARD.waitBase),
    waitPerBurger: klemme(x.waitPerBurger, 0, 15, STANDARD.waitPerBurger),
    waitMax: klemme(x.waitMax, 5, 120, STANDARD.waitMax),
  };
}

/** Minuten aus Einstellungen und Burgerzahl. */
function berechne(cfg, burger) {
  const c = einstellungen(cfg);
  const roh = c.waitBase + Math.max(0, Number(burger) || 0) * c.waitPerBurger;
  return Math.max(0, Math.min(c.waitMax, Math.round(roh / 5) * 5));
}

let burgerNamen = null;
function namenListe() {
  if (!burgerNamen && SK) {
    burgerNamen = SK.MENU.filter((m) => m.cat === 'burger').map((m) => m.name).sort((a, b) => b.length - a.length);
  }
  return burgerNamen || [];
}
const menge = (q) => Math.max(0, Math.min(99, parseInt(q, 10) || 0));

/** Burger in einer Bestellung (order-Objekt aus dem Datensatz). */
function burgerInBestellung(order) {
  if (!SK || !order || typeof order !== 'object') return 0;
  const korb = order.cartSnapshot;
  if (korb && typeof korb === 'object' && Object.keys(korb).length) {
    let n = 0;
    for (const k of Object.keys(korb)) {
      const e = korb[k];
      if (!e) continue;
      const item = SK.MENU.find((m) => m.id === e.menuId);
      if (item && item.cat === 'burger') n += menge(e.qty);
    }
    return n;
  }
  const namen = namenListe();
  let n = 0;
  for (const it of (Array.isArray(order.items) ? order.items : [])) {
    const name = String((it && it.name) || '');
    if (namen.some((b) => name.startsWith(b))) n += menge(it && it.qty);
  }
  return n;
}

/** Zählt diese Bestellung heute als offen? */
function istOffenHeute(rec, heute) {
  if (!rec || rec.status !== 'completed' || rec.kind === 'giftcard') return false;
  const o = rec.order || {};
  if (o.isTest) return false;
  if (!OFFEN.includes(rec.fstate || 'confirmed')) return false;
  const tag = rec.abholTag || berlinTag(new Date(rec.completedAt || rec.createdAt || 0).getTime());
  return tag === heute;
}

/** Offene Burger heute aus dem orders-Store (ohne Zwischenspeicher). */
async function offeneBurgerHeute(s, jetzt) {
  const ms = jetzt == null ? Date.now() : jetzt;
  const heute = berlinTag(ms);
  const { blobs } = await s.list({ prefix: 'o:' });
  const keys = blobs.map((b) => b.key).filter((k) => {
    const m = /^o:GNC-(\d{12,14})$/.exec(k);
    return m && Number(m[1]) >= ms - FENSTER_MS;
  });
  let burger = 0, bestellungen = 0;
  const WELLE = 40;
  for (let i = 0; i < keys.length; i += WELLE) {
    const teil = keys.slice(i, i + WELLE);
    const recs = await Promise.all(teil.map((k) => s.get(k, { type: 'json' }).catch(() => null)));
    for (const rec of recs) {
      if (!istOffenHeute(rec, heute)) continue;
      bestellungen++;
      burger += burgerInBestellung(rec.order);
    }
  }
  return { burger, bestellungen };
}

let memo = null;   // { at, heute, wert }, überlebt, solange die Function warm ist

/**
 * Aktuelle automatische Wartezeit.
 * @returns {Promise<{minuten:number, burger:number, bestellungen:number, offen:boolean}>}
 */
async function aktuelleWartezeit(cfg, optionen) {
  const o = optionen || {};
  const jetzt = o.jetzt == null ? Date.now() : o.jetzt;
  const offen = o.immerOffen ? true : istGeoeffnet(jetzt);
  // Geschlossen: nichts lesen, die Kundenseite zeigt dann keine Wartezeit.
  // Die Vorschau im Admin (immerZaehlen) will die Zahl trotzdem sehen.
  if (!offen && !o.immerZaehlen) return { minuten: 0, burger: null, bestellungen: null, offen: false };
  const heute = berlinTag(jetzt);
  let zaehlung;
  if (!o.frisch && memo && memo.heute === heute && jetzt - memo.at < MEMO_MS) {
    zaehlung = memo.wert;
  } else {
    zaehlung = await offeneBurgerHeute(o.store || ordersStore(), jetzt);
    memo = { at: jetzt, heute, wert: zaehlung };
  }
  return {
    minuten: offen ? berechne(cfg, zaehlung.burger) : 0,
    burger: zaehlung.burger,
    bestellungen: zaehlung.bestellungen,
    offen,
  };
}

function memoLeeren() { memo = null; }

module.exports = {
  STANDARD, einstellungen, berechne, burgerInBestellung, istOffenHeute,
  offeneBurgerHeute, aktuelleWartezeit, memoLeeren,
};
