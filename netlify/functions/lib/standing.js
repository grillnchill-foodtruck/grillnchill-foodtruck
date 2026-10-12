/**
 * lib/standing.js
 * ----------------------------------------------------------------------------
 * Termin-Berechnung für Dauerbestellungen – eine Stelle für alle drei
 * Funktionen (anlegen, erinnern, aussetzen). Vorher stand dieselbe Logik
 * doppelt in standing-orders.js und standing-skip.js.
 *
 * Zeitzone: Der Kunde wählt eine BERLINER Wanduhrzeit ("Donnerstag 12:30").
 * Der Server läuft in UTC. Die frühere Fassung baute das Datum aus einem
 * nach Berlin umgerechneten String und setzte darauf setHours() – damit
 * landete 12:30 als 12:30 UTC, also 14:30 Berliner Zeit. Bei Mittagszeiten
 * fiel das nicht auf, weil nur das DATUM verglichen wird; bei einer Zeit ab
 * 22:00 wäre der Termin aber auf den Folgetag gerutscht.
 * Hier wird der Versatz zur jeweiligen Jahreszeit ermittelt und abgezogen.
 * ----------------------------------------------------------------------------
 */

/* Datum in Berlin als JJJJ-MM-TT. */
function berlinDatum(d) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(d || new Date());
}

/* Wochentag (0 = Sonntag) in Berlin. */
function berlinWochentag(d) {
  const kurz = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', weekday: 'short' })
    .format(d || new Date());
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(kurz);
}

/* Versatz Berlin↔UTC in Minuten zum gegebenen Zeitpunkt (60 oder 120). */
function berlinVersatzMin(d) {
  const alsBerlin = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const alsUtc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((alsBerlin - alsUtc) / 60000);
}

/* Berliner Wanduhrzeit an einem Datum → echter Zeitpunkt (ISO/UTC). */
function berlinZeitpunkt(datumIso, zeit) {
  const [hh, mm] = String(zeit || '12:30').split(':').map(Number);
  // Erst so tun, als wäre die Wanduhrzeit UTC …
  const roh = new Date(`${datumIso}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`);
  // … dann den Versatz abziehen, der zu diesem Zeitpunkt in Berlin gilt.
  return new Date(roh.getTime() - berlinVersatzMin(roh) * 60000);
}

/**
 * Nächster Termin nach jetzt (oder nach `nach`, falls gesetzt).
 * @param {number} weekday 0 = Sonntag
 * @param {string} zeit    "12:30"
 * @param {string} [nach]  ISO – Termine bis einschließlich hier werden übersprungen
 * @returns {string|null}  ISO
 */
function naechsterTermin(weekday, zeit, nach) {
  const jetzt = new Date();
  const grenze = nach ? new Date(nach) : jetzt;
  const start = new Date(berlinDatum(jetzt) + 'T00:00:00Z');

  for (let i = 0; i < 21; i++) {
    const tag = new Date(start.getTime() + i * 86400000);
    const datumIso = tag.toISOString().slice(0, 10);
    // Wochentag des Kalendertags bestimmen (12:00 UTC liegt sicher im Tag)
    const wt = berlinWochentag(new Date(datumIso + 'T12:00:00Z'));
    if (wt !== weekday) continue;

    const zeitpunkt = berlinZeitpunkt(datumIso, zeit);
    if (zeitpunkt <= jetzt) continue;      // schon vorbei
    if (zeitpunkt <= grenze) continue;     // ausgesetzt
    return zeitpunkt.toISOString();
  }
  return null;
}

/* ============================================================================
 * Zeitfenster ("Mittagspause mit festem Zeitfenster")
 * ----------------------------------------------------------------------------
 * Eine Dauerbestellung belegt ein festes 15-Minuten-Fenster (HH:00/15/30/45)
 * innerhalb der Oeffnungszeiten ihres Wochentags. Das letzte Fenster liegt
 * 30 Minuten vor Schluss. Je Wochentag und Fenster gibt es nur eine begrenzte
 * Zahl aktiver (nicht pausierter) Dauerbestellungen, damit der Grill zur
 * Mittagszeit planbar bleibt.
 *
 * Nichts wird still gerundet: eine Zeit ausserhalb des Rasters ist ungueltig
 * (Fehler 'bad_slot'). Nur beim ZAEHLEN werden Altbestaende mit krummer Zeit
 * (etwa 12:20 aus der Zeit vor dem Raster) dem Fenster zugeordnet, in dem sie
 * liegen (12:15) - gespeichert wird dabei nichts.
 * ============================================================================ */

