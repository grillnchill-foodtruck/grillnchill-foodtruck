/**
 * lib/angebot-pdf.js
 * ----------------------------------------------------------------------------
 * Catering-Angebot als PDF im Grill'n-Chill-CI (pdfkit, wie lib/invoice.js).
 *
 * Kopf dunkel mit Logo und Schriftzug, Akzent in Orange, Positionen auf
 * weißem Grund (druckt sauber), Summe, Anzahlung, kurze Bedingungen, Kontakt.
 * Das PDF ist immer Deutsch.
 *
 * Schrift: Inter, eingebettet über lib/pdf-schrift.js (Latin Extended und
 * Kyrillisch), damit Namen und Adressen so im PDF stehen, wie die Kundin sie
 * geschrieben hat. Fehlt die Schrift, fällt alles auf Helvetica und die
 * Latin-1-Ersetzungen zurück. Bowlby One wurde geprüft und verworfen
 * (fontkit stürzt bei Umlauten ab). Das CI kommt über Logo, Farben und den
 * dunklen Kopf.
 * ----------------------------------------------------------------------------
 */

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const schrift = require('./pdf-schrift');
const latin1 = schrift.latin1;

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
      const S = schrift.einrichten(doc);
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
      doc.font(S.fett).fontSize(20).fillColor(FARBE.creme).text("GRILL'N CHILL", x0, 40, { characterSpacing: 0.6, lineBreak: false });
      doc.font(S.fett).fontSize(7.5).fillColor(FARBE.orange)
        .text('FOODTRUCK CATERING · BIELEFELD', x0, 68, { characterSpacing: 1.6, lineBreak: false });
      doc.font(S.normal).fontSize(7.5).fillColor(FARBE.cremeDim)
        .text('100 % halal · HCG-zertifiziert', x0, 81, { lineBreak: false });
      doc.font(S.fett).fontSize(26).fillColor(FARBE.creme).text('ANGEBOT', 300, 36, { width: R - 300, align: 'right', characterSpacing: 1.5 });
      doc.font(S.fett).fontSize(11).fillColor(FARBE.orange).text(S.text(a.nummer), 300, 72, { width: R - 300, align: 'right' });

      /* ---- Empfänger und Eckdaten ---- */
      let y = 150;
      doc.font(S.fett).fontSize(7.5).fillColor(FARBE.grau).text('FÜR', L, y, { characterSpacing: 1.2 });
      let ly = y + 13;
      // Online unterschrieben: die Rechnungsadresse der angenommenen Fassung, auch wenn der Admin sie später geändert hat
      const angenommen = a.status === 'angenommen' || a.status === 'bezahlt';
      const fassung = angenommen && a.annahme && a.annahme.unterschrift && a.annahme.fassung;
      const k = fassung && fassung.kunde ? { ...(a.kunde || {}), ...fassung.kunde } : (a.kunde || {});
      // Zeichen ohne Glyphe (etwa Arabisch): statt eines leeren Felds der Hinweis
      const UN = require('./unterschrift');
      const zeigen = (wert, font, groesse, farbe) => {
        if (!wert) { doc.y = ly - 2; return; }
        if (UN.namePdf(S, wert).vollstaendig) doc.font(font).fontSize(groesse).fillColor(farbe).text(S.text(wert), L, ly, { width: 240 });
        else doc.font(S.normal).fontSize(8).fillColor(FARBE.grau).text(UN.NAME_HINWEIS, L, ly, { width: 240 });
      };
      if (k.firma) { zeigen(k.firma, S.fett, 11, FARBE.text); ly = doc.y + 1; }
      zeigen(k.name || '', k.firma ? S.normal : S.fett, k.firma ? 10 : 11, FARBE.text);
      ly = doc.y + 2;
      doc.font(S.normal).fontSize(9).fillColor(FARBE.text);
      // Rechnungsadresse (aus der Annahme-Seite, bei Online-Unterschrift in der angenommenen Fassung)
      if (k.strasse) { doc.text(S.text(k.strasse), L, ly, { width: 240 }); ly = doc.y; }
      if (k.plz || k.ort) { doc.text(S.text([k.plz, k.ort].filter(Boolean).join(' ')), L, ly, { width: 240 }); ly = doc.y; }
      if (k.ustId) { doc.text(S.text('USt-IdNr. ' + k.ustId), L, ly, { width: 240 }); ly = doc.y; }
      if (k.strasse || k.plz || k.ort || k.ustId) ly += 2;
      doc.fillColor(FARBE.grau);
      if (k.email) { doc.text(S.text(k.email), L, ly, { width: 240 }); ly = doc.y; }
      if (k.telefon) { doc.text(S.text(k.telefon), L, ly, { width: 240 }); ly = doc.y; }

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
        doc.font(S.normal).fontSize(8.5).fillColor(FARBE.grau).text(S.text(l), rx, ry, { width: 85 });
        doc.font(S.fett).fontSize(8.5).fillColor(FARBE.text);
        const hgt = doc.heightOfString(S.text(w), { width: R - rx - 90 });
        doc.text(S.text(w), rx + 90, ry, { width: R - rx - 90, align: 'right' });
        ry += Math.max(hgt, 10) + 3.5;
      });
      y = Math.max(ly, ry) + 18;

      doc.font(S.normal).fontSize(10).fillColor(FARBE.text)
        .text(S.text('Danke für deine Anfrage. Gern kommen wir mit dem Truck zu deinem Event und grillen frisch vor Ort. Das ist unser Angebot:'), L, y, { width: B });
      y = doc.y + 14;

      /* ---- Positionen ---- */
      const kopfZeile = () => {
        doc.rect(L, y, B, 20).fill(FARBE.zart);
        doc.font(S.fett).fontSize(7.5).fillColor(FARBE.grau);
        doc.text('LEISTUNG', L + 8, y + 7, { characterSpacing: 0.8 });
        doc.text('MENGE', 318, y + 7, { width: 50, align: 'right', characterSpacing: 0.8 });
        doc.text('EINZELPREIS', 372, y + 7, { width: 80, align: 'right', characterSpacing: 0.8 });
        doc.text('BETRAG', 455, y + 7, { width: R - 455 - 8, align: 'right', characterSpacing: 0.8 });
        y += 26;
      };
      kopfZeile();
      const zeilen = (a.zeilen || []).filter((z) => Number(z.menge) > 0);
      zeilen.forEach((z) => {
        doc.font(S.normal).fontSize(9.5);
        const t = S.text(z.text);
        const hgt = doc.heightOfString(t, { width: 255 });
        if (y + hgt > UNTEN - 40) { doc.addPage(); y = 60; kopfZeile(); }
        doc.font(S.normal).fontSize(9.5).fillColor(FARBE.text).text(t, L + 8, y, { width: 255 });
        doc.text(menge(z.menge), 318, y, { width: 50, align: 'right' });
        doc.text(Number(z.einzel) > 0 ? eur(z.einzel) : 'inklusive', 372, y, { width: 80, align: 'right' });
        doc.font(S.fett).text(Number(z.betrag) > 0 ? eur(z.betrag) : '-', 455, y, { width: R - 455 - 8, align: 'right' });
        y += Math.max(hgt, 12) + 7;
        doc.moveTo(L, y - 3.5).lineTo(R, y - 3.5).lineWidth(0.6).strokeColor(FARBE.linie).stroke();
      });

      /* ---- Summen ---- */
      if (y > UNTEN - 150) { doc.addPage(); y = 60; }
      y += 6;
      const sx = 318;
      const summe = (label, wert, farbe) => {
        doc.font(S.normal).fontSize(9.5).fillColor(farbe || FARBE.grau).text(S.text(label), sx, y, { width: 140 });
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
      doc.font(S.fett).fontSize(8).fillColor(FARBE.cremeDim).text('GESAMTBETRAG', sx, y + 13, { characterSpacing: 1 });
      const gesamt = eur(a.gesamt);
      doc.font(S.fett).fontSize(15).fillColor(FARBE.creme).text(gesamt, 400, y + 9, { width: R - 400 - 8, align: 'right' });
      y += 40;
      // Enthaltene USt. je Satz (Pakete 7 %, übrige Leistungen 19 %, lib/catering-rechnung.js)
      let steuerText = 'Alle Preise sind Endpreise inklusive gesetzlicher MwSt.';
      try {
        const RE = require('./catering-rechnung');
        const vat = RE.vatAus(RE.aufteilung(a.zeilen, a.rabatt).jeSatzC);
        if (vat.length) steuerText = 'Endpreise. Enthaltene USt.: ' + vat.map((v) => v.satz + ' % ' + eur(v.steuer) + ' (netto ' + eur(v.netto) + ')').join(', ') + '.';
      } catch (e) {}
      doc.font(S.normal).fontSize(8).fillColor(FARBE.grau)
        .text(S.text(steuerText), sx - 8, y, { width: R - sx + 8, align: 'right' });
      y = doc.y + 6;
      if (Number(a.anzahlung) > 0) {
        doc.font(S.fett).fontSize(9.5).fillColor(FARBE.orangeDunkel)
          .text('Anzahlung ' + a.anzahlungProzent + ' %', sx, y, { width: 135 });
        doc.text(eur(a.anzahlung), 455, y, { width: R - 455 - 8, align: 'right' });
        y += 15;
        doc.font(S.normal).fontSize(9.5).fillColor(FARBE.grau).text('Rest nach dem Event', sx, y, { width: 135 });
        doc.text(eur(a.rest), 455, y, { width: R - 455 - 8, align: 'right' });
        y += 15;
      }

      /* ---- Hinweis von Kubi ---- */
      if (a.hinweis) {
        y += 10;
        const t = S.text(a.hinweis);
        doc.font(S.normal).fontSize(9.5);
        const hgt = doc.heightOfString(t, { width: B - 24 });
        if (y + hgt + 30 > UNTEN) { doc.addPage(); y = 60; }
        doc.rect(L, y, 3, hgt + 24).fill(FARBE.orange);
        doc.font(S.fett).fontSize(7.5).fillColor(FARBE.grau).text('HINWEIS', L + 14, y + 4, { characterSpacing: 1.2 });
        doc.font(S.normal).fontSize(9.5).fillColor(FARBE.text).text(t, L + 14, y + 17, { width: B - 24 });
        y = doc.y + 12;
      }

      /* ---- Bedingungen und Annahme ---- */
      const liste = bedingungen(a, e);
      doc.font(S.normal).fontSize(8.5);
      const unterschrift = angenommen && a.annahme && a.annahme.unterschrift;
      const hoehe = liste.reduce((n, l) => n + doc.heightOfString(S.text(l), { width: B - 14 }) + 3, 0) + (unterschrift ? 160 : 70);
      if (y + hoehe > UNTEN) { doc.addPage(); y = 60; }
      y += 8;
      doc.font(S.fett).fontSize(7.5).fillColor(FARBE.grau).text('BEDINGUNGEN', L, y, { characterSpacing: 1.2 });
      y += 13;
      liste.forEach((l) => {
        doc.circle(L + 3, y + 4.2, 1.6).fill(FARBE.orange);
        doc.font(S.normal).fontSize(8.5).fillColor(FARBE.text).text(S.text(l), L + 12, y, { width: B - 14 });
        y = doc.y + 3;
      });
      y += 8;
      if (unterschrift) {
        const U = require('./unterschrift');
        doc.font(S.fett).fontSize(7.5).fillColor(FARBE.grau).text('ANGENOMMEN UND UNTERSCHRIEBEN', L, y, { characterSpacing: 1.2 });
        y += 13;
        const nm = U.namePdf(S, unterschrift.name);
        doc.font(S.normal).fontSize(9).fillColor(FARBE.text)
          .text(S.text('Online angenommen am ' + U.zeitText(unterschrift.am) + (nm.vollstaendig ? ' von ' + nm.text : '') + (unterschrift.getippt ? ' (Name getippt)' : '') + '.'
            + (nm.vollstaendig || unterschrift.getippt ? '' : ' ' + U.NAME_HINWEIS)), L, y, { width: B });
        y = doc.y + 6;
        doc.rect(L, y, 250, 80).lineWidth(0.6).strokeColor(FARBE.linie).stroke();
        U.zeichnenPdf(doc, unterschrift, L + 8, y + 6, 234, 68, { latin1, S });
        y += 88;
        doc.font(S.normal).fontSize(7.5).fillColor(FARBE.grau)
          .text(S.text('Prüfsumme des angenommenen Angebots (SHA-256): ' + U.hashKurz(unterschrift.angebotHash)), L, y, { width: B });
      } else if (angenommen) {
        // Angenommen ohne Unterschrift (Telefon, bar oder vor der Online-Unterschrift)
        const am = a.angenommenAm ? deDatum(heute(new Date(a.angenommenAm))) : '';
        const tel = a.annahme && a.annahme.weg === 'telefon';
        doc.font(S.fett).fontSize(9).fillColor(FARBE.text)
          .text(S.text('Angenommen' + (am ? ' am ' + am : '') + (tel ? ' (telefonisch)' : '') + '.'), L, y, { width: B });
      } else {
        doc.font(S.fett).fontSize(9).fillColor(FARBE.text).text('So nimmst du an', L, y);
        y = doc.y + 2;
        doc.font(S.normal).fontSize(8.5).fillColor(FARBE.text)
          .text(S.text('Öffne den Link in unserer E-Mail, unterschreib im Feld und tippe auf „Angebot annehmen“. Oder ruf uns an: ' + VERKAEUFER.tel + '.'), L, y, { width: B });
      }

      /* ---- Fuß auf jeder Seite ---- */
      const seiten = doc.bufferedPageRange();
      for (let i = seiten.start; i < seiten.start + seiten.count; i++) {
        doc.switchToPage(i);
        doc.page.margins.bottom = 0;   // sonst legt pdfkit für den Fuß eine neue Seite an
        doc.moveTo(L, 792).lineTo(R, 792).lineWidth(0.6).strokeColor(FARBE.linie).stroke();
        doc.font(S.normal).fontSize(7).fillColor(FARBE.grau)
          .text(S.text(VERKAEUFER.name + ' · ' + VERKAEUFER.strasse + ' · ' + VERKAEUFER.plz + ' ' + VERKAEUFER.ort + ' · USt-IdNr. ' + VERKAEUFER.ustId),
            L, 798, { width: B, align: 'center', lineBreak: false })
          .text(S.text('Truck: ' + VERKAEUFER.truck + ' · ' + VERKAEUFER.tel + ' · ' + VERKAEUFER.mail + ' · ' + VERKAEUFER.web),
            L, 808, { width: B, align: 'center', lineBreak: false });
      }
      doc.end();
    } catch (err) { reject(err); }
  });
}

module.exports = { angebotPdf, latin1 };
