/**
 * lib/geschenk-pdf.js
 * ----------------------------------------------------------------------------
 * Geschenkgutschein als PDF (A4), mit Karte zum Ausschneiden. pdfkit wie
 * lib/angebot-pdf.js; nur Helvetica, weil eingebettete Schriften in der
 * macOS- und iOS-Vorschau nicht erscheinen (siehe dort). Das CI kommt über
 * Logo, Farben, die dunkle Karte und die Grillstreifen.
 * ----------------------------------------------------------------------------
 */

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const FARBE = {
  grund: '#0C0B09', karte: '#17140F', creme: '#F5E9D0', dim: '#C9BCA4', muted: '#8F8471',
  orange: '#E85A24', orangeHell: '#FF7A3D', text: '#1A1A1A', grau: '#666666', linie: '#D9CFBD',
};

function datei(name) {
  for (const w of [path.join(__dirname, '..', '..', '..'), process.env.LAMBDA_TASK_ROOT || '.', process.cwd()]) {
    const k = path.join(w, name);
    try { if (fs.existsSync(k)) return k; } catch (e) {}
  }
  return null;
}

// Standardschriften können nur Latin-1 (gleiche Regeln wie lib/angebot-pdf.js)
function latin1(s) {
  return String(s == null ? '' : s)
    .replace(/[Ş]/g, 'S').replace(/[ş]/g, 's').replace(/Ğ/g, 'G').replace(/ğ/g, 'g')
    .replace(/İ/g, 'I').replace(/ı/g, 'i')
    .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[^\u0000-ÿ€]/g, '');
}
const euro = (n) => {
  const v = Number(n || 0);
  return (v % 1 ? v.toFixed(2).replace('.', ',') : String(v)) + ' €';
};
const deDatum = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso.split('-').reverse().join('.') : '');

