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
 * TELEFON (November 2026)
 * -----------------------
 * Wer bei jeder Bestellung eine neue E-Mail-Adresse angibt, blieb unerkannt.
 * Deshalb zählt zusätzlich die vereinheitlichte Telefonnummer:
 *
 *   t:<CODE>:<sha256 der vereinheitlichten Nummer>  ->  { seit, n, zuletzt }
 *
 * Das Kundenlimit gilt für das MAXIMUM aus beiden Zählungen. Bei einer
 * Einlösung werden beide Datensätze hochgezählt, jede Bestellung weiter nur
 * einmal (gutscheinGezaehlt in send-email.js). Auch hier nur ein Hash.
 * Nummern mit weniger als 8 Ziffern zählen nicht (Tippfehler, "0").
 *
 * Adressen von Wegwerf-Maildiensten (lib/wegwerf-domains.js) bekommen Codes
 * mit Kundenlimit gar nicht erst: wegwerfGesperrt().
 *
 * Die Funktionen nehmen als Kunde entweder die E-Mail (Text, wie früher)
 * oder ein Objekt { email, phone }.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { codeNormalisieren } = require('./gutschein-code');
const { istWegwerf } = require('./wegwerf-domains');

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

/* Telefonnummer vereinheitlichen: Leerzeichen, Striche, Schrägstriche,
   Punkte und Klammern weg, "(0)" nach der Landesvorwahl weg. +49, 0049 und
   eine führende 0 werden zu 49... Andere Länder bleiben mit ihrer Vorwahl
   (+90 532 ... -> 90532...). Unter 8 Ziffern: '' (zählt nicht). */
function telefonVereinheitlichen(tel) {
  let t = String(tel || '').trim().slice(0, 40).replace(/\(0\)/g, '');
  t = t.replace(/[\s\-\u2010-\u2015\/().]/g, '');
  if (t.startsWith('+')) t = t.slice(1);
  else if (t.startsWith('00')) t = t.slice(2);
  else if (t.startsWith('0')) t = '49' + t.slice(1);
  t = t.replace(/\D/g, '');
  if (t.startsWith('490')) t = '49' + t.slice(3);   // +49 0170 ... (Null doppelt)
  return t.length >= 8 ? t.slice(0, 15) : '';
}

/* Kunde als { email, phone }; ein Text gilt als E-Mail (alte Aufrufe). */
function kundeAus(kunde) {
  if (kunde && typeof kunde === 'object') {
    return { email: String(kunde.email || '').trim(), phone: telefonVereinheitlichen(kunde.phone || kunde.telefon) };
  }
  return { email: String(kunde || '').trim(), phone: '' };
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
function telSchluessel(code, telNorm) {
  return 't:' + codeNormalisieren(code) + ':' + sha(telNorm);
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

/* alt: Stand, wenn es noch keinen eigenen Datensatz gibt (E-Mail: usedBy, Telefon: 0). */
async function standUnter(vs, key, c, alt) {
  let rec = null;
  try { rec = await vs.get(key, { type: 'json' }); } catch (e) { rec = null; }
  if (rec && rec.seit === (c.createdAt || null)) return { key, rec };
  return { key, rec: { seit: c.createdAt || null, n: alt } };
}

/* Alle Datensätze dieses Kunden zu diesem Code: E-Mail und Telefon, soweit vorhanden. */
async function staende(vs, code, c, kunde) {
  const k = kundeAus(kunde);
  const liste = [];
  if (k.email) liste.push(standUnter(vs, schluessel(code, k.email), c, altStand(c, k.email)));
  if (k.phone) liste.push(standUnter(vs, telSchluessel(code, k.phone), c, 0));
  return Promise.all(liste);
}

/** Bisherige Einlösungen dieses Kunden: das Maximum aus E-Mail- und Telefon-Zählung. Ohne beides: 0. */
async function einloesungenLesen(vs, code, c, kunde) {
  const st = await staende(vs, code, c, kunde);
  return st.reduce((m, s) => Math.max(m, s.rec.n || 0), 0);
}

/** Eine Einlösung zählen, unter E-Mail UND Telefon. Gibt den neuen Stand (Maximum) zurück. */
async function einloesungZaehlen(vs, code, c, kunde) {
  const st = await staende(vs, code, c, kunde);
  const heute = new Date().toISOString().slice(0, 10);
  let max = 0;
  for (const { key, rec } of st) {
    rec.n = (rec.n || 0) + 1;
    rec.zuletzt = heute;
    await vs.setJSON(key, rec);
    max = Math.max(max, rec.n);
  }
  return max;
}

/** true, wenn der Code ein Kundenlimit hat und die Adresse bei einem Wegwerfdienst liegt. */
function wegwerfGesperrt(c, email) {
  return limitProKunde(c) > 0 && istWegwerf(email);
}

module.exports = {
  mailVereinheitlichen, telefonVereinheitlichen, limitProKunde, zeitraum,
  einloesungenLesen, einloesungZaehlen, wegwerfGesperrt,
};
