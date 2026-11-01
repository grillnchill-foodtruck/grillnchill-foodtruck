/**
 * lib/team-passwort.js
 * ----------------------------------------------------------------------------
 * Team-Passwörter speichern und prüfen.
 *
 * Bis November 2026 lag im Store "team" je Zugang sha256(passwort), ohne
 * Salz. Wer den Speicher oder eine Datensicherung in die Hand bekam, konnte
 * auf einer Grafikkarte Milliarden Passwörter pro Sekunde durchprobieren, und
 * gleiche Passwörter sahen gleich aus. Jetzt: scrypt mit eigenem Salz je
 * Zugang, gebremst auf rund 50 ms pro Versuch.
 *
 *     s1$<Salz base64>$<Hash base64>      scrypt N=16384, r=8, p=1, 32 Byte
 *
 * Alte Einträge (64 Hexzeichen) gelten weiter. Beim ersten erfolgreichen
 * Anmelden schreibt mitglied() den neuen Hash, ohne dass jemand etwas merkt.
 *
 * Kosten: Das Team meldet sich nur mit dem Passwort an (Passwort =
 * Identität), also muss mitglied() im Zweifel jeden Zugang prüfen. Die
 * Prüfungen laufen parallel, und ein Zwischenspeicher merkt sich Ergebnisse,
 * solange die Function warm ist. Danach kostet eine Anfrage nichts mehr.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const KOSTEN = { N: 16384, r: 8, p: 1 };
const ALT = /^[a-f0-9]{64}$/;

const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

function gleich(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** Neuen Hash für ein Passwort erzeugen (zum Speichern als pwHash). */
async function hashen(pw) {
  const salz = crypto.randomBytes(16);
  const h = await scrypt(String(pw), salz, 32, KOSTEN);
  return 's1$' + salz.toString('base64') + '$' + h.toString('base64');
}

// Nur im Speicher der laufenden Function, nie im Blob-Store
const gemerkt = new Map();
function merken(k, v) {
  if (gemerkt.size > 500) gemerkt.clear();
  gemerkt.set(k, v);
}

/** Passt das Passwort zum gespeicherten Hash? Kennt alt (sha256) und neu (s1). */
async function stimmt(pw, gespeichert) {
  if (!pw || typeof gespeichert !== 'string') return false;
  if (ALT.test(gespeichert)) return gleich(sha(pw), gespeichert);
  const teile = gespeichert.split('$');
  if (teile.length !== 3 || teile[0] !== 's1') return false;
  const k = sha(pw) + '|' + gespeichert;
  if (gemerkt.has(k)) return gemerkt.get(k);
  const soll = Buffer.from(teile[2], 'base64');
  const ist = await scrypt(String(pw), Buffer.from(teile[1], 'base64'), soll.length, KOSTEN);
  const ok = ist.length === soll.length && crypto.timingSafeEqual(ist, soll);
  merken(k, ok);
  return ok;
}

// Alten Hash ersetzen. Vorher frisch lesen: Hat jemand das Passwort in der
// Zwischenzeit geändert, darf das alte es nicht zurückschreiben.
async function aufwerten(t, treffer, pw) {
  try {
    const frisch = await t.get(treffer.key, { type: 'json' });
    if (!frisch || frisch.pwHash !== treffer.u.pwHash) return;
    frisch.pwHash = await hashen(pw);
    await t.setJSON(treffer.key, frisch);
    treffer.u = frisch;
  } catch (e) {
    console.error('team-passwort aufwerten:', e.message);   // Anmeldung gilt trotzdem
  }
}

/**
 * Team-Zugang zum Passwort finden.
 * @param t      Blob-Store "team"
 * @param pw     Passwort
 * @param blobs  optional: schon geladene Liste aus t.list({ prefix: 'u:' }).blobs
 * @returns {Promise<{key: string, u: object}|null>}
 */
async function mitglied(t, pw, blobs) {
  if (!pw) return null;
  const liste = blobs || (await t.list({ prefix: 'u:' })).blobs;
  const eintraege = (await Promise.all(liste.map(async (b) => ({ key: b.key, u: await t.get(b.key, { type: 'json' }) }))))
    .filter((e) => e.u && e.u.pwHash);
  const passt = await Promise.all(eintraege.map((e) => stimmt(pw, e.u.pwHash)));
  const treffer = eintraege[passt.indexOf(true)];
  if (!treffer) return null;
  if (ALT.test(treffer.u.pwHash)) await aufwerten(t, treffer, pw);
  return treffer;
}

module.exports = { hashen, stimmt, mitglied };
