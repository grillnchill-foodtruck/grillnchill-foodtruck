/**
 * lib/firmen.js
 * ----------------------------------------------------------------------------
 * Firmen-Mittag: Firmen im Liefergebiet bestellen auf Monatsrechnung.
 *
 * Hier steht alles, was Bestellung, Gruppenbestellung, Antragsseite und
 * Admin gemeinsam brauchen: Firmencode, Prüfung beim Bestellen,
 * Monatsnutzung für das Limit und der Aufbau der Sammelrechnung.
 *
 * Blob-Store "firmen" (Besitzer: Paket firmen)
 *   antrag:<id>                       Antrag von der Seite /firmen
 *   firma:<id>                        Firmenkonto
 *   code:<FIRMA-XXXXXX>               { id }  Verweis vom Code auf die Firma
 *   nutzung:<id>:<JJJJ-MM>            { summe, eintraege: { <ref>: { total, at, name } } }
 *   bestellung:<id>:<JJJJ-MM>:<ref>   alles, was die Sammelrechnung braucht
 *   rechnung:<id>:<JJJJ-MM>           { invoiceNo, status, ... }
 *
 * Die Bestellung selbst liegt wie jede andere im Store "orders" (o:<ref>)
 * und trägt dort firma: <id>. Die Kopie unter bestellung: hält die Daten für
 * die Rechnung fest, auch wenn das Bestell-Archiv nach 90 Tagen aufräumt,
 * und hängt nicht an der Bestellnummer aus dem Browser: Wer seine Nummer
 * verfälscht, fällt deshalb nicht aus der Monatsrechnung.
 *
 * Steuer: Die Aufteilung je Bestellung (vat) entsteht wie bei jeder
 * Firmenrechnung im Browser mit buildVatSummary. Hier wird sie nur auf
 * Stimmigkeit geprüft und für die Sammelrechnung je Satz addiert. An der
 * Steuer-Logik selbst ändert diese Datei nichts.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { berlinDatum, berlinWochentag, berlinZeitpunkt } = require('./standing');

function store(name) {
  const opts = { name: name || 'firmen', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
const clean = (x, n) => String(x == null ? '' : x).replace(/[<>\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const refSauber = (x) => String(x || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 60);

/* ---------------------------------------------------------------------------
   Einstellungen
--------------------------------------------------------------------------- */
const STANDARD = {
  zahlungsziel: 14,     // Tage
  limit: 500,           // Euro je Kalendermonat, 0 = ohne Limit
};
/* Firmen-Mittag als Gruppe: bis 11:00 sammeln, um 12:00 liefern.
   Freitag fehlt bewusst: freitags liefert der Truck erst ab 14:30
   (HOURS.deliveryFrom in index.html). Sonntag ist Ruhetag. */
const FIRMEN_MITTAG = { schluss: '11:00', lieferung: '12:00', tage: [1, 2, 3, 4, 6] };

/* ---------------------------------------------------------------------------
   Firmencode: FIRMA- plus 6 Zeichen ohne 0/O/1/I (gut vorzulesen).
   32^6 = rund eine Milliarde Möglichkeiten. Zusammen mit der Bremse auf
   dem Prüf-Endpunkt reicht das gegen Durchprobieren.
--------------------------------------------------------------------------- */
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function neuerCode() {
  const b = crypto.randomBytes(6);
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHA[b[i] % ALPHA.length];
  return 'FIRMA-' + s;
}
function codeNormalisieren(x) {
  let s = String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('FIRMA') && s.length === 11) s = s.slice(5);
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(s)) return '';
  return 'FIRMA-' + s;
}

