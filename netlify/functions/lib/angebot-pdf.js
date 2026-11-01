/**
 * lib/angebot-pdf.js
 * ----------------------------------------------------------------------------
 * Catering-Angebot als PDF im Grill'n-Chill-CI (pdfkit, wie lib/invoice.js).
 *
 * Kopf dunkel mit Logo und Schriftzug, Akzent in Orange, Positionen auf
 * weißem Grund (druckt sauber), Summe, Anzahlung, kurze Bedingungen, Kontakt.
 * Das PDF ist immer Deutsch.
 *
 * Schrift: nur die pdfkit-Standardschriften (Helvetica). Bowlby One aus
 * fonts/ wurde geprüft und verworfen: fontkit stürzt beim Einbetten der
 * Umlaute ab, und selbst ohne Umlaute zeigt der PDF-Renderer von macOS und
 * iOS (Vorschau, Mail, Safari) die eingebettete Schrift nicht an. Das CI
 * kommt deshalb über Logo, Farben und den dunklen Kopf.
 * ----------------------------------------------------------------------------
 */

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const VERKAEUFER = {
  name: "Grill'n Chill Yildiz und Öztas GbR",
  strasse: 'Im Teich 9', plz: '49152', ort: 'Bad Essen',
  ustId: 'DE459954473',
  truck: 'Gütersloher Straße 122, 33649 Bielefeld',
  mail: 'info@grillnchill-foodtruck.de',
  tel: '+49 151 18 54 06 04',
  web: 'grillnchill-foodtruck.de',
};

const FARBE = {
  grund: '#0C0B09', creme: '#F5E9D0', cremeDim: '#C9BCA4', orange: '#E85A24', orangeDunkel: '#CC4715',
  text: '#1A1A1A', grau: '#666666', linie: '#E2DACB', zart: '#FBF6EC', gruen: '#3D6B34',
};

function datei(namen) {
  const wurzeln = [
    path.join(__dirname, '..', '..', '..'),
    process.env.LAMBDA_TASK_ROOT || '.',
    process.cwd(),
  ];
  for (const w of wurzeln) {
    const k = path.join(w, namen);
    try { if (fs.existsSync(k)) return k; } catch (e) {}
  }
  return null;
}

/* Gleiche Ersatzregeln wie lib/invoice.js: Standardschriften können nur Latin-1. */
function latin1(s) {
  return String(s == null ? '' : s)
    .replace(/[Ş]/g, 'S').replace(/[ş]/g, 's').replace(/Ğ/g, 'G').replace(/ğ/g, 'g')
    .replace(/İ/g, 'I').replace(/ı/g, 'i')
    .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[^\u0000-ÿ€]/g, '');
}

