/**
 * lib/rechnungsnummer.js
 * ----------------------------------------------------------------------------
 * Nächste Rechnungsnummer GNC-<Jahr>-<NNNN>, für Einzelrechnungen
 * (send-email.js) und Firmen-Sammelrechnungen (firmen-admin.js) aus EINEM
 * Nummernkreis.
 *
 * § 14 Abs. 4 Nr. 4 UStG verlangt eine EINMALIGE, fortlaufende Nummer.
 * Lesen-Erhöhen-Schreiben allein reicht dafür nicht: treffen zwei Rechnungen
 * zeitgleich ein, lesen beide denselben Stand und vergeben dieselbe Nummer.
 * Deshalb wird die Nummer zuerst RESERVIERT: das Anlegen des Schlüssels
 * inv:<Nummer> gelingt dank onlyIfNew nur einmal. Wer unterliegt, nimmt die
 * nächste. Der Platzhalter wird danach mit der echten Rechnung überschrieben.
 *
 * Die Logik stand vorher wörtlich so in send-email.js (nextInvoiceNo) und ist
 * nur hierher umgezogen, damit es keinen zweiten Zähler gibt.
 * ----------------------------------------------------------------------------
 */

async function naechsteRechnungsnummer(s) {
  const jahr = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric' })
    .format(new Date());
  const key = 'counter:' + jahr;

  for (let versuch = 0; versuch < 25; versuch++) {
    const cur = (await s.get(key, { type: 'json' })) || { n: 0 };
    const n = cur.n + 1;
    const nummer = `GNC-${jahr}-${String(n).padStart(4, '0')}`;
    const res = await s.setJSON('inv:' + nummer,
      { invoiceNo: nummer, platzhalter: true, reserviertAm: new Date().toISOString() },
      { onlyIfNew: true });
    // Bereits vergeben: jemand anderes war schneller, also weiterzählen.
    if (res && res.modified === false) continue;
    await s.setJSON(key, { n });
    return nummer;
  }
  throw new Error('Rechnungsnummer konnte nicht vergeben werden');
}

module.exports = { naechsteRechnungsnummer };
