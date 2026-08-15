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

const r2 = (n) => Math.round((z(n) + Number.EPSILON) * 100) / 100;

/* --------------------------------------------------------------------------
   Rechenwerk der XRechnung
   --------------------------------------------------------------------------
   EN 16931 prüft die Beträge gegeneinander; ein Dokument, dessen Summen nicht
   aufgehen, wird von der Buchhaltung des Empfängers abgewiesen. Zu erfüllen:

     BR-CO-10  Zeilensumme      = Summe aller Positionen
     BR-CO-13  Bemessung        = Zeilensumme − Nachlässe + Zuschläge
     BR-CO-15  Endbetrag        = Bemessung + Steuerbetrag
     BR-S-08   je Steuersatz    = Summe der Positionen dieses Satzes
                                  (abzgl. Nachlässe, zzgl. Zuschläge)

   Drei Dinge standen dem im Weg:

   1. Jede Position bekam pauschal 7 %. Ein Menü ist aber beides zugleich –
      Speise 7 %, Getränk 19 %. Deshalb liefert der Shop je Position den
      Bruttoanteil je Satz mit (vatSplit); eine Position mit zwei Sätzen wird
      hier auf ZWEI Zeilen aufgeteilt, denn eine Zeile trägt genau einen Satz.

   2. Rabatt und Liefergebühr steckten nur in der Steueraufstellung, nicht in
      den Zeilen. Sie erscheinen jetzt als Nachlass bzw. Zuschlag auf
      Dokumentebene, je Steuersatz getrennt.

   3. Das Trinkgeld war im Endbetrag enthalten, aber in keiner Bemessungs-
      grundlage – damit ging BR-CO-15 nicht auf. Es steht jetzt als eigener
      Zuschlag ohne Steuer.

   Der Nachlass wird zum Schluss aus der Differenz abgeleitet statt frei
   gerundet. So bleibt die Kette auch dann exakt, wenn sich beim Runden der
   einzelnen Zeilen Cent-Reste ergeben.
   -------------------------------------------------------------------------- */
