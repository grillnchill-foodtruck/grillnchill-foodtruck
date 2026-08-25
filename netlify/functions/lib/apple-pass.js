/**
 * lib/apple-pass.js
 * ----------------------------------------------------------------------------
 * Baut die Apple-Wallet-Kundenkarte (.pkpass) und alles, was der
 * Aktualisierungs-Dienst dazu braucht.
 *
 * Ein .pkpass ist ein Zip mit: pass.json (Inhalt), Bildern, manifest.json
 * (SHA-1 jeder Datei) und signature (PKCS#7-Signatur des Manifests mit dem
 * Pass-Zertifikat + Apples WWDR-Zwischenzertifikat). Signiert wird mit
 * node-forge; gepackt mit lib/zip.js (aus der Datensicherung wiederverwendet).
 *
 * Konfiguration: Das Pass-ZERTIFIKAT ist oeffentlich (steckt in jedem
 * ausgelieferten Pass) und liegt darum im Repo (lib/apple-pass-cert.pem).
 * Der private SCHLUESSEL ist geheim und liegt im Netlify-Blobs-Store
 * "geheim" (Schluessel 'apple-pass-key', hochgeladen ueber die Admin-Function
 * geheim-upload.js) – NICHT als Umgebungsvariable: AWS begrenzt die auf 4 KB
 * gesamt, und mit allen Diensten zusammen platzte dieses Limit beim Deploy.
 * APPLE_PASS_KEY_B64 als Env wird, falls doch gesetzt, bevorzugt (lokale
 * Tests). Klein genug fuer Env bleiben:
 *   APPLE_PASS_TYPE_ID  – z. B. pass.de.grillnchillfoodtruck.kundenkarte
 *   APPLE_TEAM_ID       – Team (Fallback 99R8K7386U)
 * Vor Nutzung der Signier-/Token-Funktionen einmal `await laden()` rufen.
 *
 * Live-Aktualisierung: pass.json traegt webServiceURL + authenticationToken.
 * Das Token leiten wir je Seriennummer per HMAC aus dem privaten Schluessel
 * ab – kein zusaetzliches Geheimnis, nichts zu speichern.
 *
 * Gold-Stufe: ab Level 10 ("King of Chill") wird die Karte gold – gleiche
 * Schwelle wie die Royal-Karte bei Google Wallet.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { buildZip } = require('./zip');
const BILDER = require('./apple-pass-bilder');

const TEAM_FALLBACK = '99R8K7386U';

/* Privater Schluessel: einmal je Function-Instanz laden, dann aus dem Cache. */
let keyCache = null;
async function laden() {
  if (keyCache) return true;
  if (process.env.APPLE_PASS_KEY_B64) {
    keyCache = Buffer.from(process.env.APPLE_PASS_KEY_B64, 'base64').toString('utf8');
    return true;
  }
  const pem = await require('./geheim').holeGeheim('apple-pass-key');
  if (pem && pem.includes('PRIVATE KEY')) { keyCache = pem; return true; }
  return false;
}

function konfiguriert() {
  if (!process.env.APPLE_PASS_TYPE_ID) return false;
  try { certPem(); require('node-forge'); return true; } catch (e) { return false; }
}
/* konfiguriert() UND Schluessel wirklich da – fuer den GET-Statusbericht. */
async function verfuegbar() {
  return konfiguriert() && (await laden());
}

const certPem = () => process.env.APPLE_PASS_CERT_B64
  ? Buffer.from(process.env.APPLE_PASS_CERT_B64, 'base64').toString('utf8')
  : fs.readFileSync(path.join(__dirname, 'apple-pass-cert.pem'), 'utf8');
