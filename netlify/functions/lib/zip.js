/**
 * lib/zip.js
 * ----------------------------------------------------------------------------
 * Minimaler ZIP-Schreiber ohne Fremdbibliothek.
 *
 * Je Datei wird entschieden: PDFs sind bereits komprimiert und werden
 * unveraendert abgelegt (Methode 0, "stored") – ein zweiter Durchgang bringt
 * dort nichts und kostet nur Rechenzeit. JSON dagegen schrumpft stark, dafuer
 * gibt es Methode 8 ("deflate"). Das entscheidet ueber "passt in eine
 * Function-Antwort" oder nicht: die Datensicherung besteht fast nur aus JSON.
 * Gewaehlt wird immer das kleinere Ergebnis, nie das groessere.
 *
 * Aufbau je Eintrag: lokaler Kopf + Daten, am Ende das zentrale Verzeichnis
 * und der EOCD-Block. Dateinamen werden als UTF-8 markiert (Flag 0x0800),
 * damit Umlaute in Kundennamen nicht zerfallen.
 * ----------------------------------------------------------------------------
 */

const zlib = require('zlib');

/* CRC-32. Node bringt es seit 20.15 mit; sonst die Tabellenvariante. */
const crc32 = (() => {
  if (typeof zlib.crc32 === 'function') return (buf) => zlib.crc32(buf) >>> 0;
  const tabelle = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })();
  return (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = tabelle[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

/* Zeitstempel im DOS-Format, das ZIP verlangt. */
function dosZeit(d) {
  const datum = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const zeit = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  return { datum: datum & 0xFFFF, zeit: zeit & 0xFFFF };
}

/**
 * @param {Array<{name: string, data: Buffer, komprimieren?: boolean}>} dateien
 * @param {Date} [stand] Zeitstempel für alle Einträge
 * @returns {Buffer}
 */
function buildZip(dateien, stand) {
  const jetzt = stand || new Date();
  const { datum, zeit } = dosZeit(jetzt);
  const lokal = [];
  const zentral = [];
  let versatz = 0;

  for (const f of dateien) {
    const name = Buffer.from(f.name, 'utf8');
    const roh = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const crc = crc32(roh);   // CRC IMMER ueber die unkomprimierten Daten

    // Komprimieren versuchen, aber nur uebernehmen, wenn es wirklich kleiner
    // wird. Bei bereits komprimierten Daten (PDF, ZIP) waechst deflate sonst.
    let methode = 0;
    let daten = roh;
    if (f.komprimieren !== false && roh.length > 256) {
      try {
        const klein = zlib.deflateRawSync(roh, { level: 9 });
        if (klein.length < roh.length) { daten = klein; methode = 8; }
      } catch (e) { /* im Zweifel unkomprimiert – eine Sicherung darf nie scheitern */ }
    }

    const kopf = Buffer.alloc(30);
    kopf.writeUInt32LE(0x04034b50, 0);   // Signatur
    kopf.writeUInt16LE(20, 4);           // benötigte Version
    kopf.writeUInt16LE(0x0800, 6);       // Flag: Name ist UTF-8
    kopf.writeUInt16LE(methode, 8);      // 0 = unkomprimiert, 8 = deflate
    kopf.writeUInt16LE(zeit, 10);
    kopf.writeUInt16LE(datum, 12);
    kopf.writeUInt32LE(crc, 14);
    kopf.writeUInt32LE(daten.length, 18); // komprimierte Groesse
    kopf.writeUInt32LE(roh.length, 22);   // Groesse im Original
    kopf.writeUInt16LE(name.length, 26);
    kopf.writeUInt16LE(0, 28);           // keine Zusatzfelder
    lokal.push(kopf, name, daten);

    const eintrag = Buffer.alloc(46);
    eintrag.writeUInt32LE(0x02014b50, 0);
    eintrag.writeUInt16LE(20, 4);        // erstellt mit
    eintrag.writeUInt16LE(20, 6);        // benötigt
    eintrag.writeUInt16LE(0x0800, 8);
    eintrag.writeUInt16LE(methode, 10);
    eintrag.writeUInt16LE(zeit, 12);
    eintrag.writeUInt16LE(datum, 14);
    eintrag.writeUInt32LE(crc, 16);
    eintrag.writeUInt32LE(daten.length, 20);
    eintrag.writeUInt32LE(roh.length, 24);
    eintrag.writeUInt16LE(name.length, 28);
    eintrag.writeUInt16LE(0, 30);        // Zusatzfelder
    eintrag.writeUInt16LE(0, 32);        // Kommentar
    eintrag.writeUInt16LE(0, 34);        // Datenträger
    eintrag.writeUInt16LE(0, 36);        // interne Attribute
    eintrag.writeUInt32LE(0, 38);        // externe Attribute
    eintrag.writeUInt32LE(versatz, 42);  // Versatz des lokalen Kopfes
    zentral.push(eintrag, name);

    versatz += kopf.length + name.length + daten.length;
  }

  const zentralBuf = Buffer.concat(zentral);
  const ende = Buffer.alloc(22);
  ende.writeUInt32LE(0x06054b50, 0);
  ende.writeUInt16LE(0, 4);                    // Datenträgernummer
  ende.writeUInt16LE(0, 6);                    // Datenträger mit Verzeichnis
  ende.writeUInt16LE(dateien.length, 8);
  ende.writeUInt16LE(dateien.length, 10);
  ende.writeUInt32LE(zentralBuf.length, 12);
  ende.writeUInt32LE(versatz, 16);
  ende.writeUInt16LE(0, 20);                   // kein Kommentar

  return Buffer.concat([...lokal, zentralBuf, ende]);
}

module.exports = { buildZip };
