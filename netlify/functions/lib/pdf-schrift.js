/**
 * lib/pdf-schrift.js
 * ----------------------------------------------------------------------------
 * Eigene Schrift für die PDFs: Inter (wie auf der Website), eingebettet als
 * Teilmenge. Damit stehen türkische Buchstaben (ş, ğ, ı, İ) und alles aus
 * Latin Extended so im PDF, wie die Kundin sie geschrieben hat. Vorher konnte
 * nur Helvetica (Latin-1) gedruckt werden, ş wurde zu s.
 *
 * Dateien: fonts/pdf/Inter-Regular.ttf und Inter-Bold.ttf (Inter 3.19,
 * SIL Open Font License 1.1, siehe fonts/pdf/OFL.txt). netlify.toml nimmt sie
 * über included_files in die Functions mit. Fehlen sie, fällt alles auf
 * Helvetica und die Latin-1-Ersetzungen zurück, das PDF entsteht trotzdem.
 *
 * Kursiv: Eine Inter-Kursive liegt nicht bei. schraeg() neigt deshalb jede
 * Zeile um 10 Grad um ihre eigene Grundlinie und bricht die Zeilen selbst um
 * (Absätze der Nachricht bleiben erhalten). Kopierbarer Text bleibt Text.
 *
 * Geprüft mit der Quick-Look-Vorschau von macOS (qlmanage, gleicher Renderer
 * wie Vorschau, Mail und Safari): die eingebettete Schrift erscheint.
 * ----------------------------------------------------------------------------
 */

const path = require('path');
const fs = require('fs');

const NEIGUNG = Math.tan(10 * Math.PI / 180);

function datei(name) {
  for (const w of [path.join(__dirname, '..', '..', '..'), process.env.LAMBDA_TASK_ROOT || '.', process.cwd()]) {
    const k = path.join(w, name);
    try { if (fs.existsSync(k)) return k; } catch (e) {}
  }
  return null;
}

// Standardschriften können nur Latin-1 (Rückfall, wenn Inter fehlt)
function latin1(s) {
  return String(s == null ? '' : s)
    .replace(/[Ş]/g, 'S').replace(/[ş]/g, 's').replace(/Ğ/g, 'G').replace(/ğ/g, 'g')
    .replace(/İ/g, 'I').replace(/ı/g, 'i')
    .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"').replace(/[–—]/g, '-').replace(/…/g, '...')
    .replace(/[^\u0000-ÿ€]/g, '');
}

/**
 * Schrift im Dokument einrichten.
 * @returns {{ normal, fett, eingebettet, text(s), schraeg: { hoehe, zeichnen } }}
 *   normal/fett: Namen für doc.font(); text(): bereinigt einen Text für die
 *   Schrift (Zeichen ohne Glyphe, etwa Emojis, fallen weg).
 */
function einrichten(doc) {
  const r = datei('fonts/pdf/Inter-Regular.ttf');
  const b = datei('fonts/pdf/Inter-Bold.ttf');
  let eingebettet = false;
  let glyphe = null;
  if (r && b) {
    try {
      doc.registerFont('GNC', r);
      doc.registerFont('GNC-Fett', b);
      // Die Glyphenliste der Schrift: was sie nicht kennt, würde als Kästchen erscheinen
      const vorher = doc._font;
      doc.font('GNC');
      const f = doc._font && doc._font.font;
      if (f && typeof f.hasGlyphForCodePoint === 'function') glyphe = (cp) => f.hasGlyphForCodePoint(cp);
      if (vorher) doc._font = vorher;
      eingebettet = true;
    } catch (e) {
      console.error('PDF-Schrift:', e.message);
      eingebettet = false;
    }
  }
  const normal = eingebettet ? 'GNC' : 'Helvetica';
  const fett = eingebettet ? 'GNC-Fett' : 'Helvetica-Bold';

  function text(s) {
    const roh = String(s == null ? '' : s);
    if (!eingebettet) return latin1(roh);
    let aus = '';
    for (const z of roh) {
      const cp = z.codePointAt(0);
      if (z === '\n' || z === '\t' || cp === 0x20) { aus += z; continue; }
      if (cp < 0x20 || (cp >= 0xFE00 && cp <= 0xFE0F) || cp === 0x200D) continue;   // Steuerzeichen, Emoji-Varianten, Joiner
      if (!glyphe || glyphe(cp)) aus += z;
    }
    return aus.replace(/ {2,}/g, ' ');
  }

  /* ---- Schräge Schrift (synthetische Kursive) ------------------------- */
  function zeilen(t, breite) {
    const aus = [];
    for (const absatz of String(t).split('\n')) {
      if (!absatz.trim()) { aus.push(''); continue; }
      let zeile = '';
      for (let w of absatz.split(/ +/)) {
        // Ein Wort breiter als die Zeile wird hart getrennt
        while (w && doc.widthOfString(w) > breite) {
          let i = w.length - 1;
          while (i > 1 && doc.widthOfString(w.slice(0, i)) > breite) i--;
          if (zeile) { aus.push(zeile); zeile = ''; }
          aus.push(w.slice(0, i));
          w = w.slice(i);
        }
        if (!w) continue;
        const probe = zeile ? zeile + ' ' + w : w;
        if (doc.widthOfString(probe) <= breite) zeile = probe;
        else { if (zeile) aus.push(zeile); zeile = w; }
      }
      aus.push(zeile);
    }
    // Leere Zeilen am Ende tragen nichts bei
    while (aus.length && !aus[aus.length - 1]) aus.pop();
    return aus;
  }
  function vorbereiten(t, o) {
    doc.font(o.fett ? fett : normal).fontSize(o.groesse);
    const zh = doc.currentLineHeight(true) + (o.zeilenabstand || 0);
    return { liste: zeilen(t, o.breite), zh };
  }
  const schraeg = {
    /** Höhe des Textblocks in Punkt */
    hoehe(t, o) {
      const { liste, zh } = vorbereiten(t, o);
      return liste.length * zh;
    },
    /**
     * Zeichnet den Text ab (x, y). o: { breite, groesse, zeilenabstand, farbe,
     * maxHoehe }. Passt er nicht in maxHoehe, endet die letzte Zeile mit „…“.
     * @returns {{ hoehe: number, gekuerzt: boolean }}
     */
    zeichnen(t, x, y, o) {
      const { liste, zh } = vorbereiten(t, o);
      let zeigen = liste;
      let gekuerzt = false;
      if (o.maxHoehe) {
        const max = Math.max(1, Math.floor((o.maxHoehe + 0.01) / zh));
        if (liste.length > max) {
          gekuerzt = true;
          zeigen = liste.slice(0, max);
          let letzte = zeigen[max - 1];
          while (letzte && doc.widthOfString(letzte + '…') > o.breite) letzte = letzte.slice(0, -1);
          zeigen[max - 1] = letzte.replace(/\s+$/, '') + '…';
        }
      }
      if (o.farbe) doc.fillColor(o.farbe);
      zeigen.forEach((z, i) => {
        if (!z) return;
        const zy = y + i * zh;
        const grundlinie = zy + o.groesse * 0.82;
        doc.save();
        // x' = x - Neigung · (y - Grundlinie): oberhalb der Grundlinie nach rechts
        doc.transform(1, 0, -NEIGUNG, 1, NEIGUNG * grundlinie, 0);
        doc.text(z, x, zy, { lineBreak: false });
        doc.restore();
      });
      return { hoehe: zeigen.length * zh, gekuerzt };
    },
  };

  return { normal, fett, eingebettet, text, schraeg };
}

module.exports = { einrichten, latin1 };
