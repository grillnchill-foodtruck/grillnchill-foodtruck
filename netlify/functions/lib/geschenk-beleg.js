/**
 * lib/geschenk-beleg.js
 * ----------------------------------------------------------------------------
 * Kaufbeleg für einen Geschenkgutschein (PDF, pdfkit wie lib/angebot-pdf.js).
 *
 * Steuerlich: Der Gutschein gilt für Speisen (7 %) und Getränke (19 %), der
 * Steuersatz steht beim Kauf also nicht fest. Damit ist er ein
 * Mehrzweck-Gutschein (§ 3 Abs. 15 UStG): Der Verkauf selbst ist nicht
 * umsatzsteuerbar, die Steuer entsteht erst bei der Einlösung. Der Beleg
 * weist deshalb keine Umsatzsteuer aus (sonst würde sie nach § 14c UStG
 * geschuldet). Belegnummer ist die Kauf-Referenz (GNC-GC-…), damit er nicht
 * in die fortlaufende Rechnungsnummer der Bestellungen greift.
 *
 * Archiv: Store "invoices", Schlüssel gs:<Referenz> (aufbewahrungspflichtig,
 * kein automatisches Löschen, wie die Rechnungen inv:…).
 * ----------------------------------------------------------------------------
 */

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const VERKAEUFER = {
  name: "Grill'n Chill Yildiz und Öztas GbR",
  strasse: 'Im Teich 9', ort: '49152 Bad Essen',
  ustId: 'DE459954473',
  truck: 'Gütersloher Straße 122, 33649 Bielefeld',
  mail: 'info@grillnchill-foodtruck.de', tel: '+49 151 18 54 06 04', web: 'grillnchill-foodtruck.de',
};
const FARBE = { grund: '#0C0B09', creme: '#F5E9D0', dim: '#C9BCA4', orange: '#E85A24', text: '#1A1A1A', grau: '#666666', linie: '#E2DACB', zart: '#FBF6EC' };

function datei(name) {
  for (const w of [path.join(__dirname, '..', '..', '..'), process.env.LAMBDA_TASK_ROOT || '.', process.cwd()]) {
    const k = path.join(w, name);
    try { if (fs.existsSync(k)) return k; } catch (e) {}
  }
  return null;
}
function latin1(s) {
  return String(s == null ? '' : s)
    .replace(/[Ş]/g, 'S').replace(/[ş]/g, 's').replace(/Ğ/g, 'G').replace(/ğ/g, 'g')
    .replace(/İ/g, 'I').replace(/ı/g, 'i')
    .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[^\u0000-ÿ€]/g, '');
}
const eur = (n) => (Number(n) || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const deDatum = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso || '') ? iso.slice(0, 10).split('-').reverse().join('.') : '');

/** Datensatz fürs Archiv (und zum Neuerzeugen des PDFs). */
function belegDaten(d) {
  return {
    nr: d.reference, datum: String(d.createdAt || new Date().toISOString()).slice(0, 10),
    kaeufer: { name: d.buyerName || '', email: d.buyerEmail || '' },
    code: d.code, betrag: d.amount, gueltigBis: d.validUntil,
    zahlung: 'Online über SumUp (Karte, Apple Pay oder Google Pay)',
    art: 'Mehrzweck-Gutschein',
  };
}

