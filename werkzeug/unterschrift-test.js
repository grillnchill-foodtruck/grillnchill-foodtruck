#!/usr/bin/env node
/**
 * werkzeug/unterschrift-test.js
 * Unterschrift bei der Online-Annahme: Prüfregeln, Prüfsumme, Zeittext, PDF-Zeichnung.
 *   node werkzeug/unterschrift-test.js
 */
const path = require('path');
const PDFDocument = require('pdfkit');
const U = require(path.join(__dirname, '..', 'netlify', 'functions', 'lib', 'unterschrift.js'));
const schrift = require(path.join(__dirname, '..', 'netlify', 'functions', 'lib', 'pdf-schrift.js'));
const { pdfTextDicht } = require('./pdf-text.js');
const fs = require('fs');

let n = 0, fehler = 0;
const ok = (name, b, info) => { n++; if (!b) fehler++; console.log((b ? '✅ ' : '❌ ') + name + (b || info === undefined ? '' : '   → ' + JSON.stringify(info))); };
const SIG = { striche: [[100, 200, 130, 150, 160, 210, 190, 120, 220, 200, 250, 110, 280, 190, 310, 130, 340, 200]] };

// mitSchrift: wie im Angebots-PDF (Inter, eingebettet); sonst Standardschrift Helvetica
function pdfMit(u, mitSchrift) {
  return new Promise((fertig) => {
    const doc = new PDFDocument({ size: 'A4', compress: false });
    const teile = [];
    doc.on('data', (d) => teile.push(d));
    doc.on('end', () => fertig(Buffer.concat(teile)));
    const S = mitSchrift ? schrift.einrichten(doc) : null;
    U.zeichnenPdf(doc, u, 50, 50, 250, 75, { latin1: (s) => s, S });
    doc.end();
  });
}

