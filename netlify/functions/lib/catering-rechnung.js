/**
 * lib/catering-rechnung.js
 * ----------------------------------------------------------------------------
 * Rechnungen zu Catering-Angeboten (lib/catering-angebot.js):
 *
 *   Anzahlungsrechnung  nach Eingang der Anzahlung (online oder von Hand)
 *   Schlussrechnung     nach dem Event, zieht die Anzahlung je Steuersatz ab
 *                       (§ 14 Abs. 5 Satz 2 UStG)
 *   Stornorechnung      wenn eine von Hand eingetragene Zahlung zurückgenommen
 *                       wird; hebt die Anzahlungsrechnung mit Minusbeträgen auf
 *
 * Steuersätze (Entscheidung Kubi, 23.11.2026): Speisen 7 %, alles andere 19 %.
 *   paket                        7 %
 *   pauschale, anfahrt, stunde  19 %
 *   extra                        wählbar 7 % oder 19 % (Standard 19 %)
 * Ein Rabatt verteilt sich anteilig auf die Sätze. Gerechnet wird in Cent,
 * Restcents gehen nach der Methode des größten Rests an die Sätze.
 *
 * Die Datensätze liegen wie alle Rechnungen im Store „invoices“ unter
 * inv:<Nummer> (gemeinsamer Nummernkreis GNC-<Jahr>-<NNNN>, lib/rechnungsnummer.js)
 * und erscheinen damit im Admin unter „Rechnungen“, im ZIP und als PDF über
 * invoice-pdf.js (lib/invoice.js reicht art: 'catering_*' hierher weiter).
 * Für die Summen dort gilt: Anzahlungsrechnung + Schlussrechnung = Auftrag.
 * Die Schlussrechnung trägt deshalb in total/vat nur den Restbetrag, die
 * vollen Werte stehen in schluss.gesamt.
 *
 * Eine E-Rechnung (XRechnung) gibt es für Catering noch nicht; Pflicht wird
 * sie für Grill'n Chill erst 2028. Die PDFs nutzen Inter (lib/pdf-schrift.js).
 * ----------------------------------------------------------------------------
 */

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const schrift = require('./pdf-schrift');

const VERKAEUFER = {
  name: "Grill'n Chill Yildiz und Öztas GbR",
  strasse: 'Im Teich 9', plz: '49152', ort: 'Bad Essen',
  ustId: 'DE459954473',
  mail: 'info@grillnchill-foodtruck.de',
  tel: '+49 151 18 54 06 04',
  web: 'grillnchill-foodtruck.de',
};
const ZAHLUNGSZIEL_TAGE = 14;

/* ---- Rechnen -------------------------------------------------------------- */
const cent = (v) => Math.round((Number(v) || 0) * 100);
const euro = (c) => Math.round(c) / 100;

/** Steuersatz einer Angebotsposition */
function satzVon(z) {
  if (!z) return 19;
  if (z.art === 'paket') return 7;
  if (z.art === 'extra') return Number(z.satz) === 7 ? 7 : 19;
  return 19;
}

/** Betrag c (Cent) nach Gewichten aufteilen, Summe bleibt exakt (größter Rest). */
function verteilen(c, gewichte) {
  const summe = gewichte.reduce((n, g) => n + g, 0);
  if (!summe) return gewichte.map(() => 0);
  const roh = gewichte.map((g) => (c * g) / summe);
  const teile = roh.map((x) => Math.floor(x));
  let rest = c - teile.reduce((n, x) => n + x, 0);
  const reihenfolge = roh.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r);
  for (let k = 0; rest > 0 && k < reihenfolge.length; k++, rest--) teile[reihenfolge[k].i]++;
  return teile;
}

/** Brutto je Satz (Cent) -> { satz, brutto, netto, steuer } in Euro, Sätze aufsteigend */
function vatAus(bruttoJeSatz) {
  return Object.keys(bruttoJeSatz).map(Number).sort((a, b) => a - b)
    .filter((s) => bruttoJeSatz[s] !== 0)
    .map((satz) => {
      const b = bruttoJeSatz[satz];
      const n = Math.round(b / (1 + satz / 100));
      return { satz, brutto: euro(b), netto: euro(n), steuer: euro(b - n) };
    });
}

/**
 * Positionen und Rabatt -> Beträge je Steuersatz.
 * @returns {{ zeilen, summeC, rabattC, gesamtC, jeSatzC: {7: c, 19: c} }}
 */
