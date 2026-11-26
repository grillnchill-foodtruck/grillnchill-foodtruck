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

// Echtes Kalenderdatum JJJJ-MM-TT (kein 2027-13-45, kein 30.02.)
function echterTag(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

// Berliner Kalendertag eines Zeitpunkts, null bei ungültigem Wert (wirft nie)
function berlinTag(d) {
  try {
    const t = new Date(d);
    if (isNaN(t.getTime())) return null;
    return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(t);
  } catch { return null; }
}

// Alle Datumswerte laufen hierüber: ISO-Tag, TT.MM.JJJJ, Zeitstempel (als Text, Zahl oder Date). Sonst null.
function tagAus(x) {
  if (x instanceof Date || typeof x === 'number') return berlinTag(x);
  const s = String(x || '').trim();
  if (echterTag(s)) return s;
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  if (m) return echterTag(`${m[3]}-${m[2]}-${m[1]}`) ? `${m[3]}-${m[2]}-${m[1]}` : null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && echterTag(s.slice(0, 10))) return berlinTag(s);
  return null;
}

const istOnline = (rec) => rec.quelle == null || rec.quelle === 'online';

// Warum eine Bestellung nicht gemeldet werden kann: fehlende Bestelldaten (abgeschnittener Datensatz) oder eine Zahlart,
// die das Office nicht kennt. null heißt: meldbar ('sumup', 'cash') oder bewusst still (Test, 'firma' über die Sammelrechnung).
function zahlartProblem(o) {
  if (!o || typeof o !== 'object') return 'Bestelldaten fehlen';
  if (o.isTest || o.payment === 'firma' || ['sumup', 'cash'].includes(o.payment)) return null;
  return o.payment ? `Zahlart „${String(o.payment).slice(0, 20)}“ unbekannt` : 'ohne Zahlart';
}

// Eingelöster Geschenkgutschein in Cent. Aktionscodes wie GRILL5 sind echte Rabatte und zählen nicht.
function geschenkCent(order, geschenkCodes) {
  const code = String(order.voucherCode || '').trim().toUpperCase();
  if (!code || !geschenkCodes.has(code)) return 0;
  return Math.min(Math.max(0, cent(order.discount) - cent(order.dealDiscount)), cent(order.subtotal));
}