const eur = (n) => (Number(n) || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const menge = (n) => (Number(n) || 0).toLocaleString('de-DE', { maximumFractionDigits: 2 });
const deDatum = (ymd) => (/^\d{4}-\d{2}-\d{2}$/.test(ymd || '') ? ymd.split('-').reverse().join('.') : '');

function angebotPdf(a, e) {
  const { bedingungen, deDatumLang, heute } = require('./catering-angebot');
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4', margin: 50, bufferPages: true,
        info: { Title: 'Angebot ' + a.nummer, Author: "Grill'n Chill", Subject: 'Catering-Angebot' },
      });
      const teile = [];
      doc.on('data', (d) => teile.push(d));
      doc.on('end', () => resolve(Buffer.concat(teile)));
      doc.on('error', reject);

      const L = 50, R = 545, B = R - L;
      const UNTEN = 770;

      /* ---- Kopf ---- */
      doc.rect(0, 0, 595.28, 122).fill(FARBE.grund);
      doc.rect(0, 122, 595.28, 4).fill(FARBE.orange);
      const logo = datei('logo.png');
      let x0 = L;
      if (logo) { try { doc.image(logo, L, 32, { fit: [60, 60] }); x0 = L + 74; } catch (err) {} }
      doc.font('Helvetica-Bold').fontSize(20).fillColor(FARBE.creme).text("GRILL'N CHILL", x0, 40, { characterSpacing: 0.6, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(FARBE.orange)
        .text('FOODTRUCK CATERING · BIELEFELD', x0, 68, { characterSpacing: 1.6, lineBreak: false });
      doc.font('Helvetica').fontSize(7.5).fillColor(FARBE.cremeDim)
        .text('100 % halal · HCG-zertifiziert', x0, 81, { lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(26).fillColor(FARBE.creme).text('ANGEBOT', 300, 36, { width: R - 300, align: 'right', characterSpacing: 1.5 });
      doc.font('Helvetica-Bold').fontSize(11).fillColor(FARBE.orange).text(latin1(a.nummer), 300, 72, { width: R - 300, align: 'right' });

      /* ---- Empfänger und Eckdaten ---- */
      let y = 150;
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(FARBE.grau).text('FÜR', L, y, { characterSpacing: 1.2 });
      let ly = y + 13;
      const k = a.kunde || {};
      if (k.firma) { doc.font('Helvetica-Bold').fontSize(11).fillColor(FARBE.text).text(latin1(k.firma), L, ly, { width: 240 }); ly = doc.y + 1; }
      doc.font(k.firma ? 'Helvetica' : 'Helvetica-Bold').fontSize(k.firma ? 10 : 11).fillColor(FARBE.text).text(latin1(k.name), L, ly, { width: 240 });
      ly = doc.y + 2;
      doc.font('Helvetica').fontSize(9).fillColor(FARBE.grau);
      if (k.email) { doc.text(latin1(k.email), L, ly, { width: 240 }); ly = doc.y; }
      if (k.telefon) { doc.text(latin1(k.telefon), L, ly, { width: 240 }); ly = doc.y; }

      const rx = 320;
      const ev = a.event || {};
      const eck = [
        ['Angebotsnummer', a.nummer],
        ['Datum', deDatum(a.gesendetAm ? heute(new Date(a.gesendetAm)) : heute())],
        ['Gültig bis', a.gueltigBis ? deDatum(a.gueltigBis) : (a.gueltigTage || e.gueltigTage) + ' Tage ab Versand'],
      ];
      if (ev.datum) eck.push(['Event', deDatumLang(ev.datum)]);
      if (ev.zeit) eck.push(['Uhrzeit', ev.zeit]);
      if (ev.ort) eck.push(['Ort', ev.ort]);
      if (ev.personen) eck.push(['Personen', String(ev.personen)]);
      let ry = y;
      eck.forEach(([l, w]) => {
        doc.font('Helvetica').fontSize(8.5).fillColor(FARBE.grau).text(latin1(l), rx, ry, { width: 85 });
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor(FARBE.text);
        const hgt = doc.heightOfString(latin1(w), { width: R - rx - 90 });
        doc.text(latin1(w), rx + 90, ry, { width: R - rx - 90, align: 'right' });
        ry += Math.max(hgt, 10) + 3.5;
      });
      y = Math.max(ly, ry) + 18;

      doc.font('Helvetica').fontSize(10).fillColor(FARBE.text)
        .text(latin1('Danke für deine Anfrage. Gern kommen wir mit dem Truck zu deinem Event und grillen frisch vor Ort. Das ist unser Angebot:'), L, y, { width: B });
      y = doc.y + 14;

      /* ---- Positionen ---- */
      const kopfZeile = () => {
        doc.rect(L, y, B, 20).fill(FARBE.zart);
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(FARBE.grau);
        doc.text('LEISTUNG', L + 8, y + 7, { characterSpacing: 0.8 });
        doc.text('MENGE', 318, y + 7, { width: 50, align: 'right', characterSpacing: 0.8 });
        doc.text('EINZELPREIS', 372, y + 7, { width: 80, align: 'right', characterSpacing: 0.8 });
        doc.text('BETRAG', 455, y + 7, { width: R - 455 - 8, align: 'right', characterSpacing: 0.8 });
        y += 26;
      };
      kopfZeile();
      const zeilen = (a.zeilen || []).filter((z) => Number(z.menge) > 0);
      zeilen.forEach((z) => {
        doc.font('Helvetica').fontSize(9.5);
        const t = latin1(z.text);
        const hgt = doc.heightOfString(t, { width: 255 });
        if (y + hgt > UNTEN - 40) { doc.addPage(); y = 60; kopfZeile(); }
        doc.font('Helvetica').fontSize(9.5).fillColor(FARBE.text).text(t, L + 8, y, { width: 255 });
        doc.text(menge(z.menge), 318, y, { width: 50, align: 'right' });
        doc.text(Number(z.einzel) > 0 ? eur(z.einzel) : 'inklusive', 372, y, { width: 80, align: 'right' });
        doc.font('Helvetica-Bold').text(Number(z.betrag) > 0 ? eur(z.betrag) : '-', 455, y, { width: R - 455 - 8, align: 'right' });
        y += Math.max(hgt, 12) + 7;
        doc.moveTo(L, y - 3.5).lineTo(R, y - 3.5).lineWidth(0.6).strokeColor(FARBE.linie).stroke();
      });

      /* ---- Summen ---- */
      if (y > UNTEN - 150) { doc.addPage(); y = 60; }
      y += 6;
      const sx = 318;
      const summe = (label, wert, farbe) => {
        doc.font('Helvetica').fontSize(9.5).fillColor(farbe || FARBE.grau).text(latin1(label), sx, y, { width: 140 });
        doc.text(wert, 455, y, { width: R - 455 - 8, align: 'right' });
        y += 15;
      };
      if (Number(a.rabattBetrag) > 0) {
        summe('Zwischensumme', eur(a.summe));
        const r = a.rabatt || {};
        summe(r.art === 'prozent' ? 'Rabatt ' + String(r.wert).replace('.', ',') + ' %' : 'Rabatt', '- ' + eur(a.rabattBetrag), FARBE.gruen);
      }
      y += 2;
      doc.rect(sx - 8, y, R - sx + 8, 34).fill(FARBE.grund);
      doc.font('Helvetica-Bold').fontSize(8).fillColor(FARBE.cremeDim).text('GESAMTBETRAG', sx, y + 13, { characterSpacing: 1 });
      const gesamt = eur(a.gesamt);
      doc.font('Helvetica-Bold').fontSize(15).fillColor(FARBE.creme).text(gesamt, 400, y + 9, { width: R - 400 - 8, align: 'right' });
      y += 40;
      doc.font('Helvetica').fontSize(8).fillColor(FARBE.grau)
        .text('Alle Preise sind Endpreise inklusive gesetzlicher MwSt.', sx - 8, y, { width: R - sx + 8, align: 'right' });
      y += 16;
      if (Number(a.anzahlung) > 0) {
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(FARBE.orangeDunkel)
          .text('Anzahlung ' + a.anzahlungProzent + ' %', sx, y, { width: 135 });
        doc.text(eur(a.anzahlung), 455, y, { width: R - 455 - 8, align: 'right' });
        y += 15;
        doc.font('Helvetica').fontSize(9.5).fillColor(FARBE.grau).text('Rest nach dem Event', sx, y, { width: 135 });
        doc.text(eur(a.rest), 455, y, { width: R - 455 - 8, align: 'right' });
        y += 15;
      }

      /* ---- Hinweis von Kubi ---- */
      if (a.hinweis) {
        y += 10;
        const t = latin1(a.hinweis);
        doc.font('Helvetica').fontSize(9.5);
        const hgt = doc.heightOfString(t, { width: B - 24 });
        if (y + hgt + 30 > UNTEN) { doc.addPage(); y = 60; }
        doc.rect(L, y, 3, hgt + 24).fill(FARBE.orange);
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(FARBE.grau).text('HINWEIS', L + 14, y + 4, { characterSpacing: 1.2 });
        doc.font('Helvetica').fontSize(9.5).fillColor(FARBE.text).text(t, L + 14, y + 17, { width: B - 24 });
        y = doc.y + 12;
      }

      /* ---- Bedingungen und Annahme ---- */
      const liste = bedingungen(a, e);
      doc.font('Helvetica').fontSize(8.5);
      const hoehe = liste.reduce((n, l) => n + doc.heightOfString(latin1(l), { width: B - 14 }) + 3, 0) + 70;
      if (y + hoehe > UNTEN) { doc.addPage(); y = 60; }
      y += 8;
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(FARBE.grau).text('BEDINGUNGEN', L, y, { characterSpacing: 1.2 });
      y += 13;
      liste.forEach((l) => {
        doc.circle(L + 3, y + 4.2, 1.6).fill(FARBE.orange);
        doc.font('Helvetica').fontSize(8.5).fillColor(FARBE.text).text(latin1(l), L + 12, y, { width: B - 14 });
        y = doc.y + 3;
      });
      y += 8;
      doc.font('Helvetica-Bold').fontSize(9).fillColor(FARBE.text).text('So nimmst du an', L, y);
      y = doc.y + 2;
      doc.font('Helvetica').fontSize(8.5).fillColor(FARBE.text)
        .text(latin1('Öffne den Link in unserer E-Mail und tippe auf „Angebot annehmen“. Oder ruf uns an: ' + VERKAEUFER.tel + '.'), L, y, { width: B });

      /* ---- Fuß auf jeder Seite ---- */
      const seiten = doc.bufferedPageRange();
      for (let i = seiten.start; i < seiten.start + seiten.count; i++) {
        doc.switchToPage(i);
        doc.page.margins.bottom = 0;   // sonst legt pdfkit für den Fuß eine neue Seite an
        doc.moveTo(L, 792).lineTo(R, 792).lineWidth(0.6).strokeColor(FARBE.linie).stroke();
        doc.font('Helvetica').fontSize(7).fillColor(FARBE.grau)
          .text(latin1(VERKAEUFER.name + ' · ' + VERKAEUFER.strasse + ' · ' + VERKAEUFER.plz + ' ' + VERKAEUFER.ort + ' · USt-IdNr. ' + VERKAEUFER.ustId),
            L, 798, { width: B, align: 'center', lineBreak: false })
          .text(latin1('Truck: ' + VERKAEUFER.truck + ' · ' + VERKAEUFER.tel + ' · ' + VERKAEUFER.mail + ' · ' + VERKAEUFER.web),
            L, 808, { width: B, align: 'center', lineBreak: false });
      }
      doc.end();
    } catch (err) { reject(err); }
  });
}

module.exports = { angebotPdf, latin1 };