/* Muss zu HOURS in index.html passen (0 = Sonntag, geschlossen).
   deliveryFrom: Freitags wird erst ab 14:30 geliefert, Abholung ab Oeffnung. */
const OEFFNUNG = {
  0: null,
  1: { open: '12:00', close: '20:30' },
  2: { open: '12:00', close: '20:30' },
  3: { open: '12:00', close: '20:30' },
  4: { open: '12:00', close: '20:30' },
  5: { open: '12:00', close: '20:30', deliveryFrom: '14:30' },
  6: { open: '12:00', close: '20:30' },
};
const SLOT_MIN = 15;
const LETZTER_VOR_SCHLUSS_MIN = 30;
const KAPAZITAET_STANDARD = 6;
const KAPAZITAET_MAX = 50;

const ZEIT_FORM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/* "12:15" -> 735; alles andere -> null */
function minuten(zeit) {
  const m = ZEIT_FORM.exec(String(zeit || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
const zeitAus = (min) => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');

/* Wochentag als Ganzzahl 0..6, sonst null (kein stilles Zurechtbiegen). */
function wochentagAus(x) {
  const n = typeof x === 'number' ? x : (/^\d$/.test(String(x)) ? Number(x) : NaN);
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : null;
}

/**
 * Alle gueltigen Fenster eines Wochentags.
 * @param {number} weekday 0 = Sonntag
 * @param {string} [mode]  'delivery' beachtet deliveryFrom (Freitag ab 14:30)
 * @returns {string[]} ["12:00", "12:15", ...] - leer, wenn geschlossen
 */
function slotsFuer(weekday, mode) {
  const h = OEFFNUNG[weekday];
  if (!h) return [];
  let von = minuten(h.open);
  if (mode === 'delivery' && h.deliveryFrom) von = Math.max(von, minuten(h.deliveryFrom));
  const bis = minuten(h.close) - LETZTER_VOR_SCHLUSS_MIN;
  // Auf das Raster heben, falls eine Oeffnungszeit einmal krumm ist
  von = Math.ceil(von / SLOT_MIN) * SLOT_MIN;
  const out = [];
  for (let m = von; m <= bis; m += SLOT_MIN) out.push(zeitAus(m));
  return out;
}

function istSlot(weekday, zeit, mode) {
  return slotsFuer(weekday, mode).includes(String(zeit));
}

/* Fenster, in dem eine (evtl. krumme) Zeit liegt - nur zum Zaehlen. */
function slotVon(zeit) {
  const m = minuten(zeit);
  return m == null ? null : zeitAus(Math.floor(m / SLOT_MIN) * SLOT_MIN);
}

function kapazitaetAus(settings) {
  const n = settings && Number(settings.slotCapacity);
  return Number.isInteger(n) && n >= 0 && n <= KAPAZITAET_MAX ? n : KAPAZITAET_STANDARD;
}

/**
 * Belegung je Fenster an einem Wochentag. Gezaehlt werden nur aktive
 * (nicht pausierte) Reihen. Ein ausgesetzter einzelner Termin gibt den Platz
 * NICHT frei - die Reihe haelt ihn weiter.
 * @param {object[]} reihen    alle Dauerbestellungen
 * @param {number}   weekday
 * @param {string}   [ohneId]  eigene Reihe beim Verschieben/Fortsetzen nicht mitzaehlen
 * @returns {Object<string, number>} { "12:15": 3, ... }
 */
function belegung(reihen, weekday, ohneId) {
  const out = {};
  for (const r of reihen || []) {
    if (!r || r.paused) continue;
    if (Number(r.weekday) !== weekday) continue;
    if (ohneId && r.id === ohneId) continue;
    const s = slotVon(r.time);
    if (s) out[s] = (out[s] || 0) + 1;
  }
  return out;
}

/** Fensterliste mit Belegung: [{ time, taken, free }] */
function slotUebersicht(reihen, weekday, kapazitaet, mode, ohneId) {
  const belegt = belegung(reihen, weekday, ohneId);
  return slotsFuer(weekday, mode).map((time) => {
    const taken = belegt[time] || 0;
    return { time, taken, free: Math.max(0, kapazitaet - taken) };
  });
}

/**
 * Bis zu n freie Fenster, die der gewuenschten Zeit am naechsten liegen
 * (gleicher Wochentag). Bei gleichem Abstand gewinnt das fruehere.
 * Rueckgabe chronologisch sortiert, damit die Vorschlaege lesbar sind.
 */
function naechsteFreie(reihen, weekday, zeit, kapazitaet, mode, ohneId, n) {
  const ziel = minuten(zeit);
  const frei = slotUebersicht(reihen, weekday, kapazitaet, mode, ohneId)
    .filter((s) => s.free > 0 && s.time !== zeit);
  const abstand = (s) => (ziel == null ? 0 : Math.abs(minuten(s.time) - ziel));
  return frei
    .sort((a, b) => (abstand(a) - abstand(b)) || (minuten(a.time) - minuten(b.time)))
    .slice(0, n || 4)
    .map((s) => s.time)
    .sort((a, b) => minuten(a) - minuten(b));
}

/**
 * Prueft ein gewuenschtes Fenster: Raster + Kapazitaet.
 * @returns {{ok:true}|{ok:false,error:'bad_slot'}|{ok:false,error:'slot_full',free:string[]}}
 */
function pruefeSlot(reihen, weekday, zeit, kapazitaet, mode, ohneId) {
  if (wochentagAus(weekday) == null || !istSlot(weekday, zeit, mode)) return { ok: false, error: 'bad_slot' };
  const belegt = belegung(reihen, weekday, ohneId)[zeit] || 0;
  if (belegt >= kapazitaet) {
    return { ok: false, error: 'slot_full', free: naechsteFreie(reihen, weekday, zeit, kapazitaet, mode, ohneId, 4) };
  }
  return { ok: true };
}

/* ============================================================================
 * Tagesplan fuer das Team
 * ----------------------------------------------------------------------------
 * PATTY-REGEL (aus der Artikelform der Dauerbestellung abgeleitet):
 * Gespeichert ist je Zeile { menuId, name, qty, double, isMenu, side, drink,
 * dip } - so baut index.html (itemsAusKorb) die Zeilen aus dem Warenkorb.
 *   - Burger ist, wessen menuId in speisekarte.js die Kategorie 'burger' hat
 *     (Fleisch, Veggie/Vegan und Crispy Chicken - alles, was auf den Grill
 *     bzw. in die Burgerstrasse geht).
 *   - Je Burger 1 Patty; 2 Patties, wenn double === true ODER die Sorte von
 *     Haus aus doppelt ist (DOUBLE_PATTY_EXCLUDE_IDS, heute 'kubis').
 *   - Ein Menue (isMenu) zaehlt wie sein Burger; Beilage, Getraenk und Dip
 *     erscheinen als eigene Zeilen in der Artikelliste, zaehlen aber keine
 *     Patties.
 *   - Unbekannte menuId (Artikel inzwischen von der Karte genommen): zaehlt
 *     als Burger, wenn der gespeicherte Name "burger" enthaelt.
 *   - Alles mal qty.
 * ============================================================================ */

function planZeile(item, SK) {
  const MENU = (SK && SK.MENU) || [];
  const DOPPELT = (SK && SK.DOUBLE_PATTY_EXCLUDE_IDS) || ['kubis'];
  const qty = Math.max(0, Math.min(99, parseInt(item && item.qty, 10) || 0));
  if (!qty) return null;
  const id = String((item && item.menuId) || '');
  const karte = MENU.find((m) => m.id === id) || null;
  const roherName = String((item && item.name) || '').replace(/[<>]/g, '').trim().slice(0, 80);
  const name = (karte && karte.name) || roherName || id || '?';
  const istBurger = karte ? karte.cat === 'burger' : /burger/i.test(roherName);
  const vonHausDoppelt = DOPPELT.includes(id);
  const doppelt = istBurger && (vonHausDoppelt || item.double === true);
  const patties = istBurger ? qty * (doppelt ? 2 : 1) : 0;
  const zeilen = [{ name: name + (istBurger && item.double === true && !vonHausDoppelt ? ' (Double)' : ''), qty }];
  if (item.isMenu) {
    const seite = ((SK && SK.MENU_SIDE_OPTIONS) || []).find((s) => s.id === item.side);
    const nameVon = (mid) => { const m = MENU.find((x) => x.id === mid); return m ? m.name : null; };
    const beilage = seite ? seite.label : nameVon(item.side);
    if (beilage) zeilen.push({ name: beilage, qty });
    const getraenk = nameVon(item.drink);
    if (getraenk) zeilen.push({ name: getraenk, qty });
    const dip = nameVon(item.dip);
    if (dip) zeilen.push({ name: dip, qty });
  } else if (item.dip) {
    const dip = MENU.find((x) => x.id === item.dip);
    if (dip) zeilen.push({ name: dip.name, qty });
  }
  return { patties, zeilen };
}

/* Wird die Reihe an diesem Datum ausgesetzt? skipUntil ist laut
   naechsterTermin() "Termine bis einschliesslich hier werden uebersprungen";
   verglichen wird das Berliner Datum, damit eine spaetere Uhrzeitaenderung
   am selben Tag die Aussetzung nicht aushebelt. */
function ausgesetztAm(rec, datumIso) {
  if (!rec || !rec.skipUntil) return false;
  const bis = new Date(rec.skipUntil);
  if (isNaN(bis)) return false;
  return datumIso <= berlinDatum(bis);
}

/**
 * Tagesplan: aktive Reihen des Wochentags, die an diesem Datum nicht
 * ausgesetzt sind, gruppiert nach Fenster.
 * @param {object[]} reihen
 * @param {string}   datumIso  JJJJ-MM-TT (Berliner Kalendertag)
 * @param {object}   SK        speisekarte.js (MENU, DOUBLE_PATTY_EXCLUDE_IDS, MENU_SIDE_OPTIONS)
 */
function tagesplan(reihen, datumIso, SK) {
  const weekday = berlinWochentag(new Date(datumIso + 'T12:00:00Z'));
  const fenster = {};
  for (const r of reihen || []) {
    if (!r || r.paused) continue;
    if (Number(r.weekday) !== weekday) continue;
    if (ausgesetztAm(r, datumIso)) continue;
    const s = slotVon(r.time);
    if (!s) continue;
    const f = fenster[s] || (fenster[s] = { time: s, orders: 0, patties: 0, _items: {} });
    f.orders++;
    for (const it of Array.isArray(r.items) ? r.items : []) {
      const z = planZeile(it, SK);
      if (!z) continue;
      f.patties += z.patties;
      for (const { name, qty } of z.zeilen) f._items[name] = (f._items[name] || 0) + qty;
    }
  }
  const slots = Object.values(fenster)
    .sort((a, b) => minuten(a.time) - minuten(b.time))
    .map((f) => ({
      time: f.time,
      orders: f.orders,
      patties: f.patties,
      items: Object.entries(f._items)
        .map(([name, qty]) => ({ name, qty }))
        .sort((a, b) => (b.qty - a.qty) || a.name.localeCompare(b.name, 'de')),
    }));
  return {
    weekday,
    slots,
    totalOrders: slots.reduce((n, s) => n + s.orders, 0),
    totalPatties: slots.reduce((n, s) => n + s.patties, 0),
  };
}

module.exports = {
  naechsterTermin, berlinDatum, berlinWochentag, berlinZeitpunkt,
  OEFFNUNG, SLOT_MIN, KAPAZITAET_STANDARD, KAPAZITAET_MAX,
  minuten, wochentagAus, slotsFuer, istSlot, slotVon, kapazitaetAus,
  belegung, slotUebersicht, naechsteFreie, pruefeSlot,
  tagesplan, ausgesetztAm,
};