(async () => {
  ok('Gültiger Linienzug bleibt, wie er ist', JSON.stringify(U.pruefen(SIG)) === JSON.stringify(SIG));
  ok('Getippter Name: Leerzeichen zusammengezogen', JSON.stringify(U.pruefen({ getippt: '  Ayşe   Yılmaz ' })) === JSON.stringify({ getippt: 'Ayşe Yılmaz' }));
  const falsch = [
    ['nichts', undefined], ['leeres Objekt', {}], ['beides', { striche: SIG.striche, getippt: 'Ayşe' }],
    ['keine Striche', { striche: [] }], ['ungerade Länge', { striche: [[1, 2, 3]] }],
    ['Kommazahl', { striche: [[100, 200, 130.5, 150, 160, 210, 190, 120, 220, 200, 250, 110, 280, 190, 310, 130]] }],
    ['außerhalb des Felds', { striche: [[100, 200, 1300, 150, 160, 210, 190, 120, 220, 200, 250, 110, 280, 190, 310, 130]] }],
    ['negativ', { striche: [[-1, 200, 130, 150, 160, 210, 190, 120, 220, 200, 250, 110, 280, 190, 310, 130]] }],
    ['ein Punkt', { striche: [[500, 150]] }],
    ['flache Linie 70 x 0', { striche: [[100, 150, 110, 150, 120, 150, 130, 150, 140, 150, 150, 150, 160, 150, 170, 150]] }],
    ['senkrechte Linie 0 x 100', { striche: [[500, 100, 500, 110, 500, 120, 500, 130, 500, 140, 500, 150, 500, 160, 500, 200]] }],
    ['breit genug, aber nur 29 hoch', { striche: [[100, 100, 130, 129, 160, 100, 190, 129, 220, 100, 250, 129, 280, 100, 310, 129]] }],
    ['hoch genug, aber nur 59 breit', { striche: [[100, 100, 159, 110, 100, 120, 159, 130, 100, 140, 159, 150, 100, 160, 159, 170]] }],
    ['zu klein', { striche: [[500, 150, 501, 151, 502, 152, 503, 153, 504, 154, 505, 155, 506, 156, 507, 157]] }],
    ['zu viele Striche', { striche: Array.from({ length: 61 }, (_, i) => [i * 10, 100, i * 10 + 5, 200]) }],
    ['zu viele Punkte', { striche: [Array.from({ length: 2402 }, (_, i) => (i % 2 ? 100 + (i % 100) : i % 1000))] }],
    ['Name zu kurz', { getippt: 'A' }], ['Name zu lang', { getippt: 'x'.repeat(81) }], ['Name keine Zeichenkette', { getippt: 42 }],
    ['Name nur unsichtbare Zeichen', { getippt: '​​' }], ['Name mit Steuerzeichen', { getippt: 'Ay‮se' }],
  ];
  const grenze = { striche: [[100, 100, 130, 130, 160, 100, 190, 130, 220, 100, 130, 130, 120, 110, 160, 130]] };
  ok('Genau 60 breit und 30 hoch wird angenommen', U.pruefen(grenze) !== null, U.pruefen(grenze));
  const sechzig = { striche: Array.from({ length: 60 }, (_, i) => [i * 15 + 20, 40, i * 15 + 30, 200 - (i % 5) * 20]) };
  ok('60 Striche werden angenommen', U.pruefen(sechzig) !== null);
  ok('80 Zeichen langer Name wird angenommen', U.pruefen({ getippt: 'W'.repeat(40) + 'm'.repeat(40) }) !== null);
  const browserQuelle = fs.readFileSync(path.join(__dirname, '..', 'unterschrift.js'), 'utf8');
  ok('Browser prüft die Mindestausdehnung wie der Server (ODER)', /maxX - minX < 60 \|\| maxY - minY < 30/.test(browserQuelle) && !/maxX - minX < 60 && maxY - minY < 30/.test(browserQuelle));
  for (const [name, u] of falsch) ok('Abgelehnt: ' + name, U.pruefen(u) === null, U.pruefen(u));

  const a = { nummer: 'A-2026-0007', status: 'gesendet', token: 'x', kunde: { name: 'Ayşe Yılmaz', firma: '', strasse: 'Teststraße 1', plz: '33602', ort: 'Bielefeld', email: 'a@b.de' },
    event: { datum: '2027-06-12', personen: 80 }, zeilen: [{ art: 'paket', paket: 'classic', text: 'Paket Classic', menge: 80, einzel: 14, betrag: 1120 }, { art: 'extra', text: 'leer', menge: 0, einzel: 5, betrag: 0 }],
    summe: 1120, rabattBetrag: 0, gesamt: 1120, anzahlungProzent: 50, anzahlung: 560, rest: 560, gueltigBis: '2026-12-10', hinweis: '' };
  const h1 = U.angebotHash(a);
  ok('Prüfsumme: 64 Hex-Zeichen', /^[0-9a-f]{64}$/.test(h1), h1);
  ok('Prüfsumme hängt nicht an Status, Token, E-Mail oder Feldreihenfolge',
    U.angebotHash({ ...a, status: 'angenommen', token: 'y', kunde: { ...a.kunde, email: 'z@y.de' }, event: { personen: 80, datum: '2027-06-12' } }) === h1);
  ok('Prüfsumme ändert sich mit dem Betrag', U.angebotHash({ ...a, gesamt: 1121 }) !== h1);
  ok('Prüfsumme ändert sich mit der Rechnungsadresse', U.angebotHash({ ...a, kunde: { ...a.kunde, strasse: 'Andere Straße 2' } }) !== h1);
  ok('Positionen mit Menge 0 zählen nicht', U.angebotHash({ ...a, zeilen: [a.zeilen[0]] }) === h1);
  const fassung = U.inhalt(a);
  ok('Prüfsumme lässt sich aus der Fassung nachrechnen', U.hashVon(JSON.parse(JSON.stringify(fassung))) === h1 && require('crypto').createHash('sha256').update(U.kanonisch(fassung)).digest('hex') === h1);
  ok('Fassung enthält Rechnungsadresse, keine E-Mail', fassung.kunde.strasse === 'Teststraße 1' && !JSON.stringify(fassung).includes('a@b.de'));
  ok('Kurzform der Prüfsumme', U.hashKurz('3f2a9c1b77d0a1e4ffff') === '3f2a 9c1b 77d0 a1e4');

  ok('Zeittext im Winter (MEZ)', U.zeitText('2026-11-27T13:32:10.000Z') === '27.11.2026 um 14:32 Uhr', U.zeitText('2026-11-27T13:32:10.000Z'));
  ok('Zeittext im Sommer (MESZ)', U.zeitText('2027-07-01T10:05:00.000Z') === '01.07.2027 um 12:05 Uhr', U.zeitText('2027-07-01T10:05:00.000Z'));

  const p1 = await pdfMit(SIG);
  ok('PDF mit Linienzug ist gültig und enthält Linien', p1.slice(0, 5).toString() === '%PDF-' && / l\n/.test(p1.toString('latin1')));
  const p2 = await pdfMit({ getippt: 'Ayse Yilmaz' });
  // pdfkit schreibt Text als Hex-Strings (<41><79736520>...) in den TJ-Operator; die Hex-Stücke aneinanderhängen und dekodieren
  const hexText = (buf) => [...buf.toString('latin1').matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => Buffer.from(m[1], 'hex').toString('latin1')).join('');
  ok('PDF mit getipptem Namen ist gültig und enthält den Namen', p2.slice(0, 5).toString() === '%PDF-' && hexText(p2).includes('Ayse Yilmaz'));

  // Eingebettete Inter: Namen stehen unverändert im PDF
  ok('Schrift Inter ist eingebettet (fonts/pdf)', fs.existsSync(path.join(__dirname, '..', 'fonts', 'pdf', 'Inter-Regular.ttf')));
  for (const name of ['Ayşe Yılmaz', 'Łucja Ślusarczyk-Wójcik', 'Олег Петров', 'Müller-Özdemir']) {
    const p = await pdfMit({ getippt: name }, true);
    ok('PDF (Inter): getippter Name unverändert: ' + name, p.slice(0, 5).toString() === '%PDF-' && pdfTextDicht(p) === name.replace(/\s+/g, ''), pdfTextDicht(p));
  }
  const arabisch = await pdfMit({ getippt: 'محمد علي' }, true);
  ok('PDF (Inter): Name ohne Glyphen ergibt den Hinweis statt eines leeren Felds',
    pdfTextDicht(arabisch) === U.NAME_HINWEIS.replace(/\s+/g, ''), pdfTextDicht(arabisch));
  const gemischt = await pdfMit({ getippt: 'Ali محمد' }, true);
  ok('PDF (Inter): halb darstellbarer Name druckt den Hinweis, keinen verstümmelten Namen', pdfTextDicht(gemischt) === U.NAME_HINWEIS.replace(/\s+/g, ''), pdfTextDicht(gemischt));
  const lang80 = 'W'.repeat(40) + 'm'.repeat(40);
  const pl = await pdfMit({ getippt: lang80 }, true);
  ok('PDF (Inter): 80 Zeichen stehen vollständig im PDF (zweizeilig statt winzig)', pdfTextDicht(pl) === lang80, pdfTextDicht(pl));
  const lang = 'W'.repeat(40) + 'm'.repeat(40);
  const dok = new PDFDocument({ size: 'A4' });
  const gr = U.namensGroesse(dok, lang, 250, 75);
  dok.font('Helvetica-Oblique').fontSize(gr);
  ok('Langer Name (80 Zeichen) wird im PDF in die Box eingepasst', dok.widthOfString(lang) <= 250 && gr > 3 && gr < 22, { gr, breite: dok.widthOfString(lang) });
  ok('Kurzer Name bleibt bei 22 pt', U.namensGroesse(dok, 'Ayse Yilmaz', 250, 75) === 22);
  const p3 = await pdfMit({ getippt: lang });
  ok('PDF mit 80 Zeichen langem Namen enthält den ganzen Namen', p3.slice(0, 5).toString() === '%PDF-' && hexText(p3).includes(lang));

  console.log('\n' + (fehler ? '❌ ' + fehler + ' von ' + n + ' Prüfungen fehlgeschlagen' : '✅ Alle ' + n + ' Prüfungen grün'));
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.log('Absturz:', e && e.stack); process.exit(1); });
