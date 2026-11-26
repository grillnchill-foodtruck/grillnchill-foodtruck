'use strict';
/**
 * lib/unterschrift.js
 * Unterschrift bei der Online-Annahme eines Catering-Angebots.
 * Gespeichert wird ein Linienzug in einem Feld von 1000 × 300 (ganze Zahlen), kein Bild: klein, im PDF scharf,
 * und der Server öffnet keine fremden Bilddateien. Tempo und Druck speichern wir nicht, damit es keine
 * biometrischen Daten sind. Wer nicht zeichnen kann oder will, tippt den Namen (getippt).
 * Gegenstück im Browser: /unterschrift.js (gleiche Grenzen).
 */
const crypto = require('crypto');

const BREITE = 1000;
const HOEHE = 300;
const MAX_STRICHE = 60;
const MAX_PUNKTE = 1200;
const MIN_PUNKTE = 8;

function pruefen(u) {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
  if (u.getippt != null) {
    if (u.striche != null || typeof u.getippt !== 'string') return null;
    const name = u.getippt.replace(/\s+/g, ' ').trim();
    // Steuer- und Unsichtbarzeichen (Unicode-Kategorie C, z. B. Null-Breite-Leerzeichen, Bidi-Überschreibung) sind kein Name
    if (/\p{C}/u.test(name) || !/[\p{L}\p{N}]/u.test(name)) return null;
    return name.length >= 2 && name.length <= 80 ? { getippt: name } : null;
  }
  if (!Array.isArray(u.striche) || !u.striche.length || u.striche.length > MAX_STRICHE) return null;
  let punkte = 0;
  let minX = BREITE, maxX = 0, minY = HOEHE, maxY = 0;
  const striche = [];
  for (const s of u.striche) {
    if (!Array.isArray(s) || s.length < 2 || s.length % 2) return null;
    for (let i = 0; i < s.length; i += 2) {
      const x = s[i], y = s[i + 1];
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x > BREITE || y < 0 || y > HOEHE) return null;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    punkte += s.length / 2;
    if (punkte > MAX_PUNKTE) return null;
    striche.push(s.slice());
  }
  // Ein Punkt, ein winziges Gekritzel oder eine flache Linie ist keine Unterschrift
  if (punkte < MIN_PUNKTE || (maxX - minX < 60 || maxY - minY < 30)) return null;
  return { striche };
}

// Gleicher Inhalt ergibt immer denselben Text, egal in welcher Reihenfolge die Felder stehen
function kanonisch(x) {
  if (Array.isArray(x)) return '[' + x.map(kanonisch).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + kanonisch(x[k])).join(',') + '}';
  return JSON.stringify(x === undefined ? null : x);
}

// Das, was der Kunde annimmt: Nummer, Rechnungsadresse, Event, Positionen, Beträge, Gültigkeit, Hinweis.
// Nicht dabei: Status, Token, E-Mail, Telefon, Verlauf. Die ändern sich, ohne dass sich das Angebot ändert.
// Über JSON normalisiert (fehlende Felder fallen weg), damit die bei der Annahme gespeicherte Fassung
// später genau dieselbe Prüfsumme ergibt wie das Angebot im Moment der Annahme.
function inhalt(a) {
  const k = a.kunde || {};
  const roh = {
    nummer: a.nummer || '',
    kunde: { name: k.name || '', firma: k.firma || '', strasse: k.strasse || '', plz: k.plz || '', ort: k.ort || '', ustId: k.ustId || '' },
    event: a.event || {},
    zeilen: (a.zeilen || []).filter((z) => Number(z.menge) > 0)
      .map((z) => ({ art: z.art || '', paket: z.paket || '', text: z.text || '', menge: z.menge, einzel: z.einzel, betrag: z.betrag })),
    summe: a.summe, rabatt: a.rabattBetrag || 0, gesamt: a.gesamt,
    anzahlungProzent: a.anzahlungProzent, anzahlung: a.anzahlung, rest: a.rest,
    gueltigBis: a.gueltigBis || '', hinweis: a.hinweis || '',
  };
  return JSON.parse(JSON.stringify(roh));
}

// Prüfsumme (SHA-256) über die Fassung. Nachrechnen: sha256(kanonisch(a.annahme.fassung)).
function hashVon(fassung) {
  return crypto.createHash('sha256').update(kanonisch(fassung)).digest('hex');
}
function angebotHash(a) { return hashVon(inhalt(a)); }

