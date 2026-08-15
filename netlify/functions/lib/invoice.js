/**
 * lib/invoice.js
 * ----------------------------------------------------------------------------
 * Erzeugt aus einer Bestellung
 *   1. eine PDF-Rechnung (lesbar, zum Ablegen und Ausdrucken)
 *   2. eine XRechnung im CII-Format (UN/CEFACT Cross Industry Invoice),
 *      wie sie EN 16931 zugrunde legt – maschinenlesbar für die Buchhaltung
 *
 * Zum Stand der E-Rechnung in Deutschland:
 * Seit 01.01.2025 müssen Unternehmen strukturierte E-Rechnungen EMPFANGEN
 * können. Die Pflicht, sie auch AUSZUSTELLEN, greift gestaffelt ab 2027
 * (Umsatz über 800.000 EUR) bzw. 2028 (alle). Bis dahin sind PDF und Papier
 * mit Zustimmung des Empfängers weiterhin zulässig. Wir liefern deshalb
 * schon jetzt beides: das PDF für den Menschen, das XML für die Buchhaltung.
 *
 * Bewusst NICHT behauptet: Das PDF ist kein PDF/A-3 mit eingebettetem XML
 * (also kein vollständiges ZUGFeRD). Dafür braucht es PDF/A-Konformität samt
 * Farbprofil und XMP-Metadaten. Die beigelegte XRechnung ist aber für sich
 * genommen ein gültiges E-Rechnungsformat.
 * ----------------------------------------------------------------------------
 */

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

/* Logo für den Rechnungskopf. Liegt im Projektstamm; Netlify bündelt es über
   included_files in netlify.toml mit. Fehlt es, bleibt der Kopf schlicht –
   eine Rechnung darf daran nicht scheitern. */
function logoBuffer() {
  const kandidaten = [
    path.join(__dirname, '..', '..', '..', 'logo.png'),
    path.join(process.env.LAMBDA_TASK_ROOT || '.', 'logo.png'),
    path.join(process.cwd(), 'logo.png'),
  ];
  for (const k of kandidaten) {
    try { if (fs.existsSync(k)) return fs.readFileSync(k); } catch (e) {}
  }
  return null;
}

const VERKAEUFER = {
  name: "Grill'n Chill Yildiz und Öztas GbR",
  strasse: 'Im Teich 9',
  plz: '49152',
  ort: 'Bad Essen',
  land: 'DE',
  ustId: 'DE459954473',
  mail: 'info@grillnchill-foodtruck.de',
  tel: '+49 151 18 54 06 04',
};

const z = (n) => Number(n) || 0;
const eur = (n) => z(n).toFixed(2).replace('.', ',') + ' €';
const num = (n) => z(n).toFixed(2);

/* pdfkit-Standardschriften decken Latin-1 ab. Zeichen darüber hinaus
   (etwa das türkische Ş) würden sonst als Kästchen erscheinen. */
function latin1(s) {
  return String(s == null ? '' : s)
    .replace(/[ŞŞ]/g, 'S').replace(/[şş]/g, 's')
    .replace(/Ğ/g, 'G').replace(/ğ/g, 'g')
    .replace(/İ/g, 'I').replace(/ı/g, 'i')
    .replace(/Ç/g, 'C').replace(/ç/g, 'c')
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/–/g, '-').replace(/—/g, '-');
}

function zahlungsText(order) {
  if (order.payment !== 'sumup') return 'Vor Ort (bar oder Karte)';
  const c = order.card || {};
  const marke = c.type ? String(c.type).charAt(0) + String(c.type).slice(1).toLowerCase() : null;
  if (marke && c.last4) return `Online – ${marke} •••• ${c.last4}`;
  if (marke) return `Online – ${marke}`;
  return 'Online bezahlt (SumUp)';
}

/* --------------------------------------------------------------------------
   PDF
   -------------------------------------------------------------------------- */