function keyPem() {
  if (!keyCache) throw new Error('Schluessel nicht geladen – vorher laden() aufrufen');
  return keyCache;
}
const passTypeId = () => process.env.APPLE_PASS_TYPE_ID;
const teamId = () => process.env.APPLE_TEAM_ID || TEAM_FALLBACK;
const siteUrl = () => (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');

/* Seriennummer je Kunde: stabil aus dem E-Mail-Hash. */
const serialFuer = (emailHash) => 'GNC' + String(emailHash).slice(0, 16);

/* authenticationToken (min. 16 Zeichen laut Apple): HMAC aus dem privaten
   Schluessel – nur der Server kann es fuer eine Seriennummer errechnen. */
function authTokenFuer(serial) {
  const geheim = crypto.createHash('sha256').update(keyPem()).digest();
  return crypto.createHmac('sha256', geheim).update('pass:' + serial).digest('hex').slice(0, 32);
}

/* Kurzlebiger Download-Link-Beweis (der "Zu Apple Wallet"-Knopf oeffnet eine
   GET-URL – die darf nicht jedem den Pass einer fremden Adresse geben). */
function downloadToken(emailHash, ablaufMs) {
  const daten = Buffer.from(JSON.stringify({ k: emailHash, e: ablaufMs })).toString('base64url');
  const geheim = crypto.createHash('sha256').update(keyPem()).digest();
  const sig = crypto.createHmac('sha256', geheim).update(daten).digest('base64url');
  return daten + '.' + sig;
}
function pruefeDownloadToken(token) {
  try {
    const [daten, sig] = String(token || '').split('.');
    const geheim = crypto.createHash('sha256').update(keyPem()).digest();
    const soll = crypto.createHmac('sha256', geheim).update(daten).digest('base64url');
    if (sig !== soll || sig.length < 40) return null;
    const d = JSON.parse(Buffer.from(daten, 'base64url').toString('utf8'));
    if (!d.k || !d.e || Date.now() > d.e) return null;
    return d.k;
  } catch (e) { return null; }
}

const LEVEL_NAMES = ['Grill Rookie', 'Bun Boss', 'Patty Pro', 'Sauce Sensei', 'Cheese Melter', 'Flame Rider', 'Ember Elite', 'Grill Guru', 'Street Legende', 'King of Chill'];
function levelVon(rec) {
  const lv = Math.min(10, 1 + (rec.cards || 0));
  return { level: lv, name: LEVEL_NAMES[lv - 1] };
}

function passJson(rec, emailHash) {
  const { level, name } = levelVon(rec);
  const royal = level >= 10;
  const serial = serialFuer(emailHash);
  const bisBonus = Math.max(0, Math.round((100 - (rec.spent || 0)) * 100) / 100);

  return {
    formatVersion: 1,
    passTypeIdentifier: passTypeId(),
    teamIdentifier: teamId(),
    organizationName: "Grill'n Chill",
    description: royal ? "Grill'n Chill Kundenkarte · Royal" : "Grill'n Chill Kundenkarte",
    serialNumber: serial,
    webServiceURL: siteUrl() + '/wallet-api',
    authenticationToken: authTokenFuer(serial),
    logoText: royal ? "Grill'n Chill · Royal" : "Grill'n Chill",
    // Gold ab der letzten Stufe – sonst CI: fast-schwarz, Creme, Orange
    backgroundColor: royal ? 'rgb(184,134,11)' : 'rgb(12,11,9)',
    foregroundColor: royal ? 'rgb(20,14,2)' : 'rgb(244,239,233)',
    labelColor: royal ? 'rgb(61,42,4)' : 'rgb(232,119,34)',
    barcodes: [{
      format: 'PKBarcodeFormatQR',
      message: 'GNCQR:' + rec.qrToken,
      messageEncoding: 'iso-8859-1',
      altText: 'Am Truck vorzeigen',
    }],
    storeCard: {
      primaryFields: [{ key: 'boni', label: '5-€-BONI', value: rec.rewards || 0 }],
      secondaryFields: [
        { key: 'level', label: 'LEVEL', value: level + ' · ' + name },
        { key: 'next', label: 'BIS ZUM NÄCHSTEN BONUS', value: bisBonus.toFixed(2).replace('.', ',') + ' €',
          textAlignment: 'PKTextAlignmentRight' },
      ],
      auxiliaryFields: [
        { key: 'name', label: 'KONTO', value: rec.name || rec.email || '' },
      ],
      backFields: [
        { key: 'info', label: 'So funktioniert es',
          value: 'Code am Truck vorzeigen – wir schreiben deinen Einkauf gut und lösen Boni direkt ein. Je 100 € Umsatz gibt es 5 € Bonus.' },
        { key: 'standort', label: 'Standort',
          value: "Grill'n Chill Foodtruck\nGütersloher Str. 122, 33649 Bielefeld\ngrillnchill-foodtruck.de" },
      ],
    },
  };
}

/* PKCS#7-Signatur des Manifests (detached), wie Apple sie erwartet. */
function signiereManifest(manifestBuf) {
  const forge = require('node-forge');
  const cert = forge.pki.certificateFromPem(certPem());
  const key = forge.pki.privateKeyFromPem(keyPem());
  const wwdr = forge.pki.certificateFromPem(
    fs.readFileSync(path.join(__dirname, 'apple-wwdr-g4.pem'), 'utf8'));

  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(manifestBuf.toString('binary'));
  p7.addCertificate(wwdr);
  p7.addCertificate(cert);
  p7.addSigner({
    key, certificate: cert,
    digestAlgorithm: forge.pki.oids.sha1,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: new Date() },
    ],
  });
  p7.sign({ detached: true });
  return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), 'binary');
}

/**
 * Kompletter Pass als Buffer.
 * @param rec Kundendatensatz (braucht qrToken)
 * @param emailHash sha256(email) hex
 */
function bauePass(rec, emailHash) {
  const dateien = [
    { name: 'pass.json', data: Buffer.from(JSON.stringify(passJson(rec, emailHash))) },
  ];
  for (const [name, b64] of Object.entries(BILDER)) {
    dateien.push({ name, data: Buffer.from(b64, 'base64') });
  }
  const manifest = {};
  for (const f of dateien) {
    manifest[f.name] = crypto.createHash('sha1').update(f.data).digest('hex');
  }
  const manifestBuf = Buffer.from(JSON.stringify(manifest));
  dateien.push({ name: 'manifest.json', data: manifestBuf });
  dateien.push({ name: 'signature', data: signiereManifest(manifestBuf) });
  return buildZip(dateien, new Date());
}

module.exports = {
  konfiguriert, verfuegbar, laden, bauePass, serialFuer, authTokenFuer,
  downloadToken, pruefeDownloadToken, passTypeId, teamId,
};