function aufteilung(zeilenRoh, rabatt) {
  const zeilen = (zeilenRoh || []).map((z) => {
    const betragC = Math.round(cent(z.einzel) * (Number(z.menge) || 0));
    return { ...z, satz: satzVon(z), betrag: euro(betragC), betragC };
  });
  const summeC = zeilen.reduce((n, z) => n + z.betragC, 0);
  const r = rabatt || {};
  let rabattC = 0;
  if (r.art === 'prozent') rabattC = Math.round(summeC * (Number(r.wert) || 0) / 100);
  else if (r.art === 'betrag') rabattC = Math.min(cent(r.wert), summeC);
  rabattC = Math.max(0, Math.min(rabattC, summeC));
  const saetze = [7, 19];
  const bruttoVor = saetze.map((s) => zeilen.filter((z) => z.satz === s).reduce((n, z) => n + z.betragC, 0));
  const rabattTeile = verteilen(rabattC, bruttoVor);
  const jeSatzC = {};
  saetze.forEach((s, i) => { jeSatzC[s] = bruttoVor[i] - rabattTeile[i]; });
  return { zeilen, summeC, rabattC, gesamtC: summeC - rabattC, jeSatzC };
}

/** Teilbetrag (Anzahlung) anteilig auf die Sätze eines Auftrags verteilen */
function anteilig(jeSatzC, betragC) {
  const saetze = Object.keys(jeSatzC).map(Number).sort((a, b) => a - b);
  const teile = verteilen(betragC, saetze.map((s) => Math.max(0, jeSatzC[s])));
  const aus = {};
  saetze.forEach((s, i) => { aus[s] = teile[i]; });
  return aus;
}

/* ---- Datum ---------------------------------------------------------------- */
function berlinTag(d) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
}
const deDatum = (ymd) => (/^\d{4}-\d{2}-\d{2}/.test(ymd || '') ? String(ymd).slice(0, 10).split('-').reverse().join('.') : '');
function plusTage(ymd, n) { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d) + n * 864e5).toISOString().slice(0, 10); }

/* ---- Datensätze ----------------------------------------------------------- */
function kundeFelder(a) {
  const k = a.kunde || {};
  return {
    company: k.firma || k.name || '',
    kundeName: k.name || '',
    invoiceAddress: { street: k.strasse || '', zip: k.plz || '', city: k.ort || '' },
    ustIdKunde: k.ustId || '',
    email: k.email || '',
  };
}
/** Fehlt etwas, das auf einer Rechnung über 250 € stehen muss? */
function adresseFehlt(a) {
  const k = (a && a.kunde) || {};
  return !(String(k.firma || k.name || '').trim() && String(k.strasse || '').trim() && String(k.plz || '').trim() && String(k.ort || '').trim());
}

function leistungsText(a) {
  const ev = a.event || {};
  return 'Catering' + (ev.datum ? ' am ' + deDatum(ev.datum) : '') + (ev.ort ? ' (' + ev.ort + ')' : '')
    + ' laut Angebot ' + a.nummer;
}

/**
 * Anzahlungsrechnung über eine erhaltene Anzahlung.
 * @param zahlung { betrag, bezahltAm (ISO), weg: 'online'|'bar'|'ueberweisung' }
 */
