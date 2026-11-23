/**
 * lib/geschenk-pdf.js
 * ----------------------------------------------------------------------------
 * Geschenkgutschein als PDF (A4), mit Karte zum Ausschneiden. pdfkit wie
 * lib/angebot-pdf.js. Schrift: Inter, eingebettet über lib/pdf-schrift.js
 * (seit 23.11.2026), damit ş, ğ, ı und İ in Namen und Nachricht stimmen;
 * ohne die Schriftdateien fällt sie auf Helvetica zurück. Das CI kommt über
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

const schrift = require('./pdf-schrift');
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
      const S = schrift.einrichten(doc);
      const F = S.normal, FB = S.fett, T = S.text;

      /* ---- Kopf ---- */
      doc.rect(0, 0, W, 110).fill(FARBE.grund);
      doc.rect(0, 110, W, 4).fill(FARBE.orange);
      let x0 = L;
      if (logo) { try { doc.image(logo, L, 26, { fit: [58, 58] }); x0 = L + 72; } catch (e) {} }
      doc.font(FB).fontSize(20).fillColor(FARBE.creme).text("GRILL'N CHILL", x0, 36, { characterSpacing: 0.6, lineBreak: false });
      doc.font(FB).fontSize(7.5).fillColor(FARBE.orange).text('FOODTRUCK · BIELEFELD · 100 % HALAL', x0, 63, { characterSpacing: 1.6, lineBreak: false });
      doc.font(FB).fontSize(22).fillColor(FARBE.creme).text('GUTSCHEIN', 300, 40, { width: R - 300, align: 'right', characterSpacing: 1.5 });

      /* ---- Überschrift ---- */
      let y = 146;
      const titel = d.recipientName ? 'Für ' + d.recipientName : 'Dein Gutschein';
      doc.font(FB).fontSize(24).fillColor(FARBE.text).text(T(titel), L, y, { width: R - L });
      y = doc.y + 4;
      const unter = d.buyerName ? 'Von ' + d.buyerName + ', mit Burger-Grüßen' : 'Guten Appetit';
      doc.font(F).fontSize(11).fillColor(FARBE.grau).text(T(unter), L, y, { width: R - L });
      y = doc.y + 26;

      /* ---- Karte zum Ausschneiden ---- */
      const KW = 400, KH = Math.round(KW / 1.586), KX = (W - KW) / 2, KY = y;
      // Schnittlinie mit Abstand
      doc.save().lineWidth(0.8).dash(4, { space: 4 }).strokeColor(FARBE.linie)
        .roundedRect(KX - 12, KY - 12, KW + 24, KH + 24, 22).stroke().undash().restore();
      doc.font(F).fontSize(7).fillColor(FARBE.muted)
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
      doc.font(FB).fontSize(10).fillColor(FARBE.creme).text("GRILL'N CHILL", KX + P + 38, KY + P + 2, { lineBreak: false, characterSpacing: 0.6 });
      doc.font(FB).fontSize(7.5).fillColor(FARBE.orangeHell).text('GUTSCHEIN', KX + P + 38, KY + P + 15, { lineBreak: false, characterSpacing: 1.6 });

      // QR-Code oben rechts: Handykamera öffnet „Gutschein prüfen“, der Scanner im
      // Admin-Tool löst ihn am Truck ein (lib/qr.js)
      try {
        const qr = require('./qr');
        const m = qr.matrix(qr.gutscheinLink(d.code));
        const Q = 78, pad = 6, zx = KX + KW - P - Q, zy = KY + P - 6;
        const zelle = (Q - 2 * pad) / m.n;
        doc.save().roundedRect(zx, zy, Q, Q, 8).fill('#FFFFFF');
        doc.fillColor('#0C0B09');
        for (let y = 0; y < m.n; y++) {
          for (let x = 0; x < m.n; x++) {
            if (m.dunkel(x, y)) doc.rect(zx + pad + x * zelle, zy + pad + y * zelle, zelle + 0.05, zelle + 0.05).fill();
          }
        }
        doc.restore();
      } catch (e) { /* ohne QR bleibt der Code zum Eintippen */ }

      doc.font(FB).fontSize(46).fillColor(FARBE.creme).text(euro(d.amount), KX + P, KY + 66, { lineBreak: false });
      let iy = KY + 120;
      const vor = d.preset && VORSCHLAEGE[d.preset];
      if (vor) {
        doc.font(FB).fontSize(9).fillColor(FARBE.dim).text(T('Gedacht für: ' + vor.titel), KX + P, iy, { width: KW - 2 * P, lineBreak: false });
        iy += 15;
      }
      // Unterer Rand: Für, Von, Code
      const by = KY + KH - P - 22;
      // Nachricht (bis 300 Zeichen): so groß wie möglich ganz auf die Karte, mit
      // den Zeilenumbrüchen der Käuferin; passt sie nicht, steht sie gekürzt auf
      // der Karte und vollständig darunter (Block „Nachricht“)
      let nachrichtGanz = true;
      if (d.message) {
        const kw = KW - 2 * P - 4;               // der QR-Code endet oberhalb der Nachricht; 4 pt für die Neigung
        const platz = by - 8 - iy;
        const mitUmbruch = T(d.message);
        const einzeilig = T(d.message.replace(/\s*\n+\s*/g, ' '));
        const versuche = [[mitUmbruch, 9], [mitUmbruch, 8], [einzeilig, 8], [einzeilig, 7.5]];
        const treffer = versuche.find(([t, g]) => S.schraeg.hoehe(t, { breite: kw, groesse: g, zeilenabstand: 1 }) <= platz);
        nachrichtGanz = !!treffer;
        const [text, groesse] = treffer || [einzeilig, 7.5];
        S.schraeg.zeichnen(text, KX + P, iy, { breite: kw, groesse, zeilenabstand: 1, farbe: FARBE.creme, maxHoehe: platz });
      }
      const spalte = (label, wert, x, w) => {
        doc.font(FB).fontSize(6.5).fillColor(FARBE.muted).text(label, x, by, { width: w, characterSpacing: 1.2, lineBreak: false });
        doc.font(FB).fontSize(10).fillColor(FARBE.creme).text(T(wert || '-'), x, by + 10, { width: w, height: 12, ellipsis: true, lineBreak: false });
      };
      spalte('FÜR', d.recipientName, KX + P, 110);
      spalte('VON', d.buyerName, KX + P + 118, 110);
      doc.font('Courier-Bold').fontSize(11).fillColor(FARBE.orangeHell).text(d.code, KX + KW - P - 140, by + 1, { width: 140, align: 'right', characterSpacing: 1 });
      doc.font(F).fontSize(7).fillColor(FARBE.dim).text('gültig bis ' + deDatum(d.validUntil), KX + KW - P - 140, by + 15, { width: 140, align: 'right' });

      y = KY + KH + 44;

      const schritte = [
        'Auf grillnchill-foodtruck.de oder in der App „Grill\'n Chill“ bestellen.',
        'Im Warenkorb den Code ' + d.code + ' eintippen.',
        'Am Truck abholen (Gütersloher Straße 122, Bielefeld) oder liefern lassen.',
      ];
      const amTruck = 'Direkt am Truck: Gutschein oder QR-Code zeigen, wir lösen ihn an der Kasse ein.';
      const klein = 'Einlösbar online, in der App und am Truck ab einem Bestellwert von ' + euro(d.amount) + ', einmalig, bis zum ' + deDatum(d.validUntil)
        + '. Keine Barauszahlung. Ob der Gutschein noch gilt, siehst du unter grillnchill-foodtruck.de/gutscheine.'
        + ' Es gelten unsere AGB (§ 8) unter grillnchill-foodtruck.de/agb.';

      /* ---- Nachricht vollständig (wenn sie auf der Karte nicht ganz Platz hatte).
         Alles muss auf Seite 1 bleiben: Bei sehr vielen Zeilenumbrüchen wird die
         Schrift kleiner, zuletzt stehen die Zeilen mit „ / “ hintereinander. ---- */
      if (d.message && !nachrichtGanz) {
        let rest = 10 + 8 + 2 + 6 + 10;           // Überschrift und Abstände von „So löst du ihn ein“
        schritte.forEach((t) => { rest += doc.font(F).fontSize(11).heightOfString(T(t), { width: R - L - 26 }) + 8; });
        rest += doc.font(FB).fontSize(10.5).heightOfString(T(amTruck), { width: R - L });
        rest += doc.font(F).fontSize(8.5).heightOfString(T(klein), { width: R - L, lineGap: 1.5 });
        const platz = 790 - y - rest - 14 - 22;   // bis über den Fuß, abzüglich Überschrift und Abstand
        const mitUmbruch = T(d.message);
        const verkettet = T(d.message.replace(/\s*\n+\s*/g, ' / '));
        const versuche = [[mitUmbruch, 11], [mitUmbruch, 10], [mitUmbruch, 9], [verkettet, 10], [verkettet, 9]];
        const mass = (g) => ({ breite: R - L - 4, groesse: g, zeilenabstand: 2 });
        const [text, groesse] = versuche.find(([t, g]) => S.schraeg.hoehe(t, mass(g)) <= platz) || versuche[versuche.length - 1];
        doc.font(FB).fontSize(8).fillColor(FARBE.grau).text('NACHRICHT', L, y, { characterSpacing: 1.2 });
        const y0 = doc.y + 4;
        const block = S.schraeg.zeichnen(text, L, y0, { ...mass(groesse), farbe: FARBE.text, maxHoehe: Math.max(platz, 40) });
        y = y0 + block.hoehe + 22;
      }

      /* ---- So löst du ihn ein ---- */
      doc.font(FB).fontSize(8).fillColor(FARBE.grau).text('SO LÖST DU IHN EIN', L, y, { characterSpacing: 1.2 });
      y = doc.y + 8;
      schritte.forEach((s, i) => {
        doc.circle(L + 8, y + 7, 8).fill(FARBE.orange);
        doc.font(FB).fontSize(9).fillColor('#FFFFFF').text(String(i + 1), L, y + 3, { width: 16, align: 'center' });
        doc.font(F).fontSize(11).fillColor(FARBE.text).text(T(s), L + 26, y + 1, { width: R - L - 26 });
        y = doc.y + 8;
      });
      doc.font(FB).fontSize(10.5).fillColor(FARBE.text).text(T(amTruck), L, y + 2, { width: R - L });
      y = doc.y + 6;

      y += 10;
      doc.font(F).fontSize(8.5).fillColor(FARBE.grau).text(T(klein), L, y, { width: R - L, lineGap: 1.5 });

      /* ---- Fuß (unterhalb des Seitenrands, sonst bricht pdfkit auf Seite 2 um) ---- */
      doc.page.margins.bottom = 0;
      // Eine Zeile: Inter läuft breiter als Helvetica, die Größe passt sich an
      const fuss = T("Grill'n Chill Yildiz und Öztas GbR · Im Teich 9, 49152 Bad Essen · Truck: Gütersloher Straße 122, 33649 Bielefeld · info@grillnchill-foodtruck.de");
      let fg = 7.5;
      while (fg > 6 && doc.font(F).fontSize(fg).widthOfString(fuss) > R - L) fg -= 0.25;
      doc.font(F).fontSize(fg).fillColor(FARBE.muted).text(fuss, L, 800, { width: R - L, align: 'center', lineBreak: false });

      doc.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { gutscheinPdf };
