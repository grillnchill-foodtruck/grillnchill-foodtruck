/**
 * lib/sicherung.js
 * ----------------------------------------------------------------------------
 * Sammelt den Inhalt aller Blob-Speicher in EIN Archiv.
 *
 * Warum es das braucht: Bestellungen, Kunden, Gutscheine und Rechnungen liegen
 * ausschliesslich in Netlify Blobs. Es gab bisher keinen Weg, sie
 * herauszubekommen – weder gegen ein Versehen (ein falsch gesetzter Loeschlauf)
 * noch gegen den Verlust des Kontos. Rechnungen sind nach § 147 AO acht Jahre
 * aufzubewahren; offene Geschenkgutscheine sind bare Verbindlichkeiten.
 *
 * WAS DAS LEISTET – und was nicht:
 *   Die woechentliche Sicherung liegt selbst wieder in Netlify Blobs. Das
 *   schuetzt gegen Anwendungsfehler (versehentlich geloeschte Datensaetze,
 *   eine misslungene Umstellung), NICHT gegen den Verlust des Netlify-Kontos.
 *   Dafuer gibt es die Schaltflaeche im Admin-Tool: einmal im Monat das
 *   Archiv herunterladen und ausserhalb ablegen. Erst das ist eine Sicherung
 *   im eigentlichen Sinn.
 *
 * INHALT: Das Archiv enthaelt personenbezogene Daten (Namen, Anschriften,
 * Telefonnummern, Mailadressen) und die Passwort-Hashes der Team-Zugaenge.
 * Es gehoert deshalb hinter dieselbe Schranke wie die Rechnungen – nur
 * Admins – und auf dem eigenen Rechner in einen geschuetzten Ordner.
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');
const { buildZip } = require('./zip');

/* Welche Speicher gesichert werden – und warum.
   Bewusst NICHT dabei:
     sitzungen – aktive Admin-Anmeldungen. Das sind gueltige Zugangsmittel;
                 sie zu vervielfaeltigen waere ein Risiko ohne Nutzen, denn
                 nach einer Wiederherstellung meldet man sich ohnehin neu an.
     authguard – nur Zaehler fehlgeschlagener Anmeldungen, in Minuten veraltet. */
const SPEICHER = [
  { name: 'invoices',  zweck: 'Rechnungen – 8 Jahre aufbewahrungspflichtig (§ 147 AO)' },
  { name: 'vouchers',  zweck: 'Gutscheine – offene Geschenkgutscheine sind Verbindlichkeiten' },
  { name: 'customers', zweck: 'Kundenkonten, Treueguthaben, Anschriften' },
  { name: 'orders',    zweck: 'Bestellarchiv (90 Tage) und Tagesumsätze' },
  { name: 'audit',     zweck: 'Protokoll der Admin-Aktionen' },
  { name: 'team',      zweck: 'Team-Zugänge (enthält Passwort-Hashes)' },
  { name: 'standing',  zweck: 'Dauerbestellungen' },
  { name: 'catering',  zweck: 'Catering-Anfragen' },
  { name: 'groups',    zweck: 'Gruppenbestellungen' },
  { name: 'analytics', zweck: 'Tageszahlen' },
  { name: 'track',     zweck: 'Nutzungszähler' },
  { name: 'retarget',  zweck: 'Warteschlange für Erinnerungsmails' },
  { name: 'push',      zweck: 'Push-Anmeldungen der Geräte' },
];

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

/**
 * Einen Speicher vollständig auslesen.
 * Ein Fehler bei EINEM Speicher darf die ganze Sicherung nicht verhindern –
 * dann fehlt eben dieser Teil, und das steht so im Bericht.
 */
