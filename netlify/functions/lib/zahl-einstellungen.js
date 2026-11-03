/**
 * lib/zahl-einstellungen.js
 * ----------------------------------------------------------------------------
 * Drei Admin-Schalter rund ums Bezahlen, alle ab Werk AUS:
 *
 *   direktZahlung   „Bezahlen ohne Umweg“: Die Kasse zeigt das SumUp-Widget
 *                   direkt in Schritt 3, statt zur SumUp-Seite zu wechseln.
 *   applePayApp     Apple Pay in der iOS-App (ab Build 8): eigenes Apple-Pay-
 *                   Blatt, Token geht über den Server an SumUp. Ältere Builds
 *                   und das Web sehen davon nichts.
 *   pass            Burger-Pass (Menü-Paket ohne automatische Verlängerung):
 *                   aktiv, Name, Preis, Anzahl Menüs, Gültigkeit in Tagen.
 *
 * Gespeichert im Store 'shop-status' unter dem eigenen Schlüssel 'zahlung'.
 * Bewusst NICHT im Tagesstatus ('status'): der setzt sich um Mitternacht
 * zurück, und jedes Speichern im Reiter „Heute“ überschreibt ihn komplett.
 *
 * Fehlt der Eintrag oder ist der Speicher gestört, gelten die Werkswerte:
 * beide Schalter aus. Im Zweifel also der bewährte Weg (Weiterleitung) und
 * kein Pass-Verkauf.
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');

const SCHLUESSEL = 'zahlung';

const WERKSWERTE = Object.freeze({
  direktZahlung: false,
  applePayApp: false,
  pass: Object.freeze({ aktiv: false, name: 'Burger-Pass', preis: 39, menus: 4, tage: 60 }),
});

// Grenzen für die Eingaben im Admin-Tool
const GRENZEN = Object.freeze({
  preis: [5, 200],     // €
  menus: [1, 20],
  tage: [7, 365],
});

function store() {
  const opts = { name: 'shop-status', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

const zwischen = (x, [min, max]) => Math.min(max, Math.max(min, x));

/* Bringt jede Eingabe (gespeichert oder aus dem Admin-Tool) in die gültige
   Form. Unlesbares fällt auf den Werkswert zurück. */
function bereinigen(roh) {
  const r = (roh && typeof roh === 'object') ? roh : {};
  const p = (r.pass && typeof r.pass === 'object') ? r.pass : {};
  const zahl = (v, w) => { const n = Number(v); return Number.isFinite(n) ? n : w; };
  const name = String(p.name == null ? WERKSWERTE.pass.name : p.name)
    .replace(/[\u0000-\u001F\u007F<>]/g, '').trim().slice(0, 40) || WERKSWERTE.pass.name;
  return {
    direktZahlung: r.direktZahlung === true,
    applePayApp: r.applePayApp === true,
    pass: {
      aktiv: p.aktiv === true,
      name,
      preis: Math.round(zwischen(zahl(p.preis, WERKSWERTE.pass.preis), GRENZEN.preis) * 100) / 100,
      menus: Math.round(zwischen(zahl(p.menus, WERKSWERTE.pass.menus), GRENZEN.menus)),
      tage: Math.round(zwischen(zahl(p.tage, WERKSWERTE.pass.tage), GRENZEN.tage)),
    },
  };
}

async function lesen() {
  try {
    const d = await store().get(SCHLUESSEL, { type: 'json' });
    return { ...bereinigen(d), updatedAt: (d && d.updatedAt) || null, updatedBy: (d && d.updatedBy) || null };
  } catch (e) {
    console.error('zahl-einstellungen lesen:', e && e.message);
    return { ...bereinigen(null), updatedAt: null, updatedBy: null };
  }
}

async function schreiben(roh, wer) {
  const neu = { ...bereinigen(roh), updatedAt: new Date().toISOString(), updatedBy: String(wer || '?').slice(0, 40) };
  await store().setJSON(SCHLUESSEL, neu);
  return neu;
}

/* Was jeder Besucher über GET /shop-status sieht. Ein nicht freigeschalteter
   Pass bleibt unsichtbar (auch Name und Preis eines Entwurfs). */
function oeffentlich(e) {
  const x = e || bereinigen(null);
  return {
    direkt: !!x.direktZahlung,
    applePay: !!x.applePayApp,
    pass: x.pass && x.pass.aktiv
      ? { name: x.pass.name, preis: x.pass.preis, menus: x.pass.menus, tage: x.pass.tage }
      : null,
  };
}

module.exports = { lesen, schreiben, bereinigen, oeffentlich, WERKSWERTE, GRENZEN, SCHLUESSEL };