// Ergebnis: { meldung } | { hinweis } | {} (bewusst keine Meldung, z. B. Einzelrechnungen aus send-email.js)
function rechnungPruefen(inv) {
  const art = inv.mode === 'sammel' ? 'sammelrechnung' : RECHNUNGSART[inv.art];
  if (!art || !inv.invoiceNo) return {};
  const nr = inv.invoiceNo;
  const datum = tagAus(inv.invoiceDay) || tagAus(inv.createdAt) || tagAus(inv.invoiceDate);
  if (!datum) return { hinweis: { tag: null, text: `Rechnung ${nr}: Datum unlesbar, nicht gemeldet.` } };
  const kunde = String(inv.company || inv.kundeName || inv.name || inv.email || '').trim().slice(0, 120);
  if (!kunde) return { hinweis: { tag: datum, text: `Rechnung ${nr}: ohne Kundenname oder E-Mail-Adresse, nicht gemeldet.` } };
  // Satzzeilen behalten ihr Vorzeichen. Bei Schluss- und Stornorechnung kann eine Zeile negativ sein
  // (Anzahlung mit anderer Satzmischung), das Office nimmt das an, wenn die Summe das passende Vorzeichen hat.
  const posten = (inv.vat || []).map((v) => ({ satz: Number(v.satz), brutto_cent: cent(v.brutto) }))
    .filter((p) => p.brutto_cent !== 0).sort((a, b) => a.satz - b.satz);
  if (!posten.length) return { hinweis: { tag: datum, text: `Rechnung ${nr}: ohne Posten, nicht gemeldet.` } };
  const summe = posten.reduce((s, p) => s + p.brutto_cent, 0);
  if ((art === 'schlussrechnung' && summe <= 0) || (art === 'storno' && summe >= 0)) {
    const was = art === 'storno' ? 'Stornorechnung' : 'Schlussrechnung';
    return { hinweis: { tag: datum, text: `${was} ${nr} ergibt keinen offenen Betrag (Anzahlung höher als Endstand). Bitte im Office von Hand buchen.` } };
  }
  // Sammelrechnung: Die Satzzeilen sind Summen gerundeter Einzelbestellungen, total die Summe der Bestellbeträge. Den Unterschied
  // in die größere Zeile legen, dann sind Posten, total und die Zahlung (office-sammeln: cent(total)) gleich.
  let hinweis;
  if (art === 'sammelrechnung' && inv.total != null && inv.total !== '' && Number.isFinite(Number(inv.total))) {
    const diff = cent(inv.total) - summe;
    if (diff) {
      const groesste = posten.reduce((g, p) => (p.brutto_cent >= g.brutto_cent ? p : g));
      groesste.brutto_cent += diff;
      if (groesste.brutto_cent <= 0) return { hinweis: { tag: datum, text: `Sammelrechnung ${nr}: Satzzeilen passen nicht zum Rechnungsbetrag, nicht gemeldet.` } };
      if (Math.abs(diff) > 2) hinweis = { tag: datum, text: `Sammelrechnung ${nr}: Satzzeilen weichen um ${Math.abs(diff)} Cent vom Rechnungsbetrag ab, ausgeglichen in der ${groesste.satz}-%-Zeile.` };
    }
  }
  const daten = { nummer: nr, art, datum, kunde, posten };
  const faellig = tagAus(inv.faelligAm);
  if (faellig) daten.faellig = faellig;
  if (art === 'storno') daten.bezug = inv.stornoZu;
  if (art === 'anzahlung' && inv.bezahltAm) {
    const zahltag = tagAus(inv.bezahltAm);
    if (!zahltag) return { hinweis: { tag: datum, text: `Rechnung ${nr}: Zahlungsdatum unlesbar, nicht gemeldet.` } };
    daten.zahlung = { datum: zahltag, zahlart: ZAHLWEG[inv.zahlungsweg] || 'bar' };
  }
  return { meldung: { schluessel: 'rechnung:' + nr, art: 'rechnung', daten }, ...(hinweis ? { hinweis } : {}) };
}

const rechnungsMeldung = (inv) => rechnungPruefen(inv || {}).meldung || null;

