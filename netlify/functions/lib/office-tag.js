'use strict';
/**
 * lib/office-tag.js
 * Baut aus den Daten des Shops die Meldungen fürs GNC Office (Plan 2). Reine Funktionen ohne Speicherzugriff:
 * lib/office-sammeln.js liest, office-meldungen.js schickt. Format: gnc-office functions/_lib/verbuchen.js.
 *
 * Ist-Versteuerung: Ein Umsatz zählt am Tag, an dem das Geld kommt.
 *  - SumUp online: Tag der Bestätigung (completedAt)
 *  - bar bei Abholung: Abholtag, nur zur Ansicht (vor_ort); das Geld erfasst die Kasse am Truck
 *  - Erstattungen: Tag, an dem Kubi sie im Admin markiert (Ereignis aus orders-action.js)
 *  - Geschenkgutscheine: Verkauf am Zahltag, Einlösung am Tag der Bestellung oder am Truck
 * Tagesmeldungen enthalten keine Kundennamen und keine Gutscheincodes.
 */
const { aufteilung } = require('./office-steuer');

const ZAHLWEG = { online: 'sumup', sumup: 'sumup', bar: 'bar', ueberweisung: 'ueberweisung' };
const RECHNUNGSART = { catering_anzahlung: 'anzahlung', catering_schluss: 'schlussrechnung', catering_storno: 'storno' };

const cent = (euro) => Math.round(Number(euro || 0) * 100);
const berlinTag = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date(d));

function tagAus(x) {
  const s = String(x || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !isNaN(Date.parse(s))) return berlinTag(s);
  return null;
}

const istOnline = (rec) => rec.quelle == null || rec.quelle === 'online';

// Eingelöster Geschenkgutschein in Cent. Aktionscodes wie GRILL5 sind echte Rabatte und zählen nicht.
function geschenkCent(order, geschenkCodes) {
  const code = String(order.voucherCode || '').trim().toUpperCase();
  if (!code || !geschenkCodes.has(code)) return 0;
  return Math.min(Math.max(0, cent(order.discount) - cent(order.dealDiscount)), cent(order.subtotal));
}

function rechnungsMeldung(inv) {
  const art = inv.mode === 'sammel' ? 'sammelrechnung' : RECHNUNGSART[inv.art];
  if (!art || !inv.invoiceNo) return null;
  const datum = tagAus(inv.invoiceDay) || (inv.createdAt ? berlinTag(inv.createdAt) : tagAus(inv.invoiceDate));
  const posten = (inv.vat || []).map((v) => ({ satz: Number(v.satz), brutto_cent: cent(v.brutto) }))
    .filter((p) => p.brutto_cent !== 0).sort((a, b) => a.satz - b.satz);
  if (!posten.length || !datum) return null;
  const daten = { nummer: inv.invoiceNo, art, datum, kunde: String(inv.company || inv.kundeName || inv.name || '').trim().slice(0, 120), posten };
  const faellig = tagAus(inv.faelligAm);
  if (faellig) daten.faellig = faellig;
  if (art === 'storno') daten.bezug = inv.stornoZu;
  if (art === 'anzahlung' && inv.bezahltAm) daten.zahlung = { datum: berlinTag(inv.bezahltAm), zahlart: ZAHLWEG[inv.zahlungsweg] || 'bar' };
  return { schluessel: 'rechnung:' + inv.invoiceNo, art: 'rechnung', daten };
}