function rechneXml(order) {
  const saetze = (order.vat || []).map(v => z(v.satz));
  const zeilen = [];
  const bruttoJeSatz = {};   // Warenwert je Satz, vor Rabatt

  (order.items || []).forEach((i) => {
    const gesamt = z(i.total);
    // Anteile je Satz. Fehlt die Angabe (Altbestand), wird der Betrag im
    // Verhaeltnis der Steueraufstellung verteilt – nie pauschal auf 7 %.
    let anteile = i.vatSplit && typeof i.vatSplit === 'object' ? i.vatSplit : null;
    if (!anteile) {
      if (saetze.length === 1) anteile = { [saetze[0]]: gesamt };
      else {
        const summe = (order.vat || []).reduce((n, v) => n + z(v.brutto), 0);
        anteile = {};
        (order.vat || []).forEach(v => {
          anteile[z(v.satz)] = summe > 0 ? gesamt * (z(v.brutto) / summe) : 0;
        });
      }
    }
    Object.keys(anteile).forEach(k => {
      const satz = z(k);
      const brutto = z(anteile[k]);
      if (brutto <= 0) return;
      const netto = r2(brutto / (1 + satz / 100));
      bruttoJeSatz[satz] = (bruttoJeSatz[satz] || 0) + brutto;
      // Bei geteilten Positionen sagt der Zusatz, welcher Teil gemeint ist –
      // sonst stuende derselbe Name zweimal mit verschiedenen Saetzen da.
      const geteilt = Object.keys(anteile).filter(kk => z(anteile[kk]) > 0).length > 1;
      zeilen.push({
        name: geteilt ? `${i.name} (${satz === 19 ? 'Getränkeanteil' : 'Speisenanteil'})` : i.name,
        qty: z(i.qty) || 1, satz, netto,
      });
    });
  });

  const zeilenSumme = r2(zeilen.reduce((n, p) => n + p.netto, 0));
  const warenBrutto = Object.values(bruttoJeSatz).reduce((n, b) => n + b, 0);
  const gebuehr = z(order.deliveryFee);
  const trinkgeld = z(order.tip);

  // Liefergebuehr als Zuschlag, je Satz im Verhaeltnis der Warenanteile –
  // dieselbe Verteilung, die der Shop fuer die Steueraufstellung nutzt.
  const zuschlaege = [];
  const nachlaesse = [];
  (order.vat || []).forEach(v => {
    const satz = z(v.satz);
    const anteil = warenBrutto > 0 ? (bruttoJeSatz[satz] || 0) / warenBrutto : 0;
    const zuschlag = gebuehr > 0 ? r2((gebuehr * anteil) / (1 + satz / 100)) : 0;
    if (zuschlag > 0) zuschlaege.push({ satz, betrag: zuschlag, grund: 'Liefergebühr' });

    // Ableiten statt runden: was uebrig bleibt, ist der Nachlass.
    const zeilenSatz = r2(zeilen.filter(p => p.satz === satz).reduce((n, p) => n + p.netto, 0));
    const rest = r2(zeilenSatz + zuschlag - z(v.netto));
    if (rest > 0) nachlaesse.push({ satz, betrag: rest, grund: 'Rabatt' });
    else if (rest < 0) zuschlaege.push({ satz, betrag: r2(-rest), grund: 'Rundungsausgleich' });
  });

  const nachlassSumme = r2(nachlaesse.reduce((n, p) => n + p.betrag, 0));
  const zuschlagSumme = r2(zuschlaege.reduce((n, p) => n + p.betrag, 0) + trinkgeld);
  const bemessung = r2(zeilenSumme - nachlassSumme + zuschlagSumme);
  const steuer = r2((order.vat || []).reduce((n, v) => n + z(v.steuer), 0));
  const endbetrag = r2(bemessung + steuer);

  // Weicht das vom gespeicherten Gesamtbetrag ab, stimmen die Ausgangsdaten
  // nicht. Wir melden es, liefern aber die in sich schluessige Rechnung.
  if (Math.abs(endbetrag - z(order.total)) > 0.02) {
    console.error('XRechnung: Endbetrag', endbetrag, 'weicht von total', z(order.total),
                  'ab –', order.invoiceNo);
  }

  return { zeilen, zeilenSumme, nachlaesse, zuschlaege, nachlassSumme, zuschlagSumme,
           bemessung, steuer, endbetrag, trinkgeld };
}