function zeitText(iso) {
  const d = new Date(iso);
  const tag = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
  const zeit = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return tag + ' um ' + zeit + ' Uhr';
}

const hashKurz = (hex) => String(hex || '').slice(0, 16).replace(/(.{4})(?=.)/g, '$1 ');

// Schriftgröße für den getippten Namen: höchstens 22 pt, sonst so klein, dass er in die Breite w passt
function namensGroesse(doc, text, w, h) {
  const oben = Math.min(22, h * 0.45);
  doc.font('Helvetica-Oblique').fontSize(oben);
  const breit = doc.widthOfString(text);
  return breit > w ? oben * w / breit * 0.98 : oben;
}

const NAME_HINWEIS = 'Name enthält Zeichen, die das PDF nicht darstellen kann; gespeichert ist er vollständig.';
const MIN_NAMEN_PT = 9;

// Name für das PDF: S ist die Schrift aus lib/pdf-schrift.js. vollstaendig = jedes Zeichen hat eine Glyphe.
function namePdf(S, name) {
  const roh = String(name == null ? '' : name);
  const text = S.text(roh).trim();
  const zahl = (x) => [...x.replace(/\s+/g, '')].length;
  return { text, vollstaendig: zahl(text) > 0 && zahl(text) === zahl(roh) };
}

// Zeichnet die Unterschrift in das Rechteck (x, y, w, h) eines pdfkit-Dokuments, Seitenverhältnis bleibt.
// Mit S (Schrift aus pdf-schrift.js): Name in Inter, schräg, ab 9 pt bei Bedarf zweizeilig; ohne Glyphen der Hinweis.
// Ohne S (nur noch für Tests mit Standardschrift): Helvetica-Oblique in einer Zeile.
function zeichnenPdf(doc, u, x, y, w, h, { latin1 = (s) => s, S = null } = {}) {
  const farbe = '#111111';
  if (u.getippt && S) {
    const n = namePdf(S, u.getippt);
    if (!n.vollstaendig) {
      const o = { breite: w - 4, groesse: MIN_NAMEN_PT, farbe: '#444444' };
      S.schraeg.zeichnen(NAME_HINWEIS, x, y + Math.max(0, (h - S.schraeg.hoehe(NAME_HINWEIS, o)) / 2), o);
      return;
    }
    let g = Math.min(22, h * 0.45);
    doc.font(S.normal).fontSize(g);
    while (g > MIN_NAMEN_PT && doc.widthOfString(n.text) > w - 8) { g -= 0.5; doc.fontSize(g); }
    const o = { breite: w - 8, groesse: g, farbe, maxHoehe: h };
    S.schraeg.zeichnen(n.text, x, y + Math.max(0, (h - Math.min(h, S.schraeg.hoehe(n.text, o))) / 2), o);
    return;
  }
  if (u.getippt) {
    const text = latin1(u.getippt), groesse = namensGroesse(doc, text, w, h);
    doc.save().font('Helvetica-Oblique').fontSize(groesse).fillColor(farbe)
      .text(text, x, y + h * 0.3 + (Math.min(22, h * 0.45) - groesse) / 2, { width: w + 1, lineBreak: false });
    doc.restore();
    return;
  }
  const f = Math.min(w / BREITE, h / HOEHE);
  doc.save().lineWidth(1.3).lineCap('round').lineJoin('round').strokeColor(farbe).fillColor(farbe);
  for (const s of u.striche) {
    if (s.length === 2) { doc.circle(x + s[0] * f, y + s[1] * f, 0.7).fill(); continue; }
    doc.moveTo(x + s[0] * f, y + s[1] * f);
    // Weiche Bögen über die Mittelpunkte, wie im Zeichenfeld und in der Anzeige
    for (let i = 2; i < s.length - 2; i += 2) {
      doc.quadraticCurveTo(x + s[i] * f, y + s[i + 1] * f, x + (s[i] + s[i + 2]) / 2 * f, y + (s[i + 1] + s[i + 3]) / 2 * f);
    }
    doc.lineTo(x + s[s.length - 2] * f, y + s[s.length - 1] * f);
    doc.stroke();
  }
  doc.restore();
}

module.exports = { namePdf, NAME_HINWEIS, namensGroesse, pruefen, inhalt, hashVon, kanonisch, angebotHash, zeitText, hashKurz, zeichnenPdf, BREITE, HOEHE, MAX_STRICHE, MAX_PUNKTE };