/* ---------------------------------------------------------------------------
   E-Mail-Domains der Mitarbeitenden
--------------------------------------------------------------------------- */
function domainsLesen(x) {
  const roh = Array.isArray(x) ? x : String(x || '').split(/[\s,;]+/);
  const aus = [];
  for (const d0 of roh) {
    const d = String(d0 || '').toLowerCase().trim()
      .replace(/^https?:\/\//, '').replace(/^.*@/, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && d.length <= 80 && !aus.includes(d)) aus.push(d);
    if (aus.length >= 5) break;
  }
  return aus;
}
function emailDomain(email) {
  const m = /@([^@\s]+)$/.exec(String(email || '').trim().toLowerCase());
  return m ? m[1] : '';
}
/* Ohne hinterlegte Domain darf jede Adresse auf die Firma bestellen.
   Mit Domain: genau diese oder eine Unterdomain (team.firma.de). */
function domainPasst(firma, email) {
  const erlaubt = (firma && Array.isArray(firma.domains)) ? firma.domains : [];
  if (!erlaubt.length) return true;
  const d = emailDomain(email);
  if (!d) return false;
  return erlaubt.some((e) => d === e || d.endsWith('.' + e));
}

/* ---------------------------------------------------------------------------
   Zeit (Europe/Berlin)
--------------------------------------------------------------------------- */
function monatVon(ms) { return berlinDatum(new Date(ms || Date.now())).slice(0, 7); }
function vormonat(monat) {
  const [j, m] = monat.split('-').map(Number);
  return m === 1 ? `${j - 1}-12` : `${j}-${String(m - 1).padStart(2, '0')}`;
}
const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
function monatName(monat) {
  const [j, m] = String(monat).split('-').map(Number);
  return (MONATE[m - 1] || '') + ' ' + j;
}
function deDatum(iso) { const [j, m, t] = String(iso).slice(0, 10).split('-'); return `${t}.${m}.${j}`; }
function monatsGrenzen(monat) {
  const [j, m] = monat.split('-').map(Number);
  const letzter = new Date(Date.UTC(j, m, 0)).getUTCDate();
  return { erster: `01.${String(m).padStart(2, '0')}.${j}`, letzter: `${String(letzter).padStart(2, '0')}.${String(m).padStart(2, '0')}.${j}` };
}
function plusTage(isoDatum, n) {
  return new Date(Date.parse(isoDatum + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}

/* Nächster Firmen-Mittag ab jetzt: heute, wenn es vor 11:00 ist und heute
   ein Liefertag ist, sonst der nächste passende Tag. */
function mittagTermin(jetzt) {
  const nun = jetzt ? new Date(jetzt) : new Date();
  const heute = berlinDatum(nun);
  for (let i = 0; i < 9; i++) {
    const datum = plusTage(heute, i);
    const wt = berlinWochentag(new Date(datum + 'T12:00:00Z'));
    if (!FIRMEN_MITTAG.tage.includes(wt)) continue;
    const schluss = berlinZeitpunkt(datum, FIRMEN_MITTAG.schluss);
    if (schluss <= nun) continue;
    return {
      datum, wochentag: wt,
      schluss: schluss.toISOString(),
      lieferung: berlinZeitpunkt(datum, FIRMEN_MITTAG.lieferung).toISOString(),
      schlussZeit: FIRMEN_MITTAG.schluss, lieferZeit: FIRMEN_MITTAG.lieferung,
    };
  }
  return null;
}

/* ---------------------------------------------------------------------------
   Lesen
--------------------------------------------------------------------------- */
async function firmaLesen(id) {
  const sid = String(id || '').replace(/[^a-z0-9]/g, '').slice(0, 24);
  if (!sid) return null;
  return store().get('firma:' + sid, { type: 'json' });
}
async function firmaPerCode(code) {
  const c = codeNormalisieren(code);
  if (!c) return null;
  const s = store();
  const v = await s.get('code:' + c, { type: 'json' });
  if (!v || !v.id) return null;
  const f = await s.get('firma:' + v.id, { type: 'json' });
  // Der Verweis kann veraltet sein (Code neu vergeben): nur der aktuelle Code zählt
  return f && f.code === c ? f : null;
}
async function nutzungLesen(firmaId, monat) {
  const n = await store().get('nutzung:' + firmaId + ':' + monat, { type: 'json' });
  return n && typeof n === 'object' ? { summe: r2(n.summe), eintraege: n.eintraege || {} } : { summe: 0, eintraege: {} };
}

/* Was die Kasse und die Gruppe von einer Firma sehen dürfen */
function oeffentlich(f) {
  return { name: f.name, lieferadresse: f.lieferadresse || null };
}

/* ---------------------------------------------------------------------------
   Prüfung: darf diese Bestellung auf die Firma?
   grund: 'code' | 'inaktiv' | 'domain' | 'limit'
--------------------------------------------------------------------------- */
async function pruefen({ code, email, betrag, ref }) {
  const f = await firmaPerCode(code);
  if (!f) return { ok: false, grund: 'code' };
  if (!f.aktiv) return { ok: false, grund: 'inaktiv' };
  if (!domainPasst(f, email)) return { ok: false, grund: 'domain' };
  const limit = r2(f.limit);
  const n = await nutzungLesen(f.id, monatVon(Date.now()));
  const rest = limit > 0 ? r2(Math.max(0, limit - n.summe)) : null;
  const schonGezaehlt = !!(ref && n.eintraege[refSauber(ref)]);
  if (limit > 0 && !schonGezaehlt && r2(n.summe + (Number(betrag) || 0)) > limit + 0.001) {
    return { ok: false, grund: 'limit', rest, firma: f };
  }
  return { ok: true, firma: f, rest, summe: n.summe };
}

/* Steueraufstellung aus dem Browser: in sich stimmig und passend zum
   nachgerechneten Gesamtbetrag? Ein Browser, der Rabatte angibt, die der
   Server gestrichen hat, fällt hier auf. */
function vatStimmig(order) {
  const v = order && order.vat;
  if (!Array.isArray(v) || !v.length || v.length > 2) return false;
  const saetze = new Set();
  let brutto = 0;
  for (const z of v) {
    const satz = Number(z && z.satz);
    if (![7, 19].includes(satz) || saetze.has(satz)) return false;
    saetze.add(satz);
    const b = Number(z.brutto), n = Number(z.netto), s = Number(z.steuer);
    if (![b, n, s].every((x) => isFinite(x) && x >= 0)) return false;
    if (Math.abs(r2(n + s) - b) > 0.011) return false;
    if (Math.abs(r2(b / (1 + satz / 100)) - n) > 0.011) return false;
    brutto += b;
  }
  return Math.abs(r2(brutto) - r2(order.total)) <= 0.02;
}

/* Vor der Preisprüfung: Auf Firmenrechnung gibt es in v1 keine Gutscheine,
   keine Aktionscodes, keine Stempelkarte und kein Trinkgeld. Alles, was der
   Browser davon schickt, fliegt raus, BEVOR lib/preisberechnung.js rechnet.
   Eine Einzelrechnung je Bestellung gibt es auch nicht (company leer), die
   Firma bekommt die Sammelrechnung. Sonst stünde derselbe Umsatz zweimal
   auf Rechnungen (§ 14c UStG). */
function fuerBestellungVorbereiten(order) {
  if (!order || typeof order !== 'object') return;
  if (order.payment !== 'firma') {
    // firma setzt nur der Server nach bestandener Prüfung
    delete order.firma; delete order.firmaName; delete order.firmaCode;
    return;
  }
  order.voucherCode = null;
  order.promo = null;
  order.discount = 0;
  order.loyaltyApplied = false;
  order.loyaltyDiscount = 0;
  order.loyaltyType = null;
  order.loyaltyProgress = null;
  delete order.kontoToken;
  order.tip = 0;
  order.company = null;
  order.invoiceAddress = null;
  order.isTest = false;
  order.testCode = null;
  delete order.firma; delete order.firmaName;
}

/* Nach der Preisprüfung: Code, Firma, Domain, Limit, Steuerdaten.
   Setzt bei Erfolg firma und firmaName und legt die Lieferadresse auf die
   der Firma. Rückgabe { ok, grund }. */
async function bestellungFreigeben(order) {
  const code = order.firmaCode;
  delete order.firmaCode;
  const ref = String(order.reference || '');
  const m = /^GNC-(\d{12,14})$/.exec(ref);
  if (!m || Math.abs(Date.now() - Number(m[1])) > 2 * 86400000) return { ok: false, grund: 'pruefung' };
  if (!vatStimmig(order)) return { ok: false, grund: 'pruefung' };
  const p = await pruefen({ code, email: order.email, betrag: order.total, ref });
  if (!p.ok) return p;
  const f = p.firma;
  order.firma = f.id;
  order.firmaName = f.name;
  if (order.mode === 'delivery' && f.lieferadresse && f.lieferadresse.street) {
    order.deliveryAddress = {
      ...(order.deliveryAddress || {}),
      street: f.lieferadresse.street, zip: f.lieferadresse.zip, city: f.lieferadresse.city,
    };
  }
  return { ok: true, firma: f };
}

/* Nach erfolgreicher Bestellung (Archiv geschrieben, Mails raus): für Limit
   und Sammelrechnung vermerken. Je Bestellung genau einmal. */
async function bestellungVermerken(order, opt) {
  if (!order || !order.firma || !order.reference) return false;
  const s = store();
  // opt.at: Zeitpunkt aus dem Archiv, wenn der Abgleich im Admin nachträgt
  const at = (opt && opt.at) ? new Date(opt.at).toISOString() : new Date().toISOString();
  const monat = monatVon(Date.parse(at));
  const ref = refSauber(order.reference);
  const nk = 'nutzung:' + order.firma + ':' + monat;
  const n = (await s.get(nk, { type: 'json' })) || { summe: 0, eintraege: {} };
  n.eintraege = n.eintraege || {};
  if (n.eintraege[ref]) return false;
  n.eintraege[ref] = { total: r2(order.total), at, name: clean(order.name, 60) };
  n.summe = r2(Object.values(n.eintraege).reduce((a, e) => a + (Number(e.total) || 0), 0));
  await s.setJSON(nk, n);
  await s.setJSON('bestellung:' + order.firma + ':' + monat + ':' + ref, {
    ref, at,
    name: clean(order.name, 60),
    email: clean(order.email, 120),
    mode: order.mode === 'delivery' ? 'delivery' : 'pickup',
    scheduledFor: clean(order.scheduledFor, 60) || null,
    deliveryAddress: order.deliveryAddress ? {
      street: clean(order.deliveryAddress.street, 80), zip: clean(order.deliveryAddress.zip, 10), city: clean(order.deliveryAddress.city, 40),
    } : null,
    items: (order.items || []).slice(0, 60).map((i) => ({
      name: clean(i && i.name, 160), qty: Number(i && i.qty) || 1,
      price: r2(i && i.price), total: r2(i && i.total),
      vatSplit: (i && i.vatSplit && typeof i.vatSplit === 'object') ? { 7: r2(i.vatSplit[7]), 19: r2(i.vatSplit[19]) } : null,
    })),
    vat: (order.vat || []).map((v) => ({ satz: Number(v.satz), brutto: r2(v.brutto), netto: r2(v.netto), steuer: r2(v.steuer) })),
    subtotal: r2(order.subtotal),
    deliveryFee: r2(order.deliveryFee),
    total: r2(order.total),
  });
  return true;
}

/* Alle Firmenbestellungen eines Monats, mit Stand aus dem Bestell-Archiv.
   Storniert oder erstattet zählt nicht. Fehlt der Archiv-Eintrag (nach 90
   Tagen aufgeräumt), gilt die Bestellung als geliefert. */
async function monatsBestellungen(firmaId, monat) {
  const s = store();
  const { blobs } = await s.list({ prefix: 'bestellung:' + firmaId + ':' + monat + ':' });
  const liste = [];
  for (const b of blobs) {
    try { const e = await s.get(b.key, { type: 'json' }); if (e && e.ref) liste.push(e); } catch (e) {}
  }
  const os = store('orders');
  for (const e of liste) {
    let status = 'archiviert';
    try { const rec = await os.get('o:' + refSauber(e.ref), { type: 'json' }); if (rec && rec.status) status = rec.status; } catch (x) {}
    e.status = status;
    e.zaehlt = !['refunded', 'cancelled', 'abandoned'].includes(status);
  }
  liste.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return liste;
}

/* ---------------------------------------------------------------------------
   Sammelrechnung
   Eine Position je Artikel, davor Tag und Name ("03.11. Lena K.: …"). Die
   Steuer je Satz ist die Summe der Steueraufstellungen der einzelnen
   Bestellungen, so wie sie bei der Bestellung gerechnet wurden.
--------------------------------------------------------------------------- */
function kurzName(name) {
  const t = clean(name, 60).split(' ').filter(Boolean);
  if (!t.length) return 'Gast';
  return t.length > 1 ? `${t[0]} ${t[t.length - 1].charAt(0)}.` : t[0];
}
function tagKurz(iso) {
  const d = berlinDatum(new Date(iso));
  return d.slice(8, 10) + '.' + d.slice(5, 7) + '.';
}

function sammelrechnungBauen(firma, monat, eintraege, meta) {
  const zaehlen = (eintraege || []).filter((e) => e.zaehlt !== false);
  const items = [];
  const vatSum = {};
  let subtotal = 0, gebuehr = 0, total = 0;
  for (const e of zaehlen) {
    const vor = tagKurz(e.at) + ' ' + kurzName(e.name) + ': ';
    for (const i of e.items || []) {
      items.push({ name: vor + i.name, qty: i.qty, price: i.price, total: i.total, vatSplit: i.vatSplit || undefined });
    }
    subtotal += Number(e.subtotal) || 0;
    gebuehr += Number(e.deliveryFee) || 0;
    total += Number(e.total) || 0;
    for (const v of e.vat || []) {
      const k = Number(v.satz);
      vatSum[k] = vatSum[k] || { satz: k, brutto: 0, netto: 0, steuer: 0 };
      vatSum[k].brutto += Number(v.brutto) || 0;
      vatSum[k].netto += Number(v.netto) || 0;
      vatSum[k].steuer += Number(v.steuer) || 0;
    }
  }
  const vat = Object.values(vatSum).sort((a, b) => a.satz - b.satz)
    .map((v) => ({ satz: v.satz, brutto: r2(v.brutto), netto: r2(v.netto), steuer: r2(v.steuer) }));
  const g = monatsGrenzen(monat);
  const ziel = Number(firma.zahlungsziel) > 0 ? Math.min(90, Math.round(firma.zahlungsziel)) : STANDARD.zahlungsziel;
  const heuteIso = meta.heuteIso || berlinDatum(new Date());
  return {
    invoiceNo: meta.invoiceNo,
    invoiceDate: deDatum(heuteIso),
    serviceDate: g.letzter,
    leistungszeitraum: g.erster + ' bis ' + g.letzter,
    leistungsmonat: monatName(monat),
    reference: 'Firmen-Mittag ' + monatName(monat),
    company: firma.rechnungsname || firma.name,
    invoiceAddress: firma.rechnungsadresse || firma.lieferadresse || null,
    ustIdKunde: firma.ustId || null,
    items,
    vat,
    subtotal: r2(subtotal),
    discount: 0,
    loyaltyDiscount: 0,
    deliveryFee: r2(gebuehr),
    tip: 0,
    total: r2(total),
    payment: 'firma',
    mode: 'sammel',
    zahlungsziel: ziel,
    faelligAm: deDatum(plusTage(heuteIso, ziel)),
    sammel: { firmaId: firma.id, monat, anzahl: zaehlen.length, refs: zaehlen.map((e) => e.ref) },
    createdAt: new Date().toISOString(),
  };
}

module.exports = {
  store, r2, clean, refSauber,
  STANDARD, FIRMEN_MITTAG,
  neuerCode, codeNormalisieren,
  domainsLesen, emailDomain, domainPasst,
  monatVon, vormonat, monatName, monatsGrenzen, deDatum, plusTage, mittagTermin,
  firmaLesen, firmaPerCode, nutzungLesen, oeffentlich,
  pruefen, vatStimmig, fuerBestellungVorbereiten, bestellungFreigeben, bestellungVermerken,
  monatsBestellungen, sammelrechnungBauen, kurzName,
};
