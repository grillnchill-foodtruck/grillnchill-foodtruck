'use strict';
/**
 * lib/office-sammeln.js
 * Liest aus den Blob-Stores, was die Meldungen fürs GNC Office brauchen (Fenster von–bis, Berliner Tage).
 * Bestellungen nur über den Zeitstempel im Schlüssel (o:GNC-<ms>): ab 10 Tagen vor dem Fenster, ohne Obergrenze.
 * Den Zeitstempel setzt das Gerät des Kunden; geht dessen Uhr vor, darf die Bestellung nicht fehlen. Ohne Obergrenze
 * liest der Lauf nur die Bestellungen von heute zusätzlich.
 * Ungültige Datumswerte in Datensätzen ergeben Tag null (kein Wurf); baueMeldungen macht daraus einen Hinweis.
 *
 * Streng gelesen (fail-closed): Bestellungen, Erstattungs-Ereignisse, Gutscheine. Jeder Lesefehler zählt in lesefehler,
 * und office-meldungen.js sendet dann nichts. Sonst fehlte ein Umsatz still, und eine Tagesmeldung wiche ab.
 * Tolerant: Rechnungen und Zahlungen. Was heute nicht lesbar ist, geht in einer späteren Nacht raus (gesendet wird
 * erst nach der Antwort des Office vermerkt).
 *
 * Lesezugriffe: Bestellungen und Gutscheine je 75 parallel (der Lauf hat 30 Sekunden), Rechnungen rückwärts je 25,
 * Sammelrechnungen nur Monate bis zum Fensterende. Gutscheine müssen alle gelesen werden: Der Schlüssel c:<Code>
 * trägt keinen Zeitbezug, und die Einlösung am Truck kann Jahre nach dem Kauf liegen.
 */
const { getStore } = require('@netlify/blobs');
const { berlinTag, tagAus } = require('./office-tag');   // werfen nie, ungültiges Datum ergibt null

function store(name) {
  const o = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) { o.siteID = process.env.NETLIFY_BLOBS_SITE_ID; o.token = process.env.NETLIFY_BLOBS_TOKEN; }
  return getStore(o);
}

const cent = (euro) => Math.round(Number(euro || 0) * 100);
const keyZeit = (key) => { const m = /^o:GNC-(?:GC-|BP-)?(\d{13})/.exec(key); return m ? Number(m[1]) : null; };
// Vorbestellungen: Abholtag bis zu 10 Tage nach der Bestellung
const VORLAUF_MS = 10 * 86400000;
const WELLE = 25;
const WELLE_GROSS = 75;   // Bestellungen und Gutscheine: viele kleine Blobs