function anzahlungsrechnung(a, nummer, zahlung, jetzt) {
  const auf = aufteilung(a.zeilen, a.rabatt);
  const betragC = cent(zahlung.betrag);
  const teil = anteilig(auf.jeSatzC, betragC);
  const vat = vatAus(teil);
  const datum = berlinTag(jetzt);
  const nameSatz = (s) => s === 7 ? 'Speisen, 7 % USt.' : 'Event-Leistungen, 19 % USt.';
  return {
    invoiceNo: nummer, invoiceDate: deDatum(datum), invoiceDay: datum,
    art: 'catering_anzahlung', reference: a.nummer, angebotId: a.id,
    ...kundeFelder(a),
    serviceDate: deDatum(a.event && a.event.datum), eventOrt: (a.event && a.event.ort) || '',
    leistung: leistungsText(a),
    anzahlungProzent: a.anzahlungProzent || 0,
    auftrag: { brutto: euro(auf.gesamtC), vat: vatAus(auf.jeSatzC) },
    items: vat.map((v) => ({ name: 'Anzahlung ' + (a.anzahlungProzent || '') + ' % (' + nameSatz(v.satz) + ')', qty: 1, price: v.brutto, total: v.brutto, satz: v.satz })),
    vat, subtotal: euro(betragC), total: euro(betragC),
    payment: zahlung.weg === 'online' ? 'sumup' : (zahlung.weg || 'bar'),
    zahlungsweg: zahlung.weg || 'bar',
    bezahltAm: zahlung.bezahltAm || null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Schlussrechnung. zeilen/rabatt: Endstand nach dem Event (Standard: aus dem Angebot).
 * abzuege: Anzahlungsrechnungen (Datensätze), die abgezogen werden.
 */
function schlussrechnung(a, nummer, { zeilen, rabatt, abzuege, jetzt }) {
  const auf = aufteilung(zeilen || a.zeilen, rabatt || a.rabatt);
  const gesamtVat = vatAus(auf.jeSatzC);
  const abz = (abzuege || []).filter(Boolean);
  // Rest je Satz: Netto und Steuer der Anzahlung werden einzeln abgezogen
  const saetze = [...new Set(gesamtVat.map((v) => v.satz).concat(...abz.map((r) => (r.vat || []).map((v) => v.satz))))].sort((x, y) => x - y);
  const restVat = saetze.map((satz) => {
    const g = gesamtVat.find((v) => v.satz === satz) || { brutto: 0, netto: 0, steuer: 0 };
    const ab = abz.reduce((m, r) => {
      const v = (r.vat || []).find((x) => x.satz === satz) || { brutto: 0, netto: 0, steuer: 0 };
      return { brutto: m.brutto + cent(v.brutto), netto: m.netto + cent(v.netto), steuer: m.steuer + cent(v.steuer) };
    }, { brutto: 0, netto: 0, steuer: 0 });
    return { satz, brutto: euro(cent(g.brutto) - ab.brutto), netto: euro(cent(g.netto) - ab.netto), steuer: euro(cent(g.steuer) - ab.steuer) };
  }).filter((v) => v.brutto !== 0 || v.netto !== 0 || v.steuer !== 0);
  const abzugC = abz.reduce((n, r) => n + cent(r.total), 0);
  const datum = berlinTag(jetzt);
  return {
    invoiceNo: nummer, invoiceDate: deDatum(datum), invoiceDay: datum,
    art: 'catering_schluss', reference: a.nummer, angebotId: a.id,
    ...kundeFelder(a),
    serviceDate: deDatum(a.event && a.event.datum), eventOrt: (a.event && a.event.ort) || '',
    leistung: leistungsText(a),
    items: auf.zeilen.filter((z) => Number(z.menge) > 0).map((z) => ({ name: z.text, qty: Number(z.menge) || 0, price: Number(z.einzel) || 0, total: z.betrag, satz: z.satz })),
    schluss: {
      summe: euro(auf.summeC), rabatt: euro(auf.rabattC), rabattArt: (rabatt || a.rabatt || {}).art || 'keiner',
      gesamt: euro(auf.gesamtC), gesamtVat,
      abzuege: abz.map((r) => ({ invoiceNo: r.invoiceNo, invoiceDate: r.invoiceDate, total: r.total, vat: r.vat })),
    },
    vat: restVat, subtotal: euro(auf.gesamtC), total: euro(auf.gesamtC - abzugC),
    payment: 'ueberweisung', faelligAm: deDatum(plusTage(datum, ZAHLUNGSZIEL_TAGE)),
    createdAt: new Date().toISOString(),
  };
}

/** Stornorechnung: hebt eine Rechnung mit Minusbeträgen auf */
function stornorechnung(orig, nummer, jetzt) {
  const neg = (v) => (Number(v) ? euro(-cent(v)) : 0);
  const datum = berlinTag(jetzt);
  return {
    ...orig,
    invoiceNo: nummer, invoiceDate: deDatum(datum), invoiceDay: datum,
    art: 'catering_storno', stornoZu: orig.invoiceNo, stornoZuDatum: orig.invoiceDate, stornoZuArt: orig.art,
    items: (orig.items || []).map((i) => ({ ...i, price: neg(i.price), total: neg(i.total) })),
    vat: (orig.vat || []).map((v) => ({ ...v, brutto: neg(v.brutto), netto: neg(v.netto), steuer: neg(v.steuer) })),
    subtotal: neg(orig.subtotal), total: neg(orig.total),
    storniertDurch: undefined, createdAt: new Date().toISOString(),
  };
}

/* ---- PDF ------------------------------------------------------------------ */
function datei(name) {
  for (const w of [path.join(__dirname, '..', '..', '..'), process.env.LAMBDA_TASK_ROOT || '.', process.cwd()]) {
    const k = path.join(w, name);
    try { if (fs.existsSync(k)) return k; } catch (e) {}
  }
  return null;
}
function bankverbindung() {
  const iban = String(process.env.RECHNUNG_IBAN || '').replace(/\s+/g, '').toUpperCase();
  if (!iban) return null;
  return {
    iban: iban.replace(/(.{4})/g, '$1 ').trim(),
    bic: String(process.env.RECHNUNG_BIC || '').replace(/\s+/g, '').toUpperCase(),
    inhaber: String(process.env.RECHNUNG_KONTOINHABER || VERKAEUFER.name),
  };
}
const eur = (n) => (Number(n) || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const menge = (n) => (Number(n) || 0).toLocaleString('de-DE', { maximumFractionDigits: 2 });
const TITEL = { catering_anzahlung: 'Anzahlungsrechnung', catering_schluss: 'Schlussrechnung', catering_storno: 'Stornorechnung' };
const WEG = { online: 'online über SumUp', bar: 'bar', ueberweisung: 'per Überweisung', sumup: 'online über SumUp' };

function rechnungPdf(r) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: (TITEL[r.art] || 'Rechnung') + ' ' + r.invoiceNo, Author: "Grill'n Chill" } });
      const teile = [];
      doc.on('data', (x) => teile.push(x));
      doc.on('end', () => resolve(Buffer.concat(teile)));
      doc.on('error', reject);
      const S = schrift.einrichten(doc);
      const F = S.normal, FB = S.fett, T = S.text;
      const L = 50, R = 545, B = R - L;
      const grau = '#666666', dunkel = '#1A1A1A', linie = '#DDDDDD', orange = '#CC4715';

      // Kopf
      const logo = datei('logo.png');
      let kx = L;
      if (logo) { try { doc.image(logo, L, 46, { fit: [54, 54] }); kx = L + 66; } catch (e) {} }
      doc.font(FB).fontSize(19).fillColor(dunkel).text(TITEL[r.art] || 'Rechnung', kx, 50, { width: 280 });
      doc.font(F).fontSize(9).fillColor(grau)
        .text(T(VERKAEUFER.name), kx, 76).text(T(VERKAEUFER.strasse + ' · ' + VERKAEUFER.plz + ' ' + VERKAEUFER.ort), kx)
        .text('USt-IdNr. ' + VERKAEUFER.ustId, kx);
      const rx = 340;
      let ky = 50;
      const kopfZeile = (label, wert) => {
        if (!wert) return;
        doc.font(F).fontSize(9).fillColor(grau).text(label, rx, ky, { width: 100 });
        doc.font(FB).fillColor(dunkel).text(T(wert), rx + 100, ky, { width: R - rx - 100, align: 'right' });
        ky += 13;
      };
      kopfZeile('Rechnungsnummer', r.invoiceNo);
      kopfZeile('Rechnungsdatum', r.invoiceDate);
      if (r.art === 'catering_anzahlung') {
        kopfZeile('Leistung am', r.serviceDate ? r.serviceDate + ' (geplant)' : '');
        kopfZeile('Anzahlung erhalten', r.bezahltAm ? deDatum(berlinTag(new Date(r.bezahltAm))) : '');
      } else {
        kopfZeile('Leistungsdatum', r.serviceDate);
      }
      kopfZeile('Angebot', r.reference);

      // Empfänger
      let y = Math.max(ky, 118) + 14;
      doc.font(F).fontSize(8).fillColor(grau).text('RECHNUNGSEMPFÄNGER', L, y, { characterSpacing: 0.6 });
      y += 13;
      doc.font(FB).fontSize(11).fillColor(dunkel).text(T(r.company), L, y, { width: 280 });
      y = doc.y + 2;
      doc.font(F).fontSize(10);
      if (r.kundeName && r.kundeName !== r.company) { doc.text(T(r.kundeName), L, y, { width: 280 }); y = doc.y + 1; }
      const adr = r.invoiceAddress || {};
      if (adr.street) { doc.text(T(adr.street), L, y, { width: 280 }); y = doc.y + 1; }
      if (adr.zip || adr.city) { doc.text(T((adr.zip || '') + ' ' + (adr.city || '')), L, y, { width: 280 }); y = doc.y + 1; }
      if (r.ustIdKunde) { doc.fontSize(9).fillColor(grau).text('USt-IdNr. ' + T(r.ustIdKunde), L, y); y = doc.y + 1; }

      // Einleitung
      y += 18;
      doc.font(F).fontSize(10).fillColor(dunkel);
      let einleitung = '';
      if (r.art === 'catering_anzahlung') {
        einleitung = 'Wir berechnen die vereinbarte Anzahlung von ' + r.anzahlungProzent + ' % für ' + r.leistung
          + '. Die Leistung erbringen wir am Eventtag. Mit der Schlussrechnung ziehen wir diese Anzahlung samt Umsatzsteuer wieder ab.';
      } else if (r.art === 'catering_schluss') {
        einleitung = 'Schlussrechnung für ' + r.leistung + '.'
          + ((r.schluss && r.schluss.abzuege && r.schluss.abzuege.length) ? ' Die bereits berechnete Anzahlung ziehen wir unten ab.' : '');
      } else {
        einleitung = 'Diese Rechnung storniert die ' + (TITEL[r.stornoZuArt] || 'Rechnung') + ' ' + r.stornoZu
          + ' vom ' + r.stornoZuDatum + ' vollständig. Alle Beträge sind deshalb negativ.';
      }
      doc.text(T(einleitung), L, y, { width: B, lineGap: 1.5 });
      y = doc.y + 18;

      // Positionen
      doc.moveTo(L, y).lineTo(R, y).strokeColor(linie).stroke();
      y += 8;
      doc.font(FB).fontSize(8).fillColor(grau);
      doc.text('POSITION', L, y);
      doc.text('MENGE', 300, y, { width: 45, align: 'right' });
      doc.text('EINZEL', 350, y, { width: 65, align: 'right' });
      doc.text('USt.', 420, y, { width: 35, align: 'right' });
      doc.text('BETRAG', 460, y, { width: 85, align: 'right' });
      y += 14;
      doc.moveTo(L, y).lineTo(R, y).strokeColor(linie).stroke();
      y += 9;
      doc.font(F).fontSize(9.5).fillColor(dunkel);
      (r.items || []).forEach((i) => {
        const h = doc.heightOfString(T(i.name), { width: 240 });
        doc.text(T(i.name), L, y, { width: 240 });
        doc.text(menge(i.qty), 300, y, { width: 45, align: 'right' });
        doc.text(eur(i.price), 350, y, { width: 65, align: 'right' });
        doc.text(i.satz + ' %', 420, y, { width: 35, align: 'right' });
        doc.text(eur(i.total), 460, y, { width: 85, align: 'right' });
        y += Math.max(h, 12) + 6;
        if (y > 690) { doc.addPage(); y = 60; }
      });

      // Summen
      if (y > 560) { doc.addPage(); y = 60; }
      y += 4;
      doc.moveTo(280, y).lineTo(R, y).strokeColor(linie).stroke();
      y += 9;
      const summe = (label, wert, fett, farbe) => {
        doc.font(fett ? FB : F).fontSize(fett ? 11 : 9.5).fillColor(farbe || (fett ? dunkel : grau));
        const h = doc.heightOfString(T(label), { width: 175 });
        doc.text(T(label), 280, y, { width: 175 });
        doc.text(wert, 460, y, { width: 85, align: 'right' });
        y += Math.max(h, fett ? 14 : 11) + (fett ? 4 : 3);
      };
      const vatBlock = (vat, vorsilbe) => (vat || []).forEach((v) => {
        summe((vorsilbe || '') + 'Netto ' + v.satz + ' %', eur(v.netto));
        summe((vorsilbe || '') + 'zzgl. ' + v.satz + ' % USt.', eur(v.steuer));
      });
      if (r.art === 'catering_schluss') {
        const s = r.schluss || {};
        if (s.rabatt) {
          summe('Zwischensumme', eur(s.summe));
          summe('Rabatt', '- ' + eur(s.rabatt), false, '#3D6B34');
        }
        vatBlock(s.gesamtVat);
        summe('Gesamtbetrag', eur(s.gesamt), true);
        (s.abzuege || []).forEach((ab) => {
          y += 4;
          doc.font(FB).fontSize(9).fillColor(dunkel).text(T('abzüglich Anzahlung, Rechnung ' + ab.invoiceNo + ' vom ' + ab.invoiceDate), 280, y, { width: R - 280 });
          y = doc.y + 3;
          (ab.vat || []).forEach((v) => {
            summe('Netto ' + v.satz + ' %', '- ' + eur(v.netto));
            summe(v.satz + ' % USt.', '- ' + eur(v.steuer));
          });
          summe('Anzahlung gesamt', '- ' + eur(ab.total));
        });
        y += 3;
        doc.moveTo(280, y).lineTo(R, y).strokeColor('#999999').stroke();
        y += 9;
        summe(Number(r.total) < 0 ? 'Erstattung an dich' : 'Noch zu zahlen', eur(Math.abs(Number(r.total) || 0)), true, orange);
      } else {
        vatBlock(r.vat);
        y += 3;
        doc.moveTo(280, y).lineTo(R, y).strokeColor('#999999').stroke();
        y += 9;
        summe(r.art === 'catering_storno' ? 'Gesamtbetrag (Storno)' : 'Anzahlung gesamt', eur(r.total), true);
        if (r.art === 'catering_anzahlung' && r.auftrag) {
          y += 6;
          doc.font(F).fontSize(8.5).fillColor(grau).text(T('Auftragswert laut Angebot: ' + eur(r.auftrag.brutto) + ' inkl. USt. ('
            + r.auftrag.vat.map((v) => v.satz + ' %: ' + eur(v.brutto)).join(', ') + ').'), 280, y, { width: R - 280 });
          y = doc.y + 3;
        }
      }

      // Zahlung
      y += 16;
      doc.font(F).fontSize(9.5).fillColor(dunkel);
      let zahlung = '';
      if (r.art === 'catering_anzahlung') {
        zahlung = 'Bezahlt ' + (WEG[r.zahlungsweg] || '') + (r.bezahltAm ? ' am ' + deDatum(berlinTag(new Date(r.bezahltAm))) : '') + '. Es ist nichts mehr offen.';
      } else if (r.art === 'catering_schluss') {
        if (Number(r.total) > 0) {
          const bank = bankverbindung();
          zahlung = 'Bitte überweise ' + eur(r.total) + ' bis ' + r.faelligAm + ' mit dem Verwendungszweck ' + r.invoiceNo + '.'
            + (bank ? ' Bankverbindung: ' + bank.inhaber + ', IBAN ' + bank.iban + (bank.bic ? ', BIC ' + bank.bic : '') + '.' : '');
        } else if (Number(r.total) < 0) {
          zahlung = 'Den Betrag erstatten wir dir in den nächsten Tagen auf dem Zahlungsweg der Anzahlung.';
        } else {
          zahlung = 'Mit der Anzahlung ist alles bezahlt. Es ist nichts mehr offen.';
        }
      } else {
        zahlung = 'Bereits gezahlte Beträge erstatten wir dir auf dem ursprünglichen Zahlungsweg, sofern das noch nicht geschehen ist.';
      }
      doc.text(T(zahlung), L, y, { width: B, lineGap: 1.5 });
      y = doc.y + 24;
      // Fuß am Seitenende (unterhalb des Rands, sonst bricht pdfkit auf eine neue Seite um)
      if (y > 780) { doc.addPage(); y = 60; }
      doc.page.margins.bottom = 0;
      const fuss = T(VERKAEUFER.name + ' · ' + VERKAEUFER.strasse + ' · ' + VERKAEUFER.plz + ' ' + VERKAEUFER.ort + ' · USt-IdNr. ' + VERKAEUFER.ustId
        + ' · ' + VERKAEUFER.mail + ' · ' + VERKAEUFER.tel);
      let fg = 7.5;
      while (fg > 6 && doc.font(F).fontSize(fg).widthOfString(fuss) > B) fg -= 0.25;
      doc.font(F).fontSize(fg).fillColor('#999999').text(fuss, L, Math.max(y, 796), { width: B, align: 'center', lineBreak: false });
      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = {
  satzVon, verteilen, aufteilung, anteilig, vatAus, adresseFehlt,
  anzahlungsrechnung, schlussrechnung, stornorechnung, rechnungPdf, TITEL, ZAHLUNGSZIEL_TAGE,
};
