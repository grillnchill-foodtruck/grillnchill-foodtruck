'use strict';
/**
 * werkzeug/pdf-text.js
 * Text aus einem pdfkit-PDF lesen, auch mit eingebetteter Schrift (Inter): pdfkit schreibt dort Glyphennummern
 * statt Zeichen, die ToUnicode-Tabelle der Schrift übersetzt sie zurück. Nur für Tests.
 */
const zlib = require('zlib');

function objekte(buf) {
  const t = buf.toString('latin1');
  const aus = {};
  const re = /(\d+) 0 obj([\s\S]*?)endobj/g;
  let m;
  while ((m = re.exec(t))) {
    const koerper = m[2];
    const i = koerper.indexOf('stream');
    let dict = koerper, daten = null;
    if (i >= 0) {
      dict = koerper.slice(0, i);
      let roh = koerper.slice(i + 6).replace(/^\r?\n/, '').replace(/\r?\nendstream\s*$/, '');
      roh = Buffer.from(roh, 'latin1');
      if (/FlateDecode/.test(dict)) { try { roh = zlib.inflateSync(roh); } catch (e) {} }
      daten = roh.toString('latin1');
    }
    aus[m[1]] = { dict, daten };
  }
  return aus;
}

const utf16 = (hex) => Buffer.from(hex, 'hex').swap16().toString('utf16le');

function cmap(text) {
  const karte = {};
  for (const b of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const z of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) karte[parseInt(z[1], 16)] = utf16(z[2]);
  }
  for (const b of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const z of b[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([^\]]*)\]/g)) {
      const lo = parseInt(z[1], 16);
      [...z[3].matchAll(/<([0-9a-fA-F]+)>/g)].forEach((x, i) => { karte[lo + i] = utf16(x[1]); });
    }
    const ohneListen = b[1].replace(/\[[^\]]*\]/g, '');
    for (const z of ohneListen.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const lo = parseInt(z[1], 16), hi = parseInt(z[2], 16), basis = z[3];
      for (let g = lo; g <= hi; g++) {
        const cp = parseInt(basis.slice(-4), 16) + (g - lo);
        karte[g] = utf16(basis.slice(0, -4) + cp.toString(16).padStart(4, '0'));
      }
    }
  }
  return karte;
}

function pdfText(buf) {
  const o = objekte(buf);
  const schriften = {};   // Name (F2) -> { karte | null }
  for (const m of Object.values(o).map((x) => x.dict).join('\n').matchAll(/\/(F\d+) (\d+) 0 R/g)) {
    const f = o[m[2]];
    const u = f && /\/ToUnicode (\d+) 0 R/.exec(f.dict);
    schriften[m[1]] = u && o[u[1]] && o[u[1]].daten ? cmap(o[u[1]].daten) : null;
  }
  let aus = '';
  for (const { daten } of Object.values(o)) {
    if (!daten || !/ Tf/.test(daten)) continue;
    let karte = null;
    for (const op of daten.matchAll(/\/(F\d+) [\d.]+ Tf|\[((?:[^\]\\]|\\.)*)\] TJ|<([0-9a-fA-F]+)> Tj/g)) {
      if (op[1]) { karte = schriften[op[1]] || null; continue; }
      const stuecke = op[3] ? [op[3]] : [...op[2].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1]);
      for (const h of stuecke) {
        if (karte) for (let i = 0; i < h.length; i += 4) aus += karte[parseInt(h.slice(i, i + 4), 16)] || '';
        else aus += Buffer.from(h, 'hex').toString('latin1');
      }
      aus += ' ';
    }
  }
  return aus;
}
// Ohne Leerzeichen zwischen den Textstücken, für Vergleiche
const pdfTextDicht = (buf) => pdfText(buf).replace(/\s+/g, '');

module.exports = { pdfText, pdfTextDicht };