async function sammeln(von, bis) {
  const z = { lesen: 0, fehler: 0 };
  // Ein Lesezugriff. streng: ein Fehler zählt als Lesefehler. Ergebnis null bei Fehler oder fehlendem Blob.
  const holen = (s, k, streng) => { z.lesen++; return s.get(k, { type: 'json' }).catch(() => { if (streng) z.fehler++; return null; }); };
  // Viele Schlüssel in Wellen; Ergebnis Map Schlüssel -> Datensatz (nur vorhandene)
  const lesen = async (s, keys, { welle = WELLE, streng = false } = {}) => {
    const aus = new Map();
    for (let i = 0; i < keys.length; i += welle) {
      const teil = await Promise.all(keys.slice(i, i + welle).map((k) => holen(s, k, streng).then((v) => [k, v])));
      for (const [k, v] of teil) if (v) aus.set(k, v);
    }
    return aus;
  };
  // Liste der Schlüssel; streng: Fehler zählt als Lesefehler (leere Liste), sonst wirft sie wie bisher
  const liste = async (s, prefix, streng) => {
    z.lesen++;
    try { return (await s.list({ prefix })).blobs.map((b) => b.key); } catch (e) { if (!streng) throw e; z.fehler++; return []; }
  };

  const ab = Date.parse(von + 'T00:00:00Z') - VORLAUF_MS;
  const os = store('orders');
  const keys = (await liste(os, 'o:', true)).filter((k) => { const t = keyZeit(k); return t == null || t >= ab; });
  const gelesen = await lesen(os, keys, { welle: WELLE_GROSS, streng: true });
  // Die Bestellnummer steht im Schlüssel: für Hinweise, auch wenn dem Datensatz die Bestelldaten fehlen
  for (const [k, rec] of gelesen) if (typeof rec === 'object' && !rec.reference) rec.reference = k.slice(2);
  const bestellungen = [...gelesen.values()];

  // Erstattungen: Ereignisse aus orders-action.js (Schlüssel erstattung:<Tag>:<Referenz>) vereinigt mit den gelesenen
  // Bestellungen, die status refunded und refundedAt im Fenster haben. So stimmt die erste Nacht (Erstattungen vor dem
  // Livegang haben kein Ereignis), und ein nicht gespeichertes Ereignis fällt nicht weg. Je Referenz genau einmal.
  const es = store('office-ereignisse');
  const erstattungen = new Map();
  const nachlesen = [];
  for (const k of await liste(es, 'erstattung:', true)) {
    const tag = k.slice(11, 21);
    const ref = k.slice(22);
    if (tag < von || tag > bis || erstattungen.has(ref)) continue;
    const rec = gelesen.get('o:' + ref) || null;
    erstattungen.set(ref, { tag, rec, referenz: ref });
    if (!rec) nachlesen.push(ref);
  }
  const nach = await lesen(os, nachlesen.map((ref) => 'o:' + ref), { welle: WELLE_GROSS, streng: true });
  for (const ref of nachlesen) erstattungen.get(ref).rec = nach.get('o:' + ref) || null;   // fehlt sie: Hinweis in baueMeldungen
  for (const [k, rec] of gelesen) {
    if (rec.status !== 'refunded') continue;
    const tag = berlinTag(rec.refundedAt);
    const ref = k.slice(2);
    if (tag && tag >= von && tag <= bis && !erstattungen.has(ref)) erstattungen.set(ref, { tag, rec, referenz: ref });
  }

  // Gutscheine. Am Truck markiert das Team einen Gutschein in vouchers-admin.js als eingelöst
  // (redeemedVia 'manual', manualRedeemedAt); einen Bestellwert speichert der Shop dort nicht,
  // dann gilt der ganze Gutscheinwert als verbraucht (kein Verfall).
  const vs = store('vouchers');
  const gutscheine = [...(await lesen(vs, await liste(vs, 'c:', true), { welle: WELLE_GROSS, streng: true })).values()];
  const geschenkCodes = new Set(gutscheine.filter((c) => c.giftcard && c.code).map((c) => String(c.code).toUpperCase()));
  const truck = gutscheine.filter((c) => c.giftcard && ['manual', 'truck'].includes(c.redeemedVia) && c.manualRedeemedAt)
    .map((c) => ({ tag: berlinTag(c.manualRedeemedAt), wert_cent: cent(c.value), bestellwert_cent: cent(c.truckBestellwert) || cent(c.value),
      kennung: String(c.code || '').slice(-4).toUpperCase() }))   // nur fürs Unterscheiden von Hinweisen, nie der ganze Code
    .filter((t) => t.tag == null || (t.tag >= von && t.tag <= bis));   // Tag null bleibt: baueMeldungen macht einen Hinweis daraus

  // Rechnungen: von der höchsten Nummer rückwärts, bis eine älter als das Fenster ist
  const is = store('invoices');
  const rechnungen = [];
  const grenze = berlinTag(Date.parse(von + 'T12:00:00Z') - 2 * 86400000);
  for (const jahr of [...new Set([bis.slice(0, 4), von.slice(0, 4)])]) {
    const zaehler = await holen(is, 'counter:' + jahr, false);
    let alt = false;
    for (let n = (zaehler && zaehler.n) || 0; n > 0 && !alt; n -= WELLE) {
      const nummern = [];
      for (let k = n; k > Math.max(0, n - WELLE); k--) nummern.push(`inv:GNC-${jahr}-${String(k).padStart(4, '0')}`);
      const teil = await Promise.all(nummern.map((k) => holen(is, k, false)));
      for (const inv of teil) {   // Reihenfolge von hoch nach niedrig bleibt erhalten
        if (!inv || inv.platzhalter) continue;
        // invoiceDate (TT.MM.JJJJ) als Rückfall: Einzelrechnungen ohne invoiceDay und createdAt beenden die Suche sonst nie
        const tag = tagAus(inv.invoiceDay) || tagAus(inv.createdAt) || tagAus(inv.invoiceDate);
        if (tag && tag < grenze) { alt = true; break; }
        rechnungen.push(inv);
      }
    }
  }

  // Bezahlte Sammelrechnungen (Store firmen, Schlüssel rechnung:<firma>:<JJJJ-MM>)
  const fs = store('firmen');
  const firmenZahlungen = [];
  // Eine Sammelrechnung für den Monat M gibt es erst nach Monatsende: bezahlt im Fenster heißt M <= Monat von bis
  const monate = (await liste(fs, 'rechnung:', false)).filter((k) => { const monat = k.slice(k.lastIndexOf(':') + 1); return !/^\d{4}-\d{2}$/.test(monat) || monat <= bis.slice(0, 7); });
  const bezahlt = [];
  for (const m of (await lesen(fs, monate)).values()) {
    if (m.status !== 'bezahlt' || !m.bezahltAm || !m.invoiceNo) continue;
    const tag = berlinTag(m.bezahltAm);
    if (tag == null) { firmenZahlungen.push({ tag: null, nummer: m.invoiceNo, betrag_cent: 0 }); continue; }   // wird zum Hinweis
    if (tag < von || tag > bis) continue;
    bezahlt.push({ tag, nummer: m.invoiceNo });
  }
  // Die Rechnungen dazu: schon gelesene wiederverwenden, den Rest parallel und je Nummer nur einmal
  const schon = new Map(rechnungen.filter((inv) => inv.invoiceNo).map((inv) => [inv.invoiceNo, inv]));
  const dazu = await lesen(is, [...new Set(bezahlt.map((x) => x.nummer).filter((nr) => !schon.has(nr)))].map((nr) => 'inv:' + nr));
  for (const x of bezahlt) {
    const inv = schon.get(x.nummer) || dazu.get('inv:' + x.nummer);
    // Bei Sammelrechnungen gleicht baueMeldungen die Satzzeilen an total an: Zahlung und Posten sind dann gleich
    if (inv) firmenZahlungen.push({ tag: x.tag, nummer: x.nummer, betrag_cent: cent(inv.total != null ? inv.total : (inv.vat || []).reduce((s, v) => s + Number(v.brutto || 0), 0)) });
  }

  return { bestellungen, erstattungen: [...erstattungen.values()], geschenkCodes, truck, rechnungen, firmenZahlungen, lesezugriffe: z.lesen, lesefehler: z.fehler };
}

module.exports = { sammeln, store, keyZeit };
