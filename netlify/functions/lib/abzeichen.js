/**
 * lib/abzeichen.js
 * ----------------------------------------------------------------------------
 * Jahres-Statistik je Kunde, Abzeichen und der Jahresrueckblick
 * ("Dein Burger-Jahr").
 *
 * WO DIE DATEN LIEGEN
 * -------------------
 * Im Kundendatensatz (Store 'customers', Schluessel c:<sha256(email)>):
 *
 *   cust.stats = {
 *     "2026": {
 *       orders: 12, total: 187.5,
 *       items:    { "kubis": 4, "pommes": 6, ... }   Menge je Artikel-ID
 *       cats:     { burger, sides, dips, drinks, veggie, double }
 *       hours:    { "12": 5, "19": 2 }               Stunde (Berlin) -> Bestellungen
 *       weekdays: { "5": 7 }                         0 = Sonntag ... 6 = Samstag
 *       months:   { "10": 3 }                        1 ... 12
 *       lunch: 4,                                    Bestellungen 11:30 bis 13:59
 *       late: 1,                                     Bestellungen ab 19:30
 *       days:     ["2026-10-09", ...]                verschiedene Tage, sortiert, max. 400
 *       firstAt, lastAt                              ISO-Zeitpunkte
 *     }
 *   }
 *   cust.badgesAt = { "stammgast": "2026-...", "mittagspause:2026": "2026-..." }
 *
 * Alle Zeiten zaehlen in Europe/Berlin, nicht in UTC: eine Bestellung um
 * 00:30 Uhr deutscher Zeit gehoert zum neuen Tag, auch wenn UTC noch den
 * alten zeigt.
 *
 * WAS IN DIE ZAEHLUNG GEHT
 * ------------------------
 * Grundlage ist der Warenkorb-Schnappschuss der Bestellung (order.cartSnapshot,
 * Eintraege { menuId, qty, double, isMenu, side, drink, dip }). Die
 * Positionsliste order.items traegt nur Anzeigenamen und taugt dafuer nicht.
 * Kategorien und Veggie-Kennzeichen kommen aus speisekarte.js, derselben Datei,
 * die auch die Preise liefert. Unbekannte IDs (alter Browser-Cache) werden
 * uebersprungen, damit bleibt die Artikelliste auf die Karte begrenzt.
 *
 *   Menue-Bestandteile (Beilage, Getraenk, Dip) zaehlen als eigene Artikel.
 *   cats.veggie   = Veggie-Burger (Kategorie burger UND veggie in der Karte).
 *                   Pommes sind in der Karte auch "veggie", zaehlen hier aber
 *                   bewusst nicht, sonst waere das Abzeichen geschenkt.
 *   cats.double   = Burger mit Double Patty: Zuschlag "double" ODER ein Burger,
 *                   der schon von Haus aus doppelt ist (DOUBLE_PATTY_EXCLUDE_IDS,
 *                   derzeit 'kubis').
 *
 * ABZEICHEN UND IHRE ARTIKEL
 * --------------------------
 *   erster-burger   1 Bestellung                         alle Jahre
 *   stammgast       5 Bestellungen                       alle Jahre
 *   grill-profi     25 Bestellungen                      alle Jahre
 *   smash-10        10 Smashburger                       alle Jahre
 *                   SMASH_IDS = ['kubis']. In der Karte ist nur das Kubis
 *                   Special als Smashburger beschrieben ("Smashburger, Double
 *                   Patty"), die uebrigen Burger als "Beef-Patty".
 *   veggie-fan      5 Veggie-Burger                      alle Jahre
 *                   classic-veg, cheese-veg, chilicheese-veg, whitebbq-veg
 *   dip-sammler     jeder Dip mindestens einmal          alle Jahre
 *                   dip-mayo, dip-ket, dip-mango, dip-sweetsour
 *   freitagsritual  an jedem Freitag eines Kalendermonats  je Jahr
 *   mittagspause    10 Bestellungen 11:30 bis 13:59      je Jahr
 *   spaetschicht    5 Bestellungen ab 19:30              je Jahr
 *   double-trouble  5 Burger mit Double Patty            alle Jahre
 *
 * Einmal erreicht bleibt erreicht: der Zeitpunkt landet in cust.badgesAt.
 * "je Jahr"-Abzeichen tragen das Jahr im Schluessel und starten jedes Jahr neu.
 * ----------------------------------------------------------------------------
 */