function baueMeldungen({ von, bis, bestellungen = [], erstattungen = [], geschenkCodes = new Set(), truck = [], rechnungen = [], firmenZahlungen = [] }) {
  const tage = new Map();
  const hinweise = [];
  const im = (tag) => echterTag(tag) && tag >= von && tag <= bis;
  const hinweis = (tag, text) => hinweise.push({ tag: tag || null, text });
  const add = (tag, typ, zahlart, satz, c) => {
    if (!im(tag) || !(c > 0)) return;
    const t = tage.get(tag) || new Map();
    const k = `${typ}|${zahlart || ''}|${satz || 0}`;
    const p = t.get(k) || { typ, ...(zahlart ? { zahlart } : {}), ...(satz ? { satz } : {}), brutto_cent: 0 };
    p.brutto_cent += c;
    t.set(k, p);
    tage.set(tag, t);
  };
  const nummerVon = (rec) => String((rec && ((rec.order && rec.order.reference) || rec.reference || rec.id)) || '').slice(0, 40);
  // Hatte die Bestellung einen Umsatz? Gleiche Bedingung für Verkauf und Erstattung.
  const zaehlt = (rec) => ['completed', 'refunded'].includes(rec.status) && istOnline(rec) && !!rec.completedAt;

  for (const rec of bestellungen) {
    if (!rec || !zaehlt(rec)) continue;
    const abgeschlossen = tagAus(rec.completedAt);
    if (!abgeschlossen) { hinweis(null, `Bestellung ${nummerVon(rec)}: Datum unlesbar, nicht gemeldet.`); continue; }
    if (rec.kind === 'giftcard') {
      if (rec.gift) add(abgeschlossen, 'gutschein_verkauf', 'sumup', null, cent(rec.gift.amount));
      else if (im(abgeschlossen)) hinweis(abgeschlossen, `Gutschein-Verkauf ${nummerVon(rec)} ohne Gutscheindaten, nicht gemeldet.`);
      continue;
    }
    if (rec.kind === 'burgerpass') {
      if (im(abgeschlossen)) hinweis(abgeschlossen, 'Ein Burger-Pass-Verkauf ist nicht im Office gebucht.');
      continue;
    }
    if (rec.kind) continue;
    const o = rec.order;
    const problem = zahlartProblem(o);
    if (problem && im(abgeschlossen)) hinweis(abgeschlossen, `Bestellung ${nummerVon(rec)}: ${problem}, nicht gemeldet.`);
    if (problem || o.isTest || o.payment === 'firma') continue;
    const tag = o.payment === 'cash' ? (tagAus(o.abholTag) || tagAus(rec.abholTag) || abgeschlossen) : abgeschlossen;
    if (!im(tag)) continue;
    const a = aufteilung(o, { gutscheinCent: geschenkCent(o, geschenkCodes) });
    for (const satz of [7, 19]) {
      if (o.payment === 'sumup') add(tag, 'umsatz', 'sumup', satz, a.bezahlt[satz]);
      else add(tag, 'vor_ort', null, satz, a.bezahlt[satz]);
      add(tag, 'gutschein_einloesung', null, satz, a.gutschein[satz]);
    }
    if (a.quelle === 'geschaetzt') hinweis(tag, `Bestellung ${o.reference || ''} ohne Warenkorb, ganz mit 19 % gemeldet.`);
    if (Math.abs(a.rest) > 2) hinweis(tag, `Bestellung ${o.reference || ''}: Steueraufteilung weicht um ${a.rest} Cent vom Betrag ab.`);
  }

  for (const e of erstattungen) {
    if (!e) continue;
    const rec = e.rec;
    if (rec && !istOnline(rec)) continue;
    const nr = rec ? nummerVon(rec) : String(e.referenz || '').slice(0, 40);
    const tag = tagAus(e.tag);
    if (!tag) { hinweis(null, `Erstattung zu ${nr}: Datum unlesbar, nicht gemeldet.`); continue; }
    if (!im(tag)) continue;
    // Ereignis ohne Bestellung im Speicher (gelöscht oder nie gespeichert)
    if (!rec) { hinweis(tag, `Erstattung zu ${nr}: Bestellung nicht gefunden, nicht gemeldet.`); continue; }
    if (!zaehlt(rec)) { hinweis(tag, `Erstattung zu ${nummerVon(rec)} ohne vorherigen Umsatz, nicht gemeldet.`); continue; }
    if (rec.kind === 'giftcard') {
      if (rec.gift) add(tag, 'gutschein_erstattung', 'sumup', null, cent(rec.gift.amount));
      else hinweis(tag, `Gutschein-Erstattung ${nummerVon(rec)} ohne Gutscheindaten, nicht gemeldet.`);
      continue;
    }
    if (rec.kind === 'burgerpass') { hinweis(tag, 'Eine Burger-Pass-Erstattung ist nicht im Office gebucht.'); continue; }
    if (rec.kind) continue;
    const o = rec.order;
    const problem = zahlartProblem(o);
    if (problem) { hinweis(tag, `Erstattung zu ${nr}: ${problem}, nicht gemeldet.`); continue; }
    if (o.isTest || o.payment === 'firma') continue;
    const a = aufteilung(o, { gutscheinCent: geschenkCent(o, geschenkCodes) });
    for (const satz of [7, 19]) {
      if (o.payment === 'sumup') add(tag, 'erstattung', 'sumup', satz, a.bezahlt[satz]);
      else add(tag, 'vor_ort_erstattung', null, satz, a.bezahlt[satz]);
    }
  }

  // Am Truck: Das Team kassiert nur die Differenz. Liegt der Bestellwert unter dem Gutschein, verfällt der Rest (AGB § 8).
  // Hinweise ohne Tag gehen je Text einmal raus: Die letzten 4 Zeichen des Codes machen jeden Fall eigen, ohne den Code zu verraten.
  for (const t of truck) {
    const tag = tagAus(t && t.tag);
    if (!tag) {
      const endung = String((t && t.kennung) || '').slice(-4);
      hinweis(null, endung ? `Gutschein mit Endung ${endung} am Truck: Datum unlesbar, nicht gemeldet.` : 'Ein Gutschein am Truck hat ein unlesbares Datum und ist nicht gemeldet.');
      continue;
    }
    add(tag, 'gutschein_truck', null, null, Math.min(t.wert_cent, t.bestellwert_cent));
    add(tag, 'gutschein_verfall', null, null, t.wert_cent - t.bestellwert_cent);
  }

  const meldungen = [];
  for (const inv of [...rechnungen].filter(Boolean).sort((a, b) => (String(a.invoiceNo) < String(b.invoiceNo) ? -1 : 1))) {
    const r = rechnungPruefen(inv);
    if (r.hinweis && (!r.hinweis.tag || im(r.hinweis.tag))) hinweise.push(r.hinweis);
    if (r.meldung && im(r.meldung.daten.datum)) meldungen.push(r.meldung);
  }

  // Mehrere Zahlungen auf dieselbe Rechnung (zum Beispiel zwei Teilüberweisungen) werden zu einer Meldung
  // zahlung:<Nr>: Betrag ist die Summe, Datum und Zahlart die der letzten Zahlung. Kommt später eine weitere
  // Zahlung dazu, ändert sich der Inhalt, und das Office meldet die neue Fassung als "abweichend".
  // Kubi sieht das und bucht die Differenz nach. Das ist so gewollt (GoBD: Inhalt nie überschreiben).
  const zahlungen = new Map();
  for (const z of firmenZahlungen) {
    if (!z || !z.nummer) continue;
    const tag = tagAus(z.tag);
    if (!tag) { hinweis(null, `Zahlung zu ${z.nummer}: Datum unlesbar, nicht gemeldet.`); continue; }
    if (!(z.betrag_cent > 0)) continue;
    const liste = zahlungen.get(z.nummer) || [];
    liste.push({ tag, betrag_cent: z.betrag_cent, zahlart: ZAHLWEG[z.zahlart] || 'ueberweisung' });
    zahlungen.set(z.nummer, liste);
  }
  for (const nummer of [...zahlungen.keys()].sort()) {
    const liste = zahlungen.get(nummer).sort((a, b) => (a.tag !== b.tag ? (a.tag < b.tag ? -1 : 1)
      : a.zahlart !== b.zahlart ? (a.zahlart < b.zahlart ? -1 : 1) : a.betrag_cent - b.betrag_cent));
    const letzte = liste[liste.length - 1];
    if (!im(letzte.tag)) continue;
    meldungen.push({ schluessel: 'zahlung:' + nummer, art: 'zahlung', daten: { nummer, datum: letzte.tag, zahlart: letzte.zahlart, betrag_cent: liste.reduce((s, z) => s + z.betrag_cent, 0) } });
  }

  for (const tag of [...tage.keys()].sort()) {
    const posten = [...tage.get(tag).entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, p]) => p);
    meldungen.push({ schluessel: `tag:${tag}:online`, art: 'tag', daten: { datum: tag, posten } });
  }
  hinweise.sort((a, b) => (String(a.tag || '') + a.text < String(b.tag || '') + b.text ? -1 : 1));
  return { meldungen, hinweise };
}

module.exports = { baueMeldungen, rechnungsMeldung, tagAus, berlinTag, echterTag };
