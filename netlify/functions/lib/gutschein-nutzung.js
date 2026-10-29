/**
 * lib/gutschein-nutzung.js
 * ----------------------------------------------------------------------------
 * Wie oft hat ein Kunde einen Aktionscode schon eingelöst? EINE Stelle für
 * Prüfen (voucher-check.js, lib/preisberechnung.js) und Zählen (send-email.js).
 *
 * WARUM (Oktober 2026)
 * --------------------
 * GRILL5 gilt höchstens dreimal pro Kunde. Kubi fand trotzdem einen Kunden,
 * der den Code deutlich öfter eingelöst hatte. Drei Lücken:
 *
 *  1. Die verbindliche Preisberechnung hat das Limit nie geprüft. Gesperrt
 *     hat nur die Prüfung im Browser, und die lässt bei einer Netzstörung
 *     durch. Wer die Anfrage selbst abschickt, kam ohnehin vorbei.
 *  2. Gezählt wurde in EINEM Datensatz für alle Kunden (usedBy im Gutschein).
 *     Liefen zwei Bestellungen gleichzeitig, schrieb die zweite den Stand der
 *     ersten über. Deren Einlösung war dann nie gezählt.
 *  3. Die E-Mail wurde nur kleingeschrieben. max.muster@gmail.com,
 *     maxmuster@gmail.com und maxmuster+1@gmail.com landen im selben Postfach,
 *     galten aber als drei Kunden.
 *
 * JETZT
 * -----
 * Je Code und Kunde ein eigener kleiner Datensatz im Store "vouchers":
 *
 *   n:<CODE>:<sha256 der vereinheitlichten E-Mail>  ->  { seit, n, zuletzt }
 *
 * Gleichzeitige Bestellungen verschiedener Kunden kommen sich nicht mehr in
 * die Quere. Gespeichert wird wie bisher nur ein Hash der E-Mail-Adresse mit
 * einem Zähler (Datenschutzerklärung Nr. 11), kein Klartext.
 *
 * Alte Stände aus usedBy zählen mit, solange es für den Kunden noch keinen
 * eigenen Datensatz gibt; beim ersten Zählen werden sie übernommen. "seit"
 * ist das Anlagedatum des Codes: Wird ein Code gelöscht und unter gleichem
 * Namen neu angelegt, fangen alle Kunden wieder bei null an.
 *
 * Grenze: Wer bei jeder Bestellung eine ganz andere E-Mail-Adresse angibt,
 * bleibt unerkannt. Das lässt sich nur über eine weitere Kennung (Telefon,
 * Kundenkonto) schließen und bräuchte eine Änderung von AGB und Datenschutz.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { codeNormalisieren } = require('./gutschein-code');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* Postfach-Regeln, die sicher gelten:
   - Gmail ignoriert Punkte im Namen, googlemail.com ist dasselbe Postfach.
   - name+irgendwas@ stellen Gmail, Outlook, iCloud und viele andere an name@
     zu. Wo ein Anbieter das nicht kann, hat kaum jemand ein "+" im Namen. */
function mailVereinheitlichen(email) {
  const m = String(email || '').trim().toLowerCase();
  const at = m.lastIndexOf('@');
  if (at < 1) return m;
  let name = m.slice(0, at);
  let domain = m.slice(at + 1);
  const plus = name.indexOf('+');
  if (plus > 0) name = name.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') name = name.replace(/\./g, '');
  return name + '@' + domain;
}

/** Erlaubte Einlösungen pro Kunde, 0 = kein Limit. oncePerCustomer ist der alte Schalter (= 1). */
function limitProKunde(c) {
  if (!c) return 0;
  return c.maxPerCustomer > 0 ? c.maxPerCustomer : (c.oncePerCustomer ? 1 : 0);
}

/* Datumsangaben gelten in Europa/Berlin, das Ende einschließlich. Die zwei
   Stunden Puffer decken Sommer- und Winterzeit ab (wie bisher in voucher-check). */
function zeitraum(c, jetzt) {
  const t = jetzt || Date.now();
  if (c.validFrom && t < new Date(c.validFrom + 'T00:00:00+02:00').getTime() - 2 * 3600000) return 'not_started';
  if (c.validUntil && t > new Date(c.validUntil + 'T23:59:59+02:00').getTime() + 2 * 3600000) return 'expired';
  return null;
}

function schluessel(code, email) {
  return 'n:' + codeNormalisieren(code) + ':' + sha(mailVereinheitlichen(email));
}

/* Stand aus dem alten Sammel-Datensatz. Früher war der Schlüssel der Hash der
   nur kleingeschriebenen Adresse; ein Eintrag unter der vereinheitlichten
   Schreibweise zählt dazu. */
function altStand(c, email) {
  const u = (c && c.usedBy) || {};
  const wert = (h) => { const v = u[h]; return typeof v === 'number' ? v : (v ? 1 : 0); };
  const roh = sha(String(email || '').trim().toLowerCase());
  const einheit = sha(mailVereinheitlichen(email));
  return wert(roh) + (einheit !== roh ? wert(einheit) : 0);
}

async function stand(vs, code, c, email) {
  const key = schluessel(code, email);
  let rec = null;
  try { rec = await vs.get(key, { type: 'json' }); } catch (e) { rec = null; }
  if (rec && rec.seit === (c.createdAt || null)) return { key, rec };
  return { key, rec: { seit: c.createdAt || null, n: altStand(c, email) } };
}

/** Bisherige Einlösungen dieses Kunden. Ohne E-Mail: 0. */
async function einloesungenLesen(vs, code, c, email) {
  if (!email) return 0;
  return (await stand(vs, code, c, email)).rec.n || 0;
}

/** Eine Einlösung zählen. Gibt den neuen Stand zurück. */
async function einloesungZaehlen(vs, code, c, email) {
  if (!email) return 0;
  const { key, rec } = await stand(vs, code, c, email);
  rec.n = (rec.n || 0) + 1;
  rec.zuletzt = new Date().toISOString().slice(0, 10);
  await vs.setJSON(key, rec);
  return rec.n;
}

module.exports = { mailVereinheitlichen, limitProKunde, zeitraum, einloesungenLesen, einloesungZaehlen };
