'use strict';
/**
 * lib/office-sammeln.js
 * Liest aus den Blob-Stores, was die Meldungen fürs GNC Office brauchen (Fenster von–bis, Berliner Tage).
 * Bestellungen nur über den Zeitstempel im Schlüssel (o:GNC-<ms>), je 25 parallel: Der Lauf hat 30 Sekunden.
 */
const { getStore } = require('@netlify/blobs');

function store(name) {
  const o = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) { o.siteID = process.env.NETLIFY_BLOBS_SITE_ID; o.token = process.env.NETLIFY_BLOBS_TOKEN; }
  return getStore(o);
}

const cent = (euro) => Math.round(Number(euro || 0) * 100);
const berlinTag = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date(d));
const keyZeit = (key) => { const m = /^o:GNC-(?:GC-|BP-)?(\d{13})/.exec(key); return m ? Number(m[1]) : null; };
// Vorbestellungen: Abholtag bis zu 10 Tage nach der Bestellung
const VORLAUF_MS = 10 * 86400000;

async function lesen(s, keys) {
  const aus = [];
  for (let i = 0; i < keys.length; i += 25) {
    const teil = await Promise.all(keys.slice(i, i + 25).map((k) => s.get(k, { type: 'json' }).catch(() => null)));
    aus.push(...teil.filter(Boolean));
  }
  return aus;
}

async function sammeln(von, bis) {
  const ab = Date.parse(von + 'T00:00:00Z') - VORLAUF_MS;
  const bisMs = Date.parse(bis + 'T00:00:00Z') + 2 * 86400000;

  const os = store('orders');
  const { blobs } = await os.list({ prefix: 'o:' });
  const keys = blobs.map((b) => b.key).filter((k) => { const t = keyZeit(k); return t == null || (t >= ab && t <= bisMs); });
  const bestellungen = await lesen(os, keys);

  // Erstattungen: Ereignisse aus orders-action.js, Schlüssel erstattung:<Tag>:<Referenz>
  const es = store('office-ereignisse');
  const { blobs: ereignisse } = await es.list({ prefix: 'erstattung:' });
  const erstattungen = [];
  for (const k of ereignisse.map((b) => b.key)) {
    const tag = k.slice(11, 21);
    if (tag < von || tag > bis) continue;
    const rec = await os.get('o:' + k.slice(22), { type: 'json' }).catch(() => null);
    if (rec) erstattungen.push({ tag, rec });
  }

  // Gutscheine. Am Truck markiert das Team einen Gutschein in vouchers-admin.js als eingelöst
  // (redeemedVia 'manual', manualRedeemedAt); einen Bestellwert speichert der Shop dort nicht,
  // dann gilt der ganze Gutscheinwert als verbraucht (kein Verfall).
  const vs = store('vouchers');
  const { blobs: codes } = await vs.list({ prefix: 'c:' });
  const gutscheine = await lesen(vs, codes.map((b) => b.key));
  const geschenkCodes = new Set(gutscheine.filter((c) => c.giftcard && c.code).map((c) => String(c.code).toUpperCase()));
  const truck = gutscheine.filter((c) => c.giftcard && ['manual', 'truck'].includes(c.redeemedVia) && c.manualRedeemedAt)
    .map((c) => ({ tag: berlinTag(c.manualRedeemedAt), wert_cent: cent(c.value), bestellwert_cent: cent(c.truckBestellwert) || cent(c.value) }))
    .filter((t) => t.tag >= von && t.tag <= bis);

  // Rechnungen: von der höchsten Nummer rückwärts, bis eine älter als das Fenster ist
  const is = store('invoices');
  const rechnungen = [];
  const grenze = berlinTag(Date.parse(von + 'T12:00:00Z') - 2 * 86400000);
  for (const jahr of [...new Set([bis.slice(0, 4), von.slice(0, 4)])]) {
    const z = await is.get('counter:' + jahr, { type: 'json' }).catch(() => null);
    for (let n = (z && z.n) || 0; n > 0; n--) {
      const inv = await is.get(`inv:GNC-${jahr}-${String(n).padStart(4, '0')}`, { type: 'json' }).catch(() => null);
      if (!inv || inv.platzhalter) continue;
      const tag = inv.invoiceDay || (inv.createdAt ? berlinTag(inv.createdAt) : null);
      if (tag && tag < grenze) break;
      rechnungen.push(inv);
    }
  }

  // Bezahlte Sammelrechnungen (Store firmen, Schlüssel rechnung:<firma>:<JJJJ-MM>)
  const fs = store('firmen');
  const { blobs: metas } = await fs.list({ prefix: 'rechnung:' });
  const firmenZahlungen = [];
  for (const m of await lesen(fs, metas.map((b) => b.key))) {
    if (m.status !== 'bezahlt' || !m.bezahltAm || !m.invoiceNo) continue;
    const tag = berlinTag(m.bezahltAm);
    if (tag < von || tag > bis) continue;
    const inv = await is.get('inv:' + m.invoiceNo, { type: 'json' }).catch(() => null);
    if (inv) firmenZahlungen.push({ tag, nummer: m.invoiceNo, betrag_cent: cent(inv.total != null ? inv.total : (inv.vat || []).reduce((s, v) => s + Number(v.brutto || 0), 0)) });
  }

  return { bestellungen, erstattungen, geschenkCodes, truck, rechnungen, firmenZahlungen };
}

module.exports = { sammeln, store, keyZeit };