function baueMeldungen({ von, bis, bestellungen = [], erstattungen = [], geschenkCodes = new Set(), truck = [], rechnungen = [], firmenZahlungen = [] }) {
  const tage = new Map();
  const hinweise = [];
  const im = (tag) => !!tag && tag >= von && tag <= bis;
  const add = (tag, typ, zahlart, satz, c) => {
    if (!im(tag) || !(c > 0)) return;
    const t = tage.get(tag) || new Map();
    const k = `${typ}|${zahlart || ''}|${satz || 0}`;
    const p = t.get(k) || { typ, ...(zahlart ? { zahlart } : {}), ...(satz ? { satz } : {}), brutto_cent: 0 };
    p.brutto_cent += c;
    t.set(k, p);
    tage.set(tag, t);
  };

  for (const rec of bestellungen) {
    if (!rec || !['completed', 'refunded'].includes(rec.status) || !istOnline(rec) || !rec.completedAt) continue;
    if (rec.kind === 'giftcard') {
      if (rec.gift) add(berlinTag(rec.completedAt), 'gutschein_verkauf', 'sumup', null, cent(rec.gift.amount));
      continue;
    }
    if (rec.kind === 'burgerpass') {
      if (im(berlinTag(rec.completedAt))) hinweise.push({ tag: berlinTag(rec.completedAt), text: 'Ein Burger-Pass-Verkauf ist nicht im Office gebucht.' });
      continue;
    }
    if (rec.kind) continue;
    const o = rec.order || {};
    if (o.isTest || !['sumup', 'cash'].includes(o.payment)) continue;
    const tag = o.payment === 'cash' ? (tagAus(o.abholTag) || tagAus(rec.abholTag) || berlinTag(rec.completedAt)) : berlinTag(rec.completedAt);
    if (!im(tag)) continue;
    const a = aufteilung(o, { gutscheinCent: geschenkCent(o, geschenkCodes) });
    for (const satz of [7, 19]) {
      if (o.payment === 'sumup') add(tag, 'umsatz', 'sumup', satz, a.bezahlt[satz]);
      else add(tag, 'vor_ort', null, satz, a.bezahlt[satz]);
      add(tag, 'gutschein_einloesung', null, satz, a.gutschein[satz]);
    }
    if (a.quelle === 'geschaetzt') hinweise.push({ tag, text: `Bestellung ${o.reference || ''} ohne Warenkorb, ganz mit 19 % gemeldet.` });
    if (Math.abs(a.rest) > 2) hinweise.push({ tag, text: `Bestellung ${o.reference || ''}: Steueraufteilung weicht um ${a.rest} Cent vom Betrag ab.` });
  }

  for (const { tag, rec } of erstattungen) {
    if (!rec || !istOnline(rec)) continue;
    if (rec.kind === 'giftcard') {
      if (rec.gift) add(tag, 'gutschein_erstattung', 'sumup', null, cent(rec.gift.amount));
      continue;
    }
    if (rec.kind) continue;
    const o = rec.order || {};
    if (o.isTest || !['sumup', 'cash'].includes(o.payment)) continue;
    const a = aufteilung(o, { gutscheinCent: geschenkCent(o, geschenkCodes) });
    for (const satz of [7, 19]) {
      if (o.payment === 'sumup') add(tag, 'erstattung', 'sumup', satz, a.bezahlt[satz]);
      else add(tag, 'vor_ort_erstattung', null, satz, a.bezahlt[satz]);
    }
  }

  // Am Truck: Das Team kassiert nur die Differenz. Liegt der Bestellwert unter dem Gutschein, verfällt der Rest (AGB § 8).
  for (const t of truck) {
    add(t.tag, 'gutschein_truck', null, null, Math.min(t.wert_cent, t.bestellwert_cent));
    add(t.tag, 'gutschein_verfall', null, null, t.wert_cent - t.bestellwert_cent);
  }

  const meldungen = [];
  for (const inv of [...rechnungen].sort((a, b) => (String(a.invoiceNo) < String(b.invoiceNo) ? -1 : 1))) {
    const m = rechnungsMeldung(inv);
    if (m && im(m.daten.datum)) meldungen.push(m);
  }
  for (const z of [...firmenZahlungen].sort((a, b) => (a.nummer < b.nummer ? -1 : 1))) {
    if (im(z.tag) && z.betrag_cent > 0) {
      meldungen.push({ schluessel: 'zahlung:' + z.nummer, art: 'zahlung', daten: { nummer: z.nummer, datum: z.tag, zahlart: 'ueberweisung', betrag_cent: z.betrag_cent } });
    }
  }
  for (const tag of [...tage.keys()].sort()) {
    const posten = [...tage.get(tag).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, p]) => p);
    meldungen.push({ schluessel: `tag:${tag}:online`, art: 'tag', daten: { datum: tag, posten } });
  }
  return { meldungen, hinweise };
}

module.exports = { baueMeldungen, rechnungsMeldung, tagAus, berlinTag };