'use strict';

let SK = null;
try {
  SK = require('../../../speisekarte.js');
} catch (e) {
  console.error('abzeichen: speisekarte.js nicht ladbar -', e && e.message);
}

const ZONE = 'Europe/Berlin';
const MAX_ITEMS = 60;   // Artikel-Map je Jahr, die Karte hat derzeit 24 IDs
const MAX_DAYS = 400;   // verschiedene Tage je Jahr (mehr als 366 kommen nie vor)
const MAX_YEARS = 12;   // Jahre im Datensatz, aelteste fallen raus
const MAX_BADGES_AT = 120;

/* ------------------------------------------------------------------------
   Karte -> { id: { cat, veggie } }
   ------------------------------------------------------------------------ */
const ARTIKEL = {};
const DIP_IDS = [];
let DOUBLE_IMMER = ['kubis'];
if (SK && Array.isArray(SK.MENU)) {
  for (const m of SK.MENU) {
    ARTIKEL[m.id] = { cat: m.cat, veggie: !!m.veggie, name: m.name };
    if (m.cat === 'dips') DIP_IDS.push(m.id);
  }
  if (Array.isArray(SK.DOUBLE_PATTY_EXCLUDE_IDS)) DOUBLE_IMMER = SK.DOUBLE_PATTY_EXCLUDE_IDS.slice();
}
/* Ohne Karte (sollte nie passieren) aus der ID ableiten, damit die Zaehlung
   nicht ganz ausfaellt. */
function artikelInfo(id) {
  if (ARTIKEL[id]) return ARTIKEL[id];
  if (SK) return null; // Karte geladen, ID unbekannt: ueberspringen
  if (!/^[a-z0-9-]{2,30}$/.test(id)) return null;
  if (id.indexOf('dip-') === 0) return { cat: 'dips', veggie: false, name: id };
  if (id.indexOf('fritz') === 0) return { cat: 'drinks', veggie: false, name: id };
  if (/^(nug|pommes|spommes)/.test(id)) return { cat: 'sides', veggie: false, name: id };
  return { cat: 'burger', veggie: /-veg$/.test(id), name: id };
}
const ALLE_DIPS = DIP_IDS.length ? DIP_IDS : ['dip-mayo', 'dip-ket', 'dip-mango', 'dip-sweetsour'];

/* Smashburger laut Karte (siehe Kopf). */
const SMASH_IDS = ['kubis'];

/* ------------------------------------------------------------------------
   Zeit in Berlin
   ------------------------------------------------------------------------ */
const FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
});
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function berlinTeile(datum) {
  const d = datum instanceof Date ? datum : new Date(datum || Date.now());
  if (!isFinite(d.getTime())) return null;
  const p = {};
  for (const x of FMT.formatToParts(d)) p[x.type] = x.value;
  const year = Number(p.year), month = Number(p.month), day = Number(p.day);
  const hour = Number(p.hour) % 24, minute = Number(p.minute);
  return {
    year, month, day, hour, minute,
    weekday: WD[p.weekday] !== undefined ? WD[p.weekday] : new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    ymd: p.year + '-' + p.month + '-' + p.day,
    iso: d.toISOString(),
  };
}

/* Tagesnummer seit 1970 fuer ein YYYY-MM-DD (Kalenderrechnung ohne Zeitzone). */
function tagNr(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  return Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}

const r2 = (x) => Math.round(x * 100) / 100;
const zahl = (x) => (typeof x === 'number' && isFinite(x) ? x : Number(x) || 0);

/* ------------------------------------------------------------------------
   Jahres-Block normalisieren (schuetzt vor kaputten oder alten Daten)
   ------------------------------------------------------------------------ */
