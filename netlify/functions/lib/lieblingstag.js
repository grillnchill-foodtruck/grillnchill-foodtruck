/**
 * lib/lieblingstag.js
 * ----------------------------------------------------------------------------
 * „Push zum Lieblingstag“: Wer meistens am selben Wochentag zur selben Zeit
 * bestellt, bekommt an diesem Tag kurz vorher eine Erinnerung. Nur wer sie im
 * Konto selbst einschaltet (Einwilligung), höchstens einmal pro Woche.
 *
 * Datengrundlage sind ausschließlich die letzten fünf Bestellungen im
 * Kundendatensatz (rec.orders, schreibt send-email). Es entsteht kein eigenes
 * Nutzungsprofil.
 *
 *   rec.lieblingstag = {
 *     an: true, lang: 'de', seit: ISO,
 *     web: [ { endpoint, keys: { p256dh, auth } } ],   // Browser-Abos, max. 3
 *     thema: 'lt_<hex>',                              // FCM-Thema der iOS-App
 *     zuletzt: ISO                                    // letzte Erinnerung
 *   }
 *
 * Verzeichnis der Eingeschalteten: Store "lieblingstag", Schlüssel = Kunden-
 * schlüssel (c:<sha>), damit der Zeitplan nicht alle Kunden lesen muss.
 * ----------------------------------------------------------------------------
 */

const { berlinDatum, berlinWochentag, OEFFNUNG } = require('./standing');

const TAG = 86400000;
const BLICK_TAGE = 70;          // nur Bestellungen der letzten 10 Wochen zählen
const MIN_TREFFER = 2;          // mindestens zwei Bestellungen am selben Wochentag
const VORLAUF_MIN = 40;         // so lange vor der üblichen Bestellzeit erinnern
const FRUEHESTENS_MIN = 9 * 60; // nie vor 9 Uhr
const ABSTAND_TAGE = 6;         // höchstens einmal pro Woche
const SLOT_MIN = 15;            // Zeitplan läuft alle 15 Minuten

/* Minuten seit Mitternacht in Berlin. */
function berlinMinute(d) {
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(d).split(':').map(Number);
  return (t[0] % 24) * 60 + t[1];
}

const zeitText = (min) => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
const minuten = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

/* Gesetzliche Feiertage in NRW, wie getNRWHoliday() in index.html. */
function ostersonntag(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const monat = Math.floor((h + l - 7 * m + 114) / 31);
  const tag = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(y, monat - 1, tag);
}
function istFeiertag(ymd) {
  const [y, mo, d] = ymd.split('-').map(Number);
  if (['1-1', '5-1', '10-3', '11-1', '12-25', '12-26'].includes(mo + '-' + d)) return true;
  const ostern = ostersonntag(y);
  const heute = Date.UTC(y, mo - 1, d);
  return [-2, 1, 39, 50, 60].some((off) => ostern + off * TAG === heute);
}

/**
 * Lieblingstag aus den letzten Bestellungen.
 * @returns {null | { wd: 0-6, minute: übliche Bestellzeit, erinnerung: Minute, treffer }}
 */
function erkennen(orders, jetzt) {
  const jetztMs = (jetzt || new Date()).getTime();
  const liste = (Array.isArray(orders) ? orders : [])
    .map((o) => ({ t: Date.parse(o && o.at) }))
    .filter((o) => Number.isFinite(o.t) && jetztMs - o.t <= BLICK_TAGE * TAG && o.t <= jetztMs)
    .map((o) => { const d = new Date(o.t); return { t: o.t, wd: berlinWochentag(d), min: berlinMinute(d) }; });
  const jeTag = {};
  for (const o of liste) (jeTag[o.wd] = jeTag[o.wd] || []).push(o);
  let beste = null;
  for (const wd of Object.keys(jeTag)) {
    const g = jeTag[wd];
    if (g.length < MIN_TREFFER || !OEFFNUNG[wd]) continue;
    const neueste = Math.max(...g.map((x) => x.t));
    if (!beste || g.length > beste.g.length || (g.length === beste.g.length && neueste > beste.neueste)) {
      beste = { wd: Number(wd), g, neueste };
    }
  }
  if (!beste) return null;
  const sortiert = beste.g.map((x) => x.min).sort((a, b) => a - b);
  const h = sortiert.length >> 1;   // Median, bei gerader Anzahl Mittel der beiden mittleren
  const mitte = sortiert.length % 2 ? sortiert[h] : (sortiert[h - 1] + sortiert[h]) / 2;
  const minute = Math.round(mitte / 5) * 5;
  const schluss = minuten(OEFFNUNG[beste.wd].close);
  let erinnerung = Math.floor((minute - VORLAUF_MIN) / SLOT_MIN) * SLOT_MIN;
  erinnerung = Math.max(FRUEHESTENS_MIN, Math.min(erinnerung, schluss - 60));
  return { wd: beste.wd, minute, erinnerung, treffer: beste.g.length };
}

/* Ist der Shop heute pausiert oder sind beide Bestellarten aus? (shop-status) */
function shopZu(status, heute) {
  if (!status || status.dayKey !== heute) return false;   // Pause gilt nur am Setz-Tag
  return !!(status.paused || (status.deliveryOff && status.pickupOff));
}