function buildInvoicePdf(order) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      const teile = [];
      doc.on('data', (d) => teile.push(d));
      doc.on('end', () => resolve(Buffer.concat(teile)));
      doc.on('error', reject);

      const L = 50, R = 545, B = R - L;
      const grau = '#666666', dunkel = '#1A1A1A', linie = '#DDDDDD';

      // Kopf: Logo links, daneben Titel und Anschrift
      const logo = logoBuffer();
      let kopfX = L;
      if (logo) {
        try { doc.image(logo, L, 46, { fit: [54, 54] }); kopfX = L + 66; } catch (e) {}
      }
      doc.fillColor(dunkel).font('Helvetica-Bold').fontSize(20).text('Rechnung', kopfX, 50);
      doc.font('Helvetica').fontSize(9).fillColor(grau)
        .text(latin1(VERKAEUFER.name), kopfX, 78)
        .text(`${latin1(VERKAEUFER.strasse)} · ${VERKAEUFER.plz} ${latin1(VERKAEUFER.ort)}`, kopfX)
        .text(`USt-IdNr. ${VERKAEUFER.ustId}`, kopfX);

      // Rechnungsdaten rechts
      const rechtsX = 350;
      doc.fontSize(9).fillColor(grau);
      const zeile = (label, wert, y) => {
        doc.font('Helvetica').text(label, rechtsX, y, { width: 95 });
        doc.font('Helvetica-Bold').fillColor(dunkel).text(latin1(wert), rechtsX + 100, y, { width: 95, align: 'right' });
        doc.fillColor(grau);
      };
      zeile('Rechnungsnummer', order.invoiceNo || '', 50);
      zeile('Rechnungsdatum', order.invoiceDate || '', 63);
      zeile('Leistungsdatum', order.serviceDate || order.invoiceDate || '', 76);
      zeile('Bestellung', order.reference || '', 89);

      // Empfänger
      let y = 130;
      doc.font('Helvetica').fontSize(8).fillColor(grau).text('RECHNUNGSEMPFÄNGER', L, y);
      y += 13;
      const a = order.invoiceAddress || {};
      doc.font('Helvetica-Bold').fontSize(11).fillColor(dunkel).text(latin1(order.company || ''), L, y);
      y += 15;
      doc.font('Helvetica').fontSize(10).fillColor(dunkel);
      if (a.street) { doc.text(latin1(a.street), L, y); y += 13; }
      if (a.zip || a.city) { doc.text(latin1(`${a.zip || ''} ${a.city || ''}`.trim()), L, y); y += 13; }

      // Positionen
      y += 22;
      doc.moveTo(L, y).lineTo(R, y).strokeColor(linie).stroke();
      y += 8;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(grau);
      doc.text('POSITION', L, y);
      doc.text('MENGE', 330, y, { width: 45, align: 'right' });
      doc.text('EINZEL', 385, y, { width: 65, align: 'right' });
      doc.text('BETRAG', 460, y, { width: 85, align: 'right' });
      y += 14;
      doc.moveTo(L, y).lineTo(R, y).strokeColor(linie).stroke();
      y += 9;

      doc.font('Helvetica').fontSize(9.5).fillColor(dunkel);
      (order.items || []).forEach((i) => {
        const einzel = z(i.price) || (z(i.total) / Math.max(1, i.qty));
        const h = doc.heightOfString(latin1(i.name), { width: 270 });
        doc.text(latin1(i.name), L, y, { width: 270 });
        doc.text(String(i.qty), 330, y, { width: 45, align: 'right' });
        doc.text(eur(einzel), 385, y, { width: 65, align: 'right' });
        doc.text(eur(i.total), 460, y, { width: 85, align: 'right' });
        y += Math.max(h, 12) + 6;
        if (y > 690) { doc.addPage(); y = 60; }
      });

      // Summen
      y += 4;
      doc.moveTo(300, y).lineTo(R, y).strokeColor(linie).stroke();
      y += 9;
      const summe = (label, wert, fett, farbe) => {
        doc.font(fett ? 'Helvetica-Bold' : 'Helvetica').fontSize(fett ? 11 : 9.5)
          .fillColor(farbe || (fett ? dunkel : grau));
        const txt = latin1(label);
        // Zeilenhoehe messen statt fest weiterzuruecken: lange Gutscheincodes
        // brechen um, sonst laeuft die zweite Zeile in die naechste Position.
        const hoehe = doc.heightOfString(txt, { width: 150 });
        doc.text(txt, 300, y, { width: 150 });
        doc.text(wert, 460, y, { width: 85, align: 'right' });
        y += Math.max(hoehe, fett ? 14 : 11) + (fett ? 4 : 3);
      };
      summe('Zwischensumme', eur(order.subtotal));
      if (z(order.discount) > 0) {
        const code = (order.promo && order.promo.code) || order.voucherCode;
        summe(code ? `Rabatt (Code ${code})` : 'Rabatt', '- ' + eur(order.discount), false, '#3D6B34');
      }
      if (z(order.loyaltyDiscount) > 0) summe('Treuebonus', '- ' + eur(order.loyaltyDiscount), false, '#3D6B34');
      if (z(order.deliveryFee) > 0) summe('Liefergebühr', eur(order.deliveryFee));

      (order.vat || []).forEach((v) => {
        const satz = String(v.satz).replace('.', ',');
        summe(`Netto ${satz} %`, eur(v.netto));
        summe(`zzgl. ${satz} % USt.`, eur(v.steuer));
      });
      if (z(order.tip) > 0) summe('Trinkgeld (freiwillig, 0 % USt.)', eur(order.tip));

      y += 3;
      doc.moveTo(300, y).lineTo(R, y).strokeColor('#999999').stroke();
      y += 9;
      summe('Gesamtbetrag', eur(order.total), true);

      // Fuß
      y += 14;
      doc.font('Helvetica').fontSize(9).fillColor(grau);
      doc.text(`Zahlung: ${latin1(zahlungsText(order))}`, L, y);
      y += 13;
      doc.text(order.mode === 'delivery' ? 'Lieferung' : 'Abholung am Foodtruck', L, y);
      if (z(order.total) <= 0) {
        y += 13;
        doc.text('Der Rechnungsbetrag ist durch die ausgewiesenen Abzüge vollständig ausgeglichen.', L, y, { width: B });
      }
      y += 26;
      doc.fontSize(8).fillColor('#999999')
        .text(`${latin1(VERKAEUFER.name)} · ${latin1(VERKAEUFER.strasse)} · ${VERKAEUFER.plz} ${latin1(VERKAEUFER.ort)} · ${VERKAEUFER.mail} · ${VERKAEUFER.tel}`,
          L, y, { width: B });

      doc.end();
    } catch (e) { reject(e); }
  });
}