async function liesSpeicher(name) {
  const inhalt = {};
  let anzahl = 0;
  const s = store(name);
  const { blobs } = await s.list();
  for (const b of blobs) {
    try {
      const wert = await s.get(b.key, { type: 'json' });
      // Nicht-JSON-Einträge als Text sichern statt sie zu verlieren
      inhalt[b.key] = wert !== null ? wert : await s.get(b.key, { type: 'text' });
      anzahl++;
    } catch (e) {
      inhalt[b.key] = { __fehler: 'nicht lesbar: ' + (e && e.message) };
    }
  }
  return { inhalt, anzahl };
}

/** Alle Speicher einsammeln. Gibt immer ein Ergebnis zurück, nie einen Abbruch. */
async function sammle() {
  const stand = new Date().toISOString();
  const teile = [];
  const bericht = [];

  for (const def of SPEICHER) {
    try {
      const { inhalt, anzahl } = await liesSpeicher(def.name);
      teile.push({ name: def.name, zweck: def.zweck, inhalt });
      bericht.push({ speicher: def.name, eintraege: anzahl, ok: true });
    } catch (e) {
      console.error('Sicherung: Speicher "' + def.name + '" nicht lesbar:', e);
      bericht.push({ speicher: def.name, eintraege: 0, ok: false, fehler: String(e && e.message) });
    }
  }
  return { stand, teile, bericht };
}

/* Kopfzeilen der Datei, die im Archiv liegt – damit auch in drei Jahren noch
   klar ist, was man da vor sich hat und wie man es zurückspielt. */
function liesmich(stand, bericht) {
  const zeilen = [
    "Datensicherung Grill'n Chill",
    '='.repeat(60), '',
    'Stand: ' + stand,
    '',
    'Diese Dateien sind die vollständigen Inhalte der Netlify-Blob-Speicher,',
    'je Speicher eine JSON-Datei. Aufbau: { "Schlüssel": Wert, ... } – genau',
    'so, wie die Anwendung sie ablegt.',
    '',
    'ENTHALTEN:',
  ];
  for (const b of bericht) {
    const def = SPEICHER.find((d) => d.name === b.speicher);
    zeilen.push('  ' + (b.ok ? '·' : '!') + ' ' + b.speicher.padEnd(11)
      + String(b.eintraege).padStart(6) + ' Einträge   ' + ((def && def.zweck) || '')
      + (b.ok ? '' : '   << NICHT GELESEN: ' + b.fehler));
  }
  zeilen.push('',
    'NICHT ENTHALTEN: sitzungen (aktive Anmeldungen) und authguard (Zähler',
    'fehlgeschlagener Anmeldungen). Beides ist nach einer Wiederherstellung',
    'wertlos und wäre in falschen Händen ein Risiko.',
    '',
    'ACHTUNG – personenbezogene Daten:',
    'Namen, Anschriften, Telefonnummern, Mailadressen sowie die Passwort-',
    'Hashes der Team-Zugänge. Bitte nicht offen ablegen und nicht per Mail',
    'weitergeben.',
    '',
    'ZURÜCKSPIELEN:',
    'Es gibt bewusst KEINE Schaltfläche dafür. Ein versehentliches',
    'Zurückspielen würde neuere Bestellungen überschreiben. Im Ernstfall die',
    'betroffene JSON-Datei öffnen und die benötigten Einträge gezielt über die',
    'Netlify-Blobs-API oder das Admin-Tool wiederherstellen.',
    '');
  return zeilen.join('\n');
}

/** Aus dem Ergebnis von sammle() ein ZIP bauen. */
function baueArchiv({ stand, teile, bericht }) {
  const dateien = [
    { name: 'LIESMICH.txt', data: Buffer.from(liesmich(stand, bericht), 'utf8') },
    { name: 'bericht.json', data: Buffer.from(JSON.stringify({ stand, bericht }, null, 2), 'utf8') },
  ];
  for (const t of teile) {
    dateien.push({
      name: 'daten/' + t.name + '.json',
      data: Buffer.from(JSON.stringify(t.inhalt, null, 1), 'utf8'),
    });
  }
  return buildZip(dateien, new Date(stand));
}

module.exports = { sammle, baueArchiv, SPEICHER, store };