function buildInvoiceXml(order) {
  const a = order.invoiceAddress || {};
  const b = rechneXml(order);

  const positionen = b.zeilen.map((p, idx) => `    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument><ram:LineID>${idx + 1}</ram:LineID></ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct><ram:Name>${x(p.name)}</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice><ram:ChargeAmount>${num(p.netto / Math.max(1, p.qty))}</ram:ChargeAmount></ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="H87">${p.qty}</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode><ram:CategoryCode>S</ram:CategoryCode>
          <ram:RateApplicablePercent>${num(p.satz)}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${num(p.netto)}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`).join('\n');

  const steuerBloecke = (order.vat || []).map(v => `      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${num(v.steuer)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount>${num(v.netto)}</ram:BasisAmount>
        <ram:CategoryCode>S</ram:CategoryCode>
        <ram:RateApplicablePercent>${num(v.satz)}</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>`).join('\n')
    // Trinkgeld: freiwillig gezahlt, kein Entgelt fuer eine Leistung – daher
    // ohne Steuer ausgewiesen, wie im Shop angezeigt. Ob das im Einzelfall so
    // zu behandeln ist, gehoert vom Steuerberater gegengezeichnet.
    + (b.trinkgeld > 0 ? `\n      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>0.00</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:ExemptionReason>Freiwilliges Trinkgeld – kein Entgelt für eine Leistung</ram:ExemptionReason>
        <ram:BasisAmount>${num(b.trinkgeld)}</ram:BasisAmount>
        <ram:CategoryCode>E</ram:CategoryCode>
        <ram:RateApplicablePercent>0.00</ram:RateApplicablePercent>
      </ram:ApplicableTradeTax>` : '');

  const abschlaege = [
    ...b.nachlaesse.map(p => ({ ...p, zuschlag: false, kat: 'S' })),
    ...b.zuschlaege.map(p => ({ ...p, zuschlag: true, kat: 'S' })),
    ...(b.trinkgeld > 0
      ? [{ satz: 0, betrag: b.trinkgeld, grund: 'Trinkgeld', zuschlag: true, kat: 'E' }] : []),
  ].map(p => `      <ram:SpecifiedTradeAllowanceCharge>
        <ram:ChargeIndicator><udt:Indicator>${p.zuschlag}</udt:Indicator></ram:ChargeIndicator>
        <ram:ActualAmount>${num(p.betrag)}</ram:ActualAmount>
        <ram:Reason>${x(p.grund)}</ram:Reason>
        <ram:CategoryTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>${p.kat}</ram:CategoryCode>
          <ram:RateApplicablePercent>${num(p.satz)}</ram:RateApplicablePercent>
        </ram:CategoryTradeTax>
      </ram:SpecifiedTradeAllowanceCharge>`).join('\n');

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
${abschlaege}
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${num(b.zeilenSumme)}</ram:LineTotalAmount>
        <ram:ChargeTotalAmount>${num(b.zuschlagSumme)}</ram:ChargeTotalAmount>
        <ram:AllowanceTotalAmount>${num(b.nachlassSumme)}</ram:AllowanceTotalAmount>
        <ram:TaxBasisTotalAmount>${num(b.bemessung)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="EUR">${num(b.steuer)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${num(b.endbetrag)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${num(b.endbetrag)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;
}

module.exports = { buildInvoicePdf, buildInvoiceXml, zahlungsText };

/* --------------------------------------------------------------------------
   Nachtragen fehlender Felder aus dem Bestellarchiv
   --------------------------------------------------------------------------
   Rechnungen, die vor der Erweiterung des Datensatzes entstanden sind, haben
   weder Zwischensumme noch Rabatt oder Gutscheincode gespeichert. Beim
   Neuerzeugen des PDFs fehlten dadurch genau diese Zeilen.
   Das Bestellarchiv (Store "orders", Schluessel o:<Referenz>) haelt die
   vollstaendige Bestellung – von dort laesst sich das nachziehen, solange die
   Bestellung noch nicht nach 90 Tagen geloescht wurde.
   -------------------------------------------------------------------------- */
async function ergaenzeAusBestellung(rec, ordersStore) {
  // Nur eingreifen, wenn wirklich etwas fehlt
  if (!rec || rec.subtotal != null || !rec.reference || !ordersStore) return rec;
  try {
    const key = 'o:' + String(rec.reference).replace(/[^A-Za-z0-9-]/g, '').slice(0, 60);
    const eintrag = await ordersStore.get(key, { type: 'json' });
    const o = eintrag && eintrag.order;
    if (!o) return rec;
    const nimm = (feld, ersatz) => (rec[feld] != null ? rec[feld] : (o[feld] != null ? o[feld] : ersatz));
    return {
      ...rec,
      subtotal: nimm('subtotal', null),
      discount: nimm('discount', 0),
      loyaltyDiscount: nimm('loyaltyDiscount', 0),
      deliveryFee: nimm('deliveryFee', 0),
      promo: nimm('promo', null),
      voucherCode: nimm('voucherCode', null),
      card: nimm('card', null),
      tip: nimm('tip', 0),
    };
  } catch (e) { return rec; }
}

module.exports.ergaenzeAusBestellung = ergaenzeAusBestellung;
