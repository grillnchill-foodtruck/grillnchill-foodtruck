#!/usr/bin/env node
/**
 * werkzeug/sicherungstest.js
 * ----------------------------------------------------------------------------
 * Fährt die wöchentliche Datensicherung gegen einen nachgebauten Speicher:
 * sammeln, packen, wieder entpacken und Feld für Feld vergleichen.
 *
 * Geprüft wird, was im Ernstfall zählt:
 *   - Kommt jeder Datensatz unverändert wieder heraus? (auch Umlaute)
 *   - Bleiben aktive Anmeldungen draußen?
 *   - Übersteht die Sicherung einen Speicher, der gerade nicht lesbar ist?
 *   - Werden alte Stände aufgeräumt, aber die jüngsten behalten?
 *
 *   node werkzeug/sicherungstest.js
 * ----------------------------------------------------------------------------
 */

const path = require('path');
const zlib = require('zlib');
const Module = require('module');
const originalLoad = Module._load;

const SPEICHER = {};
const kaputt = new Set();
const ablage = (name) => ({
  get: async (k, o) => {
    if (kaputt.has(name)) throw new Error('Speicher "' + name + '" nicht erreichbar');
    const v = (SPEICHER[name] || {})[k];
    if (v === undefined) return null;
    if (o && o.type === 'arrayBuffer') return Buffer.isBuffer(v) ? v : Buffer.from(String(v));
    if (o && o.type === 'text') return typeof v === 'string' ? v : JSON.stringify(v);
    return Buffer.isBuffer(v) ? null : JSON.parse(JSON.stringify(v));
  },
  set: async (k, v) => { (SPEICHER[name] ||= {})[k] = v; },
  setJSON: async (k, v) => { (SPEICHER[name] ||= {})[k] = JSON.parse(JSON.stringify(v)); },
  delete: async (k) => { delete (SPEICHER[name] || {})[k]; },
  list: async ({ prefix } = {}) => {
    if (kaputt.has(name)) throw new Error('Speicher "' + name + '" nicht erreichbar');
    return { blobs: Object.keys(SPEICHER[name] || {})
      .filter((k) => !prefix || k.startsWith(prefix)).map((key) => ({ key })) };
  },
});
Module._load = function (anfrage, ...rest) {
  if (anfrage === '@netlify/blobs') {
    return { getStore: (o) => ablage(typeof o === 'string' ? o : o.name) };
  }
  return originalLoad.call(this, anfrage, ...rest);
};
global.fetch = async () => ({ ok: true, json: async () => ({}) });

const basis = path.join(__dirname, '..', 'netlify', 'functions');
const { sammle, baueArchiv } = require(path.join(basis, 'lib', 'sicherung.js'));
const wochenlauf = require(path.join(basis, 'backup-weekly.js')).handler;

const gruen = (t) => '\x1b[32m' + t + '\x1b[0m';
const rot = (t) => '\x1b[31m' + t + '\x1b[0m';
let fehler = 0;
const pruefe = (name, ok, detail) => {
  if (!ok) fehler++;
  console.log('  ' + (ok ? gruen('✅') : rot('❌')) + ' ' + name.padEnd(50) + (detail || ''));
};

/* Minimaler ZIP-Leser: nur so viel, wie der Test braucht. */
function lies(zip) {
  const raus = {};
  let i = 0;
  while (i < zip.length - 4 && zip.readUInt32LE(i) === 0x04034b50) {
    const methode = zip.readUInt16LE(i + 8);
    const komp = zip.readUInt32LE(i + 18);
    const roh = zip.readUInt32LE(i + 22);
    const nLen = zip.readUInt16LE(i + 26);
    const eLen = zip.readUInt16LE(i + 28);
    const name = zip.slice(i + 30, i + 30 + nLen).toString('utf8');
    const start = i + 30 + nLen + eLen;
    const daten = zip.slice(start, start + komp);
    raus[name] = methode === 8 ? zlib.inflateRawSync(daten) : daten;
    if (raus[name].length !== roh) throw new Error('Größe stimmt nicht: ' + name);
    i = start + komp;
  }
  return raus;
}

function befuelle() {
  for (const k of Object.keys(SPEICHER)) delete SPEICHER[k];
  SPEICHER['invoices'] = { 'inv:GNC-2026-0001': { invoiceNo: 'GNC-2026-0001', company: 'Müller & Söhne GmbH', total: 42.8 } };
  SPEICHER['customers'] = { 'c:abc': { email: 'jörg@example.org', name: 'Jörg Öztaş', spent: 120.5, addresses: [{ street: 'Detmolder Str. 1' }] } };
  SPEICHER['vouchers'] = { 'c:GRÜN10': { code: 'GRÜN10', value: 10, uses: 3 }, 'c:GNCK7M2PQR': { code: 'GNCK7M2PQR', value: 20, uses: 0 } };
  SPEICHER['team'] = { 'u:kubi': { name: 'Kubi', role: 'admin', pwHash: 'abc123' } };
  SPEICHER['orders'] = {};
  for (let i = 0; i < 300; i++) SPEICHER['orders']['o:GNC-' + i] = { status: 'completed', order: { name: 'Kunde ' + i, total: 12.9 } };
  // Diese beiden dürfen NICHT im Archiv landen
  SPEICHER['sitzungen'] = { 'tok:geheim123': { wer: 'Kubi', exp: 1 } };
  SPEICHER['authguard'] = { 'ip:abc': { fehl: 3 } };
}