/**
 * Ist jetzt eine Erinnerung fällig?
 * @returns {{ ja: boolean, grund: string, fav?: object }}
 */
function faellig(rec, jetzt, status) {
  jetzt = jetzt || new Date();
  const lt = rec && rec.lieblingstag;
  if (!lt || !lt.an) return { ja: false, grund: 'aus' };
  if (!(Array.isArray(lt.web) && lt.web.length) && !lt.thema) return { ja: false, grund: 'kein_geraet' };
  const fav = erkennen(rec.orders, jetzt);
  if (!fav) return { ja: false, grund: 'kein_lieblingstag' };
  const heute = berlinDatum(jetzt);
  if (berlinWochentag(jetzt) !== fav.wd) return { ja: false, grund: 'anderer_tag', fav };
  if (!OEFFNUNG[fav.wd] || istFeiertag(heute)) return { ja: false, grund: 'geschlossen', fav };
  const min = berlinMinute(jetzt);
  if (min < fav.erinnerung || min >= fav.erinnerung + SLOT_MIN) return { ja: false, grund: 'nicht_jetzt', fav };
  if (lt.zuletzt && jetzt.getTime() - Date.parse(lt.zuletzt) < ABSTAND_TAGE * TAG) return { ja: false, grund: 'diese_woche', fav };
  const letzte = Array.isArray(rec.orders) && rec.orders[0] && Date.parse(rec.orders[0].at);
  if (letzte && berlinDatum(new Date(letzte)) === heute) return { ja: false, grund: 'schon_bestellt', fav };
  if (shopZu(status, heute)) return { ja: false, grund: 'pausiert', fav };
  return { ja: true, grund: 'faellig', fav };
}

/* Wochentag in der Sprache des Gasts, z. B. „Freitag“. */
const LOCALE = { de: 'de-DE', en: 'en-GB', tr: 'tr-TR', it: 'it-IT', es: 'es-ES', pt: 'pt-PT', fr: 'fr-FR', nl: 'nl-NL' };
function wochentagName(wd, lang) {
  // 2026-11-01 war ein Sonntag: + wd Tage ergibt den gesuchten Wochentag
  const d = new Date(Date.UTC(2026, 10, 1 + wd, 12));
  return new Intl.DateTimeFormat(LOCALE[lang] || 'de-DE', { weekday: 'long', timeZone: 'UTC' }).format(d);
}

const TEXTE = {
  de: ['Heute ist dein Burger-Tag', '{tag}s bestellst du meist gegen {uhr}. Ein Tipp, und deine letzte Bestellung liegt wieder im Warenkorb.'],
  en: ['Today is your burger day', 'On {tag}s you usually order around {uhr}. One tap and your last order is back in the cart.'],
  tr: ['Bugün senin burger günün', '{tag} günleri genelde {uhr} civarı sipariş veriyorsun. Tek dokunuşla son siparişin tekrar sepette.'],
  it: ['Oggi è il tuo giorno del burger', 'Di {tag} di solito ordini verso le {uhr}. Un tocco e il tuo ultimo ordine torna nel carrello.'],
  es: ['Hoy es tu día de burger', 'Los {tag} sueles pedir hacia las {uhr}. Con un toque, tu último pedido vuelve al carrito.'],
  pt: ['Hoje é o teu dia de burger', 'À {tag} costumas encomendar por volta das {uhr}. Com um toque, a tua última encomenda volta ao carrinho.'],
  fr: ['Aujourd’hui, c’est ton jour burger', 'Le {tag}, tu commandes souvent vers {uhr}. Un geste, et ta dernière commande revient dans le panier.'],
  nl: ['Vandaag is je burgerdag', 'Op {tag} bestel je meestal rond {uhr}. Eén tik en je laatste bestelling ligt weer in je winkelmand.'],
};
function nachricht(lang, fav) {
  const l = TEXTE[lang] ? lang : 'de';
  let tag = wochentagName(fav.wd, l);
  if (l === 'de') tag = tag.charAt(0).toUpperCase() + tag.slice(1);   // „Freitags“
  if (l === 'en') tag = tag.charAt(0).toUpperCase() + tag.slice(1);   // „Fridays“
  return {
    title: TEXTE[l][0],
    body: TEXTE[l][1].replace('{tag}', tag).replace('{uhr}', zeitText(fav.minute)),
    url: '/?reorder=1',
  };
}

/* Für die Anzeige im Konto. */
function fuerKonto(rec, jetzt) {
  const fav = erkennen(rec && rec.orders, jetzt);
  const lt = (rec && rec.lieblingstag) || {};
  return {
    an: !!lt.an,
    wd: fav ? fav.wd : null,
    uhr: fav ? zeitText(fav.minute) : null,
    erinnerung: fav ? zeitText(fav.erinnerung) : null,
  };
}

module.exports = { erkennen, faellig, nachricht, fuerKonto, istFeiertag, berlinMinute, zeitText, wochentagName, ABSTAND_TAGE };