function gutscheinPdf(d) {
  const { VORSCHLAEGE } = require('./geschenk');
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4', margin: 50,
        info: { Title: 'Gutschein ' + d.code, Author: "Grill'n Chill", Subject: 'Geschenkgutschein' },
      });
      const teile = [];
      doc.on('data', (x) => teile.push(x));
      doc.on('end', () => resolve(Buffer.concat(teile)));
      doc.on('error', reject);

      const W = 595.28, L = 50, R = W - 50;
      const logo = datei('logo.png');

      /* ---- Kopf ---- */
      doc.rect(0, 0, W, 110).fill(FARBE.grund);
      doc.rect(0, 110, W, 4).fill(FARBE.orange);
      let x0 = L;
      if (logo) { try { doc.image(logo, L, 26, { fit: [58, 58] }); x0 = L + 72; } catch (e) {} }
      doc.font('Helvetica-Bold').fontSize(20).fillColor(FARBE.creme).text("GRILL'N CHILL", x0, 36, { characterSpacing: 0.6, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(FARBE.orange).text('FOODTRUCK · BIELEFELD · 100 % HALAL', x0, 63, { characterSpacing: 1.6, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(22).fillColor(FARBE.creme).text('GUTSCHEIN', 300, 40, { width: R - 300, align: 'right', characterSpacing: 1.5 });

      /* ---- Überschrift ---- */
      let y = 146;
      const titel = d.recipientName ? 'Für ' + d.recipientName : 'Dein Gutschein';
      doc.font('Helvetica-Bold').fontSize(24).fillColor(FARBE.text).text(latin1(titel), L, y, { width: R - L });
      y = doc.y + 4;
      const unter = d.buyerName ? 'Von ' + d.buyerName + ', mit Burger-Grüßen' : 'Guten Appetit';
      doc.font('Helvetica').fontSize(11).fillColor(FARBE.grau).text(latin1(unter), L, y, { width: R - L });
      y = doc.y + 26;

      /* ---- Karte zum Ausschneiden ---- */
      const KW = 400, KH = Math.round(KW / 1.586), KX = (W - KW) / 2, KY = y;
      // Schnittlinie mit Abstand
      doc.save().lineWidth(0.8).dash(4, { space: 4 }).strokeColor(FARBE.linie)
        .roundedRect(KX - 12, KY - 12, KW + 24, KH + 24, 22).stroke().undash().restore();
      doc.font('Helvetica').fontSize(7).fillColor(FARBE.muted)
        .text('ENTLANG DER LINIE AUSSCHNEIDEN', KX - 12, KY - 26, { width: KW + 24, align: 'right', characterSpacing: 1.2 });

      doc.save();
      doc.roundedRect(KX, KY, KW, KH, 16).clip();
      doc.rect(KX, KY, KW, KH).fill(FARBE.karte);
      // Glut oben links
      const glut = doc.radialGradient(KX + 40, KY + 30, 0, KX + 40, KY + 30, 260);
      glut.stop(0, FARBE.orange, 0.38).stop(1, FARBE.orange, 0);
      doc.rect(KX, KY, KW, KH).fill(glut);
      // Grillstreifen
      doc.save().opacity(0.07).lineWidth(9).strokeColor(FARBE.creme);
      for (let i = -2; i < 8; i++) {
        const sx = KX + i * 62;
        doc.moveTo(sx, KY + KH).lineTo(sx + KH * 0.9, KY).stroke();
      }
      doc.restore();
      doc.restore();
      doc.save().lineWidth(0.6).strokeColor('#3A3227').roundedRect(KX, KY, KW, KH, 16).stroke().restore();

      const P = 22;
      if (logo) { try { doc.image(logo, KX + P, KY + P - 2, { fit: [30, 30] }); } catch (e) {} }
      doc.font('Helvetica-Bold').fontSize(10).fillColor(FARBE.creme).text("GRILL'N CHILL", KX + P + 38, KY + P + 2, { lineBreak: false, characterSpacing: 0.6 });
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(FARBE.orangeHell).text('GUTSCHEIN', KX + P + 38, KY + P + 15, { lineBreak: false, characterSpacing: 1.6 });

      doc.font('Helvetica-Bold').fontSize(46).fillColor(FARBE.creme).text(euro(d.amount), KX + P, KY + 66, { lineBreak: false });
      let iy = KY + 120;
      const vor = d.preset && VORSCHLAEGE[d.preset];
      if (vor) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor(FARBE.dim).text(latin1('Gedacht für: ' + vor.titel), KX + P, iy, { width: KW - 2 * P, lineBreak: false });
        iy += 15;
      }
      if (d.message) {
        doc.font('Helvetica-Oblique').fontSize(9).fillColor(FARBE.creme)
          .text(latin1(d.message.replace(/\s*\n\s*/g, ' ')), KX + P, iy, { width: KW - 2 * P, height: 24, ellipsis: true, lineGap: 1 });
      }
      // Unterer Rand: Für, Von, Code
      const by = KY + KH - P - 22;
      const spalte = (label, wert, x, w) => {
        doc.font('Helvetica-Bold').fontSize(6.5).fillColor(FARBE.muted).text(label, x, by, { width: w, characterSpacing: 1.2, lineBreak: false });
        doc.font('Helvetica-Bold').fontSize(10).fillColor(FARBE.creme).text(latin1(wert || '-'), x, by + 10, { width: w, height: 12, ellipsis: true, lineBreak: false });
      };
      spalte('FÜR', d.recipientName, KX + P, 110);
      spalte('VON', d.buyerName, KX + P + 118, 110);
      doc.font('Courier-Bold').fontSize(11).fillColor(FARBE.orangeHell).text(d.code, KX + KW - P - 140, by + 1, { width: 140, align: 'right', characterSpacing: 1 });
      doc.font('Helvetica').fontSize(7).fillColor(FARBE.dim).text('gültig bis ' + deDatum(d.validUntil), KX + KW - P - 140, by + 15, { width: 140, align: 'right' });

      y = KY + KH + 44;

      /* ---- Nachricht ausführlich (falls auf der Karte gekürzt) ---- */
      if (d.message && d.message.length > 90) {
        doc.font('Helvetica-Bold').fontSize(8).fillColor(FARBE.grau).text('NACHRICHT', L, y, { characterSpacing: 1.2 });
        doc.font('Helvetica-Oblique').fontSize(11).fillColor(FARBE.text).text(latin1(d.message), L, doc.y + 4, { width: R - L, lineGap: 2 });
        y = doc.y + 22;
      }

      /* ---- So löst du ihn ein ---- */
      doc.font('Helvetica-Bold').fontSize(8).fillColor(FARBE.grau).text('SO LÖST DU IHN EIN', L, y, { characterSpacing: 1.2 });
      y = doc.y + 8;
      const schritte = [
        'Auf grillnchill-foodtruck.de oder in der App „Grill\'n Chill“ bestellen.',
        'Im Warenkorb den Code ' + d.code + ' eintippen.',
        'Am Truck abholen (Gütersloher Straße 122, Bielefeld) oder liefern lassen.',
      ];
      schritte.forEach((s, i) => {
        doc.circle(L + 8, y + 7, 8).fill(FARBE.orange);
        doc.font('Helvetica-Bold').fontSize(9).fillColor('#FFFFFF').text(String(i + 1), L, y + 3, { width: 16, align: 'center' });
        doc.font('Helvetica').fontSize(11).fillColor(FARBE.text).text(latin1(s), L + 26, y + 1, { width: R - L - 26 });
        y = doc.y + 8;
      });

      y += 10;
      doc.font('Helvetica').fontSize(8.5).fillColor(FARBE.grau).text(latin1(
        'Einlösbar online ab einem Bestellwert von ' + euro(d.amount) + ', einmalig, bis zum ' + deDatum(d.validUntil)
        + '. Keine Barauszahlung. Ob der Gutschein noch gilt, siehst du unter grillnchill-foodtruck.de/gutscheine.'
        + ' Es gelten unsere AGB (§ 8) unter grillnchill-foodtruck.de/agb.'), L, y, { width: R - L, lineGap: 1.5 });

      /* ---- Fuß (unterhalb des Seitenrands, sonst bricht pdfkit auf Seite 2 um) ---- */
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7.5).fillColor(FARBE.muted).text(latin1(
        "Grill'n Chill Yildiz und Öztas GbR · Im Teich 9, 49152 Bad Essen · Truck: Gütersloher Straße 122, 33649 Bielefeld · info@grillnchill-foodtruck.de"),
      L, 800, { width: R - L, align: 'center' });

      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { gutscheinPdf };