function zaehlMap(x, max) {
  const out = {};
  if (!x || typeof x !== 'object' || Array.isArray(x)) return out;
  let n = 0;
  for (const k of Object.keys(x)) {
    if (n >= max) break;
    const v = Math.floor(zahl(x[k]));
    if (v > 0) { out[k] = v; n++; }
  }
  return out;
}

function leererJahrBlock() {
  return {
    orders: 0, total: 0, items: {},
    cats: { burger: 0, sides: 0, dips: 0, drinks: 0, veggie: 0, double: 0 },
    hours: {}, weekdays: {}, months: {}, lunch: 0, late: 0,
    days: [], firstAt: null, lastAt: null,
  };
}

function normJahr(s) {
  const n = leererJahrBlock();
  if (!s || typeof s !== 'object') return n;
  n.orders = Math.max(0, Math.floor(zahl(s.orders)));
  n.total = r2(Math.max(0, zahl(s.total)));
  n.items = zaehlMap(s.items, MAX_ITEMS);
  const c = s.cats || {};
  for (const k of Object.keys(n.cats)) n.cats[k] = Math.max(0, Math.floor(zahl(c[k])));
  n.hours = zaehlMap(s.hours, 24);
  n.weekdays = zaehlMap(s.weekdays, 7);
  n.months = zaehlMap(s.months, 12);
  n.lunch = Math.max(0, Math.floor(zahl(s.lunch)));
  n.late = Math.max(0, Math.floor(zahl(s.late)));
  n.days = Array.isArray(s.days)
    ? s.days.filter((d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, MAX_DAYS)
    : [];
  n.firstAt = typeof s.firstAt === 'string' ? s.firstAt : null;
  n.lastAt = typeof s.lastAt === 'string' ? s.lastAt : null;
  return n;
}

function plus(map, key, n, max) {
  if (!n) return;
  if (map[key] === undefined && Object.keys(map).length >= max) return;
  map[key] = (map[key] || 0) + n;
}

/* ------------------------------------------------------------------------
   Eine Bestellung in die Statistik schreiben
   ------------------------------------------------------------------------ */

/**
 * Zaehlt eine abgeschlossene Bestellung in cust.stats[Jahr] und haelt neu
 * erreichte Abzeichen in cust.badgesAt fest. Veraendert cust direkt.
 *
 * @param {object} cust   Kundendatensatz
 * @param {object} order  Bestellung (cartSnapshot, total)
 * @param {Date|string} [date]  Abschlusszeitpunkt, Standard: jetzt
 * @returns {string[]} Schluessel der Abzeichen, die mit dieser Bestellung neu
 *                     erreicht wurden (leer, wenn keins)
 */
function addOrderToStats(cust, order, date) {
  if (!cust || typeof cust !== 'object' || !order || typeof order !== 'object') return [];
  const t = berlinTeile(date || new Date());
  if (!t) return [];

  if (!cust.stats || typeof cust.stats !== 'object' || Array.isArray(cust.stats)) cust.stats = {};
  const jahr = String(t.year);
  const s = normJahr(cust.stats[jahr]);

  s.orders += 1;
  s.total = r2(s.total + Math.max(0, zahl(order.total)));

  // --- Artikel aus dem Warenkorb-Schnappschuss ----------------------------
  const korb = order.cartSnapshot;
  if (korb && typeof korb === 'object') {
    const zaehle = (id, menge) => {
      const info = artikelInfo(String(id || ''));
      if (!info) return null;
      plus(s.items, String(id), menge, MAX_ITEMS);
      if (s.cats[info.cat] !== undefined) s.cats[info.cat] += menge;
      return info;
    };
    for (const k of Object.keys(korb).slice(0, 80)) {
      const e = korb[k];
      if (!e || typeof e !== 'object') continue;
      let menge = Math.floor(zahl(e.qty));
      if (!(menge > 0)) continue;
      menge = Math.min(menge, 99);
      const id = String(e.menuId || '');
      const info = zaehle(id, menge);
      if (!info) continue;
      if (info.cat === 'burger') {
        if (info.veggie) s.cats.veggie += menge;
        if (e.double || DOUBLE_IMMER.indexOf(id) !== -1) s.cats.double += menge;
      }
      if (e.isMenu) {
        const side = artikelInfo(String(e.side || ''));
        if (side && side.cat === 'sides') zaehle(e.side, menge);
        const drink = artikelInfo(String(e.drink || ''));
        if (drink && drink.cat === 'drinks') zaehle(e.drink, menge);
      }
      if (e.dip) {
        const dip = artikelInfo(String(e.dip));
        if (dip && dip.cat === 'dips') zaehle(e.dip, menge);
      }
    }
  }

  // --- Zeitmuster -----------------------------------------------------------
  plus(s.hours, String(t.hour), 1, 24);
  plus(s.weekdays, String(t.weekday), 1, 7);
  plus(s.months, String(t.month), 1, 12);
  const minuten = t.hour * 60 + t.minute;
  if (minuten >= 11 * 60 + 30 && minuten < 14 * 60) s.lunch += 1;
  if (minuten >= 19 * 60 + 30) s.late += 1;

  if (s.days.indexOf(t.ymd) === -1 && s.days.length < MAX_DAYS) {
    s.days.push(t.ymd);
    s.days.sort();
  }
  if (!s.firstAt || t.iso < s.firstAt) s.firstAt = t.iso;
  if (!s.lastAt || t.iso > s.lastAt) s.lastAt = t.iso;

  cust.stats[jahr] = s;

  // Zu viele Jahre: die aeltesten fallen raus (Abzeichen bleiben in badgesAt)
  const jahre = Object.keys(cust.stats).filter((y) => /^\d{4}$/.test(y)).sort();
  for (const y of Object.keys(cust.stats)) if (!/^\d{4}$/.test(y)) delete cust.stats[y];
  while (jahre.length > MAX_YEARS) delete cust.stats[jahre.shift()];

  // --- Neu erreichte Abzeichen festhalten -----------------------------------
  const neu = [];
  try {
    if (!cust.badgesAt || typeof cust.badgesAt !== 'object' || Array.isArray(cust.badgesAt)) cust.badgesAt = {};
    for (const b of badges(cust.stats, t.year, cust.badgesAt)) {
      const key = b.key;
      if (b.earned && !cust.badgesAt[key] && Object.keys(cust.badgesAt).length < MAX_BADGES_AT) {
        cust.badgesAt[key] = t.iso;
        neu.push(key);
      }
    }
  } catch (e) {}
  return neu;
}

/* ------------------------------------------------------------------------
   Summen ueber alle Jahre
   ------------------------------------------------------------------------ */
function gesamt(stats) {
  const g = { orders: 0, items: {}, cats: { burger: 0, sides: 0, dips: 0, drinks: 0, veggie: 0, double: 0 } };
  if (!stats || typeof stats !== 'object') return g;
  for (const y of Object.keys(stats)) {
    if (!/^\d{4}$/.test(y)) continue;
    const s = normJahr(stats[y]);
    g.orders += s.orders;
    for (const k of Object.keys(s.items)) g.items[k] = (g.items[k] || 0) + s.items[k];
    for (const k of Object.keys(g.cats)) g.cats[k] += s.cats[k];
  }
  return g;
}

/* Freitagsritual: bester Monat des Jahres nach Anteil der besuchten Freitage. */
function freitagsMonate(s, jahr) {
  const proMonat = {};
  for (const d of s.days) {
    if (d.slice(0, 4) !== String(jahr)) continue;
    const nr = tagNr(d);
    if (nr === null) continue;
    if (new Date(nr * 86400000).getUTCDay() !== 5) continue;
    const m = d.slice(5, 7);
    proMonat[m] = (proMonat[m] || 0) + 1;
  }
  let best = { have: 0, need: 4, month: null };
  for (const m of Object.keys(proMonat)) {
    const mm = Number(m);
    let freitage = 0;
    const tage = new Date(Date.UTC(jahr, mm, 0)).getUTCDate();
    for (let tag = 1; tag <= tage; tag++) {
      if (new Date(Date.UTC(jahr, mm - 1, tag)).getUTCDay() === 5) freitage++;
    }
    const have = Math.min(proMonat[m], freitage);
    const besser = (have / freitage) > (best.have / best.need)
      || ((have / freitage) === (best.have / best.need) && have > best.have);
    if (besser) best = { have, need: freitage, month: mm };
  }
  return best;
}

/* ------------------------------------------------------------------------
   Abzeichen
   ------------------------------------------------------------------------ */
const DEFS = [
  { id: 'erster-burger', scope: 'all', icon: '🍔', need: 1,
    title_de: 'Erster Burger', desc_de: 'Deine erste Bestellung bei uns.',
    have: (g) => g.orders },
  { id: 'stammgast', scope: 'all', icon: '🤝', need: 5,
    title_de: 'Stammgast', desc_de: '5 Bestellungen.',
    have: (g) => g.orders },
  { id: 'grill-profi', scope: 'all', icon: '🔥', need: 25,
    title_de: 'Grill-Profi', desc_de: '25 Bestellungen.',
    have: (g) => g.orders },
  { id: 'smash-10', scope: 'all', icon: '💥', need: 10,
    title_de: '10 Smashburger', desc_de: '10 Kubis Special, unser Smashburger mit Double Patty.',
    have: (g) => SMASH_IDS.reduce((n, id) => n + (g.items[id] || 0), 0) },
  { id: 'veggie-fan', scope: 'all', icon: '🌱', need: 5,
    title_de: 'Veggie-Fan', desc_de: '5 Veggie-Burger.',
    have: (g) => g.cats.veggie },
  { id: 'dip-sammler', scope: 'all', icon: '🥣', need: ALLE_DIPS.length,
    title_de: 'Dip-Sammler', desc_de: 'Jeden Dip mindestens einmal probiert.',
    have: (g) => ALLE_DIPS.filter((id) => (g.items[id] || 0) > 0).length },
  { id: 'freitagsritual', scope: 'year', icon: '📅', need: 4,
    title_de: 'Freitagsritual', desc_de: 'An jedem Freitag eines Monats bestellt.',
    have: null /* eigene Rechnung, siehe unten */ },
  { id: 'mittagspause', scope: 'year', icon: '🕛', need: 10,
    title_de: 'Mittagspause', desc_de: '10 Bestellungen zwischen 11:30 und 14:00 Uhr.',
    have: (g, s) => s.lunch },
  { id: 'spaetschicht', scope: 'year', icon: '🌙', need: 5,
    title_de: 'Spätschicht', desc_de: '5 Bestellungen nach 19:30 Uhr.',
    have: (g, s) => s.late },
  { id: 'double-trouble', scope: 'all', icon: '🥩', need: 5,
    title_de: 'Double-Trouble', desc_de: '5 Burger mit Double Patty.',
    have: (g) => g.cats.double },
];

/**
 * Alle Abzeichen mit Fortschritt.
 *
 * @param {object} stats     cust.stats
 * @param {number} year      Jahr fuer die "je Jahr"-Abzeichen
 * @param {object} [badgesAt] cust.badgesAt (Zeitpunkte bereits erreichter Abzeichen)
 * @returns {Array<{id, key, scope, icon, title_de, desc_de, need, have, earned, earnedAt?}>}
 */
function badges(stats, year, badgesAt) {
  const jahr = Number(year) || berlinTeile(new Date()).year;
  const g = gesamt(stats);
  const s = normJahr(stats && stats[String(jahr)]);
  const at = (badgesAt && typeof badgesAt === 'object') ? badgesAt : {};
  return DEFS.map((d) => {
    const key = d.scope === 'year' ? d.id + ':' + jahr : d.id;
    let need = d.need;
    let have;
    let extra = null;
    if (d.id === 'freitagsritual') {
      const f = freitagsMonate(s, jahr);
      need = f.need; have = f.have;
      if (f.month) extra = { month: f.month };
    } else {
      have = Math.max(0, Math.floor(d.have(g, s) || 0));
    }
    const gespeichert = Object.prototype.hasOwnProperty.call(at, key) && typeof at[key] === 'string' ? at[key] : null;
    const earned = have >= need || !!gespeichert;
    const out = {
      id: d.id, key, scope: d.scope, icon: d.icon,
      title_de: d.title_de, desc_de: d.desc_de,
      need, have: earned ? Math.max(have, need) : Math.min(have, need), earned,
    };
    if (d.scope === 'year') out.year = jahr;
    if (extra) out.month = extra.month;
    if (gespeichert) out.earnedAt = gespeichert;
    return out;
  });
}

/* ------------------------------------------------------------------------
   Jahresrueckblick
   ------------------------------------------------------------------------ */
function argMax(map, erlaubt) {
  let best = null, bestN = 0;
  for (const k of Object.keys(map || {})) {
    if (erlaubt && !erlaubt(k)) continue;
    const n = map[k] || 0;
    if (n > bestN) { best = k; bestN = n; }
  }
  return best === null ? null : { key: best, n: bestN };
}

function laengsteWochenSerie(days) {
  const wochen = [];
  for (const d of days) {
    const nr = tagNr(d);
    if (nr === null) continue;
    // 1970-01-01 war ein Donnerstag: +3 laesst die Woche am Montag beginnen
    const w = Math.floor((nr + 3) / 7);
    if (wochen[wochen.length - 1] !== w) wochen.push(w);
  }
  const uniq = Array.from(new Set(wochen)).sort((a, b) => a - b);
  let best = 0, lauf = 0, vorher = null;
  for (const w of uniq) {
    lauf = (vorher !== null && w === vorher + 1) ? lauf + 1 : 1;
    if (lauf > best) best = lauf;
    vorher = w;
  }
  return best;
}

/**
 * @returns {{ year, orders, total, burgers, items, cats, favorite: {id, qty, name}|null,
 *   topCategory, daypart: 'mittag'|'nachmittag'|'abend'|null, topWeekday, topMonth,
 *   firstAt, lastAt, distinctDays, longestWeekStreak, lunch, late }}
 */
function jahresRueckblick(stats, year) {
  const jahr = Number(year) || berlinTeile(new Date()).year;
  const s = normJahr(stats && stats[String(jahr)]);

  // Favorit: echte Produkte, Dips nur, wenn sonst nichts da ist
  let fav = argMax(s.items, (id) => {
    const info = artikelInfo(id);
    return !!info && info.cat !== 'dips';
  }) || argMax(s.items);
  const favorite = fav ? {
    id: fav.key, qty: fav.n,
    name: (ARTIKEL[fav.key] && ARTIKEL[fav.key].name) || fav.key,
  } : null;

  const kat = argMax({ burger: s.cats.burger, sides: s.cats.sides, drinks: s.cats.drinks, dips: s.cats.dips });

  let mittag = 0, nachmittag = 0, abend = 0;
  for (const h of Object.keys(s.hours)) {
    const n = s.hours[h] || 0, hh = Number(h);
    if (hh < 14) mittag += n;
    else if (hh < 18) nachmittag += n;
    else abend += n;
  }
  let daypart = null;
  if (mittag + nachmittag + abend > 0) {
    daypart = 'mittag';
    if (nachmittag > mittag) daypart = 'nachmittag';
    if (abend > Math.max(mittag, nachmittag)) daypart = 'abend';
  }

  const wd = argMax(s.weekdays);
  const mo = argMax(s.months);

  return {
    year: jahr,
    orders: s.orders,
    total: s.total,
    burgers: s.cats.burger,
    items: Object.keys(s.items).reduce((n, k) => n + s.items[k], 0),
    cats: s.cats,
    favorite,
    topCategory: kat ? kat.key : null,
    daypart,
    topWeekday: wd ? Number(wd.key) : null,
    topMonth: mo ? Number(mo.key) : null,
    firstAt: s.firstAt,
    lastAt: s.lastAt,
    distinctDays: s.days.length,
    longestWeekStreak: laengsteWochenSerie(s.days),
    lunch: s.lunch,
    late: s.late,
  };
}

module.exports = {
  addOrderToStats, badges, jahresRueckblick, berlinTeile, normJahr,
  SMASH_IDS, ALLE_DIPS, DEFS,
};