/* --------------------------------------------------------------------------
   XRechnung / CII (EN 16931)
   -------------------------------------------------------------------------- */
const x = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/* Datum als JJJJMMTT, wie das Format es verlangt (Code 102). */
function ymd(deDatum) {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(deDatum || ''));
  if (m) return m[3] + m[2] + m[1];
  const d = new Date();
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}

function buildInvoiceXml(order) {
  const a = order.invoiceAddress || {};
  const netto = (order.vat || []).reduce((n, v) => n + z(v.netto), 0);
  const steuer = (order.vat || []).reduce((n, v) => n + z(v.steuer), 0);

  const positionen = (order.items || []).map((i, idx) => {
    const einzel = z(i.price) || (z(i.total) / Math.max(1, i.qty));
    // Getraenke 19 %, alles Uebrige 7 % – dieselbe Zuordnung wie im Shop
    const satz = (order.vat || []).length === 1 ? z(order.vat[0].satz) : 7;
    return `    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>${idx + 1}</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct><ram:Name>${x(i.name)}</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice><ram:ChargeAmount>${num(einzel / (1 + satz / 100))}</ram:ChargeAmount></ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="H87">${z(i.qty)}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>S</ram:CategoryCode>
          <ram:RateApplicablePercent>${num(satz)}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${num(z(i.total) / (1 + satz / 100))}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`;
  }).join('\n');

  const steuerBloecke = (order.vat || []).map(v => `      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${num(v.steuer)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount>${num(v.netto)}</ram:BasisAmount>
        <ram:CategoryCode>S</ram:CategoryCode>
        <ram:RateApplicablePercent>${num(v.satz)}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${x(order.invoiceNo)}</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime><udt:DateTimeString format="102">${ymd(order.invoiceDate)}</udt:DateTimeString></ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
${positionen}
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>${x(VERKAEUFER.name)}</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${x(VERKAEUFER.plz)}</ram:PostcodeCode>
          <ram:LineOne>${x(VERKAEUFER.strasse)}</ram:LineOne>
          <ram:CityName>${x(VERKAEUFER.ort)}</ram:CityName>
          <ram:CountryID>${x(VERKAEUFER.land)}</ram:CountryID>
        </ram:PostalTradeAddress>
        <ram:SpecifiedTaxRegistration>
          <ram:ID schemeID="VA">${x(VERKAEUFER.ustId)}</ram:ID>
        </ram:SpecifiedTaxRegistration>
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>${x(order.company)}</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${x(a.zip)}</ram:PostcodeCode>
          <ram:LineOne>${x(a.street)}</ram:LineOne>
          <ram:CityName>${x(a.city)}</ram:CityName>
          <ram:CountryID>DE</ram:CountryID>
        </ram:PostalTradeAddress>
      </ram:BuyerTradeParty>
      <ram:BuyerOrderReferencedDocument><ram:IssuerAssignedID>${x(order.reference)}</ram:IssuerAssignedID></ram:BuyerOrderReferencedDocument>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery>
      <ram:ActualDeliverySupplyChainEvent>
        <ram:OccurrenceDateTime><udt:DateTimeString format="102">${ymd(order.serviceDate || order.invoiceDate)}</udt:DateTimeString></ram:OccurrenceDateTime>
      </ram:ActualDeliverySupplyChainEvent>
    </ram:ApplicableHeaderTradeDelivery>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>${order.payment === 'sumup' ? '68' : '10'}</ram:TypeCode>
        <ram:Information>${x(zahlungsText(order))}</ram:Information>
      </ram:SpecifiedTradeSettlementPaymentMeans>
${steuerBloecke}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${num(netto)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${num(netto)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">${num(steuer)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${num(order.total)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${num(order.total)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;
}

module.exports = { buildInvoicePdf, buildInvoiceXml, zahlungsText };