function belegPdf(b) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: 'Kaufbeleg ' + b.nr, Author: "Grill'n Chill", Subject: 'Kaufbeleg Geschenkgutschein' } });
      const teile = [];
      doc.on('data', (x) => teile.push(x));
      doc.on('end', () => resolve(Buffer.concat(teile)));
      doc.on('error', reject);
      const W = 595.28, L = 50, R = W - 50;

      /* Kopf */
      doc.rect(0, 0, W, 104).fill(FARBE.grund);
      doc.rect(0, 104, W, 4).fill(FARBE.orange);
      const logo = datei('logo.png');
      let x0 = L;
      if (logo) { try { doc.image(logo, L, 24, { fit: [56, 56] }); x0 = L + 70; } catch (e) {} }
      doc.font('Helvetica-Bold').fontSize(19).fillColor(FARBE.creme).text("GRILL'N CHILL", x0, 34, { characterSpacing: 0.6, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(FARBE.orange).text('FOODTRUCK · BIELEFELD', x0, 60, { characterSpacing: 1.6, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(20).fillColor(FARBE.creme).text('KAUFBELEG', 300, 34, { width: R - 300, align: 'right', characterSpacing: 1.4 });
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor(FARBE.orange).text(latin1(b.nr), 300, 62, { width: R - 300, align: 'right' });

      /* Verkäufer klein, Käufer, Eckdaten */
      let y = 132;
      doc.font('Helvetica').fontSize(7.5).fillColor(FARBE.grau)
        .text(latin1(VERKAEUFER.name + ' · ' + VERKAEUFER.strasse + ' · ' + VERKAEUFER.ort), L, y, { width: 260 });
      y += 18;
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(FARBE.grau).text('KÄUFER', L, y, { characterSpacing: 1.2 });
      doc.font('Helvetica-Bold').fontSize(11).fillColor(FARBE.text).text(latin1(b.kaeufer.name || '-'), L, y + 12, { width: 250 });
      doc.font('Helvetica').fontSize(9).fillColor(FARBE.grau).text(latin1(b.kaeufer.email), L, doc.y + 1, { width: 250 });

      const eck = [['Belegnummer', b.nr], ['Belegdatum', deDatum(b.datum)], ['Leistungsdatum', deDatum(b.datum)], ['USt-IdNr.', VERKAEUFER.ustId]];
      let ry = 150;
      eck.forEach(([l, w]) => {
        doc.font('Helvetica').fontSize(8.5).fillColor(FARBE.grau).text(latin1(l), 330, ry, { width: 90 });
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(FARBE.text).text(latin1(w), 420, ry, { width: R - 420, align: 'right' });
        ry += 14;
      });

      /* Position */
      y = Math.max(doc.y, ry) + 30;
      doc.rect(L, y, R - L, 22).fill(FARBE.zart);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(FARBE.grau);
      doc.text('POSITION', L + 10, y + 8, { characterSpacing: 1 });
      doc.text('MENGE', 380, y + 8, { width: 50, align: 'right', characterSpacing: 1 });
      doc.text('BETRAG', 440, y + 8, { width: R - 450, align: 'right', characterSpacing: 1 });
      y += 32;
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor(FARBE.text).text('Geschenkgutschein ' + latin1(b.code), L + 10, y, { width: 310 });
      doc.font('Helvetica').fontSize(8.5).fillColor(FARBE.grau)
        .text(latin1('Wertgutschein für Speisen und Getränke bei Grill\'n Chill, gültig bis ' + deDatum(b.gueltigBis) + ', einlösbar online und in der App'), L + 10, doc.y + 2, { width: 310 });
      doc.font('Helvetica').fontSize(10).fillColor(FARBE.text).text('1', 380, y, { width: 50, align: 'right' });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(FARBE.text).text(eur(b.betrag), 440, y, { width: R - 450, align: 'right' });
      y = doc.y + 18;
      doc.moveTo(300, y).lineTo(R, y).strokeColor(FARBE.linie).stroke();
      y += 10;
      doc.font('Helvetica-Bold').fontSize(12).fillColor(FARBE.text).text('Gesamtbetrag', 300, y, { width: 140 });
      doc.text(eur(b.betrag), 440, y, { width: R - 450, align: 'right' });
      y = doc.y + 4;
      doc.font('Helvetica').fontSize(8.5).fillColor(FARBE.grau).text('bezahlt am ' + deDatum(b.datum), 300, y, { width: R - 310, align: 'right' });

      /* Steuerhinweis und Zahlung */
      y = doc.y + 30;
      doc.rect(L, y, R - L, 58).fill(FARBE.zart);
      doc.font('Helvetica-Bold').fontSize(9).fillColor(FARBE.text).text('Hinweis zur Umsatzsteuer', L + 12, y + 10);
      doc.font('Helvetica').fontSize(8.5).fillColor(FARBE.grau).text(latin1(
        'Mehrzweck-Gutschein nach § 3 Abs. 15 UStG. Der Verkauf ist nicht umsatzsteuerbar, deshalb weist dieser Beleg keine Umsatzsteuer aus. '
        + 'Die Umsatzsteuer entsteht bei der Einlösung, mit dem Steuersatz der dann bestellten Speisen und Getränke.'), L + 12, y + 24, { width: R - L - 24, lineGap: 1 });
      y += 76;
      doc.font('Helvetica').fontSize(9).fillColor(FARBE.grau).text(latin1('Zahlung: ' + b.zahlung), L, y, { width: R - L });

      /* Fuß */
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7.5).fillColor(FARBE.grau).text(latin1(
        VERKAEUFER.name + ' · ' + VERKAEUFER.strasse + ', ' + VERKAEUFER.ort + ' · USt-IdNr. ' + VERKAEUFER.ustId
        + '\nTruck: ' + VERKAEUFER.truck + ' · ' + VERKAEUFER.mail + ' · ' + VERKAEUFER.tel + ' · ' + VERKAEUFER.web),
      L, 790, { width: R - L, align: 'center', lineGap: 2 });
      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { belegDaten, belegPdf, VERKAEUFER };
