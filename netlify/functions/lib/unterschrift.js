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
  // Ein Punkt oder ein winziges Gekritzel ist keine Unterschrift
  if (punkte < MIN_PUNKTE || (maxX - minX < 60 && maxY - minY < 30)) return null;
  return { striche };
}

// Gleicher Inhalt ergibt immer denselben Text, egal in welcher Reihenfolge die Felder stehen
function kanonisch(x) {
  if (Array.isArray(x)) return '[' + x.map(kanonisch).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + kanonisch(x[k])).join(',') + '}';
  return JSON.stringify(x === undefined ? null : x);
}

// Prüfsumme über das, was der Kunde annimmt: Nummer, Rechnungsadresse, Event, Positionen, Beträge, Gültigkeit, Hinweis.
// Nicht dabei: Status, Token, E-Mail, Telefon, Verlauf. Die ändern sich, ohne dass sich das Angebot ändert.
function angebotHash(a) {
  const k = a.kunde || {};
  const inhalt = {
    nummer: a.nummer || '',
    kunde: { name: k.name || '', firma: k.firma || '', strasse: k.strasse || '', plz: k.plz || '', ort: k.ort || '', ustId: k.ustId || '' },
    event: a.event || {},
    zeilen: (a.zeilen || []).filter((z) => Number(z.menge) > 0)
      .map((z) => ({ art: z.art || '', paket: z.paket || '', text: z.text || '', menge: z.menge, einzel: z.einzel, betrag: z.betrag })),
    summe: a.summe, rabatt: a.rabattBetrag || 0, gesamt: a.gesamt,
    anzahlungProzent: a.anzahlungProzent, anzahlung: a.anzahlung, rest: a.rest,
    gueltigBis: a.gueltigBis || '', hinweis: a.hinweis || '',
  };
  return crypto.createHash('sha256').update(kanonisch(inhalt)).digest('hex');
}

function zeitText(iso) {
  const d = new Date(iso);
  const tag = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
  const zeit = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return tag + ' um ' + zeit + ' Uhr';
}

const hashKurz = (hex) => String(hex || '').slice(0, 16).replace(/(.{4})(?=.)/g, '$1 ');

// Zeichnet die Unterschrift in das Rechteck (x, y, w, h) eines pdfkit-Dokuments, Seitenverhältnis bleibt
function zeichnenPdf(doc, u, x, y, w, h, { latin1 = (s) => s } = {}) {
  const farbe = '#111111';
  if (u.getippt) {
    doc.save().font('Helvetica-Oblique').fontSize(Math.min(22, h * 0.45)).fillColor(farbe)
      .text(latin1(u.getippt), x, y + h * 0.3, { width: w, lineBreak: false, ellipsis: true });
    doc.restore();
    return;
  }
  const f = Math.min(w / BREITE, h / HOEHE);
  doc.save().lineWidth(1.3).lineCap('round').lineJoin('round').strokeColor(farbe).fillColor(farbe);
  for (const s of u.striche) {
    if (s.length === 2) { doc.circle(x + s[0] * f, y + s[1] * f, 0.7).fill(); continue; }
    doc.moveTo(x + s[0] * f, y + s[1] * f);
    for (let i = 2; i < s.length; i += 2) doc.lineTo(x + s[i] * f, y + s[i + 1] * f);
    doc.stroke();
  }
  doc.restore();
}

module.exports = { pruefen, angebotHash, zeitText, hashKurz, zeichnenPdf, BREITE, HOEHE, MAX_STRICHE, MAX_PUNKTE };