(async () => {
  console.log('\nDatensicherung\n' + '─'.repeat(74) + '\n');

  console.log('1) Sammeln und Packen');
  befuelle();
  const daten = await sammle();
  const zip = baueArchiv(daten);
  const dateien = lies(zip);
  pruefe('Archiv lässt sich wieder lesen', Object.keys(dateien).length > 0,
    Object.keys(dateien).length + ' Dateien, ' + zip.length.toLocaleString('de-DE') + ' Bytes');
  pruefe('LIESMICH und Bericht liegen bei',
    !!dateien['LIESMICH.txt'] && !!dateien['bericht.json']);

  console.log('\n2) Inhalte kommen unverändert wieder heraus');
  const rechnungen = JSON.parse(dateien['daten/invoices.json']);
  pruefe('Rechnung samt Umlaut', rechnungen['inv:GNC-2026-0001'].company === 'Müller & Söhne GmbH',
    rechnungen['inv:GNC-2026-0001'].company);
  const kunden = JSON.parse(dateien['daten/customers.json']);
  pruefe('Kundenname mit Umlaut und ş', kunden['c:abc'].name === 'Jörg Öztaş', kunden['c:abc'].name);
  const gutscheine = JSON.parse(dateien['daten/vouchers.json']);
  pruefe('Gutschein-Schlüssel mit Umlaut', !!gutscheine['c:GRÜN10'], 'uses=' + (gutscheine['c:GRÜN10'] || {}).uses);
  const bestellungen = JSON.parse(dateien['daten/orders.json']);
  pruefe('alle 300 Bestellungen enthalten', Object.keys(bestellungen).length === 300,
    Object.keys(bestellungen).length + ' Stück');

  console.log('\n3) Was draußen bleiben muss');
  pruefe('aktive Anmeldungen NICHT im Archiv', !dateien['daten/sitzungen.json']);
  pruefe('Sperrzähler NICHT im Archiv', !dateien['daten/authguard.json']);
  pruefe('kein Sitzungs-Token irgendwo im ZIP', !zip.toString('latin1').includes('geheim123'));

  console.log('\n4) Kompression');
  const rohSumme = Object.values(dateien).reduce((n, b) => n + b.length, 0);
  pruefe('Archiv kleiner als der Rohbestand', zip.length < rohSumme,
    (rohSumme / 1024).toFixed(0) + ' KB → ' + (zip.length / 1024).toFixed(0) + ' KB'
    + ' (Faktor ' + (rohSumme / zip.length).toFixed(1) + ')');

  console.log('\n5) Ein Speicher fällt aus');
  befuelle();
  kaputt.add('customers');
  const teil = await sammle();
  const teilZip = baueArchiv(teil);
  const teilDateien = lies(teilZip);
  kaputt.clear();
  pruefe('Sicherung läuft trotzdem durch', !!teilDateien['daten/invoices.json']);
  const bericht = JSON.parse(teilDateien['bericht.json']).bericht;
  const kaputtEintrag = bericht.find((b) => b.speicher === 'customers');
  pruefe('Ausfall steht im Bericht', kaputtEintrag && kaputtEintrag.ok === false,
    kaputtEintrag ? String(kaputtEintrag.fehler).slice(0, 40) : '—');

  console.log('\n6) Wöchentlicher Lauf und Aufräumen');
  befuelle();
  // Zehn alte Stände vorlegen; behalten werden sollen die 8 jüngsten + der neue
  SPEICHER['backups'] = {};
  for (let i = 1; i <= 10; i++) {
    const t = '2026-0' + (i < 10 ? '1' : '2') + '-' + String(i).padStart(2, '0') + 'T03:15:00.000Z';
    SPEICHER['backups']['kopf:' + t] = { stand: t, bytes: 10 };
    SPEICHER['backups']['bak:' + t] = Buffer.from('alt');
  }
  const antwort = await wochenlauf();
  const ergebnis = JSON.parse(antwort.body);
  pruefe('Lauf meldet Erfolg', ergebnis.ok === true, ergebnis.eintraege + ' Einträge');
  const koepfe = Object.keys(SPEICHER['backups']).filter((k) => k.startsWith('kopf:'));
  pruefe('nur die letzten 8 Stände bleiben', koepfe.length === 8, koepfe.length + ' Stände');
  const archive = Object.keys(SPEICHER['backups']).filter((k) => k.startsWith('bak:'));
  pruefe('zu jedem Stand gibt es ein Archiv', archive.length === koepfe.length,
    archive.length + ' Archive / ' + koepfe.length + ' Köpfe');
  pruefe('der neue Stand ist dabei', koepfe.some((k) => k.slice(5) === ergebnis.stand));

  console.log('\n' + '─'.repeat(74));
  console.log(fehler === 0
    ? gruen('ERGEBNIS: ✅ Sicherung vollständig, wiederherstellbar, ohne Zugangsmittel.')
    : rot('ERGEBNIS: ❌ ' + fehler + ' Prüfung(en) fehlgeschlagen.'));
  process.exit(fehler === 0 ? 0 : 1);
})().catch((e) => { console.error(rot('Abbruch: ' + e.stack)); process.exit(1); });
