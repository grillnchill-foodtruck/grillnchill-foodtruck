/**
 * lib/bremse.js
 * ----------------------------------------------------------------------------
 * Grundschutz für jeden öffentlichen Endpunkt, als eine Zeile am Anfang:
 *
 *     const halt = await schutz(event, { name: 'bestellung', max: 20, maxKB: 64 });
 *     if (halt) return halt;
 *
 * 1. Anfragen je Absender begrenzen: höchstens `max` in `fensterMin` Minuten
 *    (Standard 10). Danach 429 mit Retry-After.
 * 2. Zu große Anfragen ablehnen (413), bevor jemand sie liest.
 *
 * Die Grenzen sind bewusst großzügig: Im Mobilfunk teilen sich oft viele
 * Kunden eine IP-Adresse (CGNAT), im Büro alle Kollegen. Die Bremse soll
 * Skripte stoppen, die hundertfach Bestellungen, Codes oder Mails auslösen,
 * keine Mittagspause.
 *
 * Fehlgeschlagene ANMELDUNGEN zählt weiter lib/auth-guard.js, strenger
 * (5 in 15 Minuten).
 *
 * Wie lib/auth-guard.js: Im Störungsfall wird durchgelassen. Ein klemmender
 * Speicher darf keine Bestellung verhindern.
 *
 * Interne Aufrufe zwischen eigenen Functions (z. B. der SumUp-Webhook ruft
 * send-email) laufen alle über dieselben Netlify-Adressen und würden sonst
 * gemeinsam gezählt. Sie tragen den Header x-gnc-intern (internHeader) und
 * zählen nicht.
 *
 * Speicher: Blob-Store "bremse", Schlüssel <Tag>/<name>/<IP-Hash>. Der Tag
 * im Schlüssel macht das Aufräumen billig: gelegentlich werden Einträge von
 * vor zwei Tagen gelöscht.
 *
 * NOVEMBER 2026: DREI ERGÄNZUNGEN
 * -------------------------------
 * 1. IPv6 zählt je /64-Netz. Ein Anschluss bekommt meist ein ganzes /64 und
 *    kann darin beliebig viele Adressen nutzen. Wer innerhalb seines /64
 *    wechselt, zählt jetzt als ein Absender. IPv4 bleibt unverändert (gleiche
 *    Hashes wie vorher, laufende Zähler und Sperren gelten weiter).
 *
 * 2. Grenzen je Kennung (grenzen(), schutzKennung()): Teure Endpunkte zählen
 *    zusätzlich je E-Mail, Telefonnummer, Gutscheincode oder Gastgeber. Das
 *    greift auch bei wechselnden IP-Adressen, und Kunden hinter derselben
 *    Mobilfunk-IP (CGNAT) kommen sich nicht in die Quere. Gespeichert wird
 *    nur ein Hash: <Tag>/<name>.<art>/<sha256>.
 *
 * 3. Notbremse je Endpunkt (gesamtGrenze()): eine Obergrenze über ALLE
 *    Absender zusammen, gegen verteilte Angriffe aus vielen Netzen. Sie liegt
 *    weit über dem, was an einem vollen Tag am Truck vorkommt. Greift sie,
 *    bekommt Kubi höchstens einmal pro Stunde eine Telegram-Nachricht.
 *    Schlüssel <Tag>/<name>.gesamt/alle, Merker alarm/<name>.
 *
 * Alle Werte stehen in GRENZEN unten. Für alle drei gilt wie oben: interne
 * Aufrufe zählen nicht, bei einer Speicherstörung wird durchgelassen.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

function store() {
  const opts = { name: 'bremse', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

/* ---- IP-Adresse vereinheitlichen ----------------------------------------- */
// IPv6 in 8 Gruppen zerlegen ('::' aufgefüllt, IPv4 am Ende erlaubt). null bei Unsinn.
function ipv6Gruppen(ip) {
  let rest = ip;
  let v4 = null;
  const letzte = rest.lastIndexOf(':');
  if (rest.slice(letzte + 1).includes('.')) {
    v4 = rest.slice(letzte + 1);
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return null;
    rest = rest.slice(0, letzte + 1) + '0:0';
  }
  const doppel = rest.split('::');
  if (doppel.length > 2) return null;
  const links = doppel[0] ? doppel[0].split(':') : [];
  const rechts = doppel.length === 2 && doppel[1] ? doppel[1].split(':') : [];
  const fehlt = 8 - links.length - rechts.length;
  if (doppel.length === 1 ? fehlt !== 0 : fehlt < 1) return null;
  const gruppen = [...links, ...Array(doppel.length === 2 ? fehlt : 0).fill('0'), ...rechts];
  if (gruppen.length !== 8 || !gruppen.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return { gruppen: gruppen.map((g) => parseInt(g, 16)), v4 };
}

/**
 * Rohe Absenderadresse -> Zählkennung.
 * IPv4 bleibt wie sie ist. IPv6 wird auf das /64-Netz gekürzt, eine
 * IPv4-Adresse in IPv6-Schreibweise (::ffff:1.2.3.4) zählt als IPv4.
 */
function ipNormalisieren(roh) {
  let ip = String(roh || '').trim();
  if (!ip) return '';
  if (ip.startsWith('[')) ip = ip.slice(1).split(']')[0];
  const zone = ip.indexOf('%');
  if (zone > 0) ip = ip.slice(0, zone);
  if (!ip.includes(':')) return ip;
  ip = ip.toLowerCase();
  const p = ipv6Gruppen(ip);
  if (!p) return ip;                                   // unlesbar: wie bisher roh zählen
  const g = p.gruppen;
  if (p.v4 && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return p.v4;
  return g.slice(0, 4).map((x) => x.toString(16)).join(':') + '::/64';
}

/* Gleiche Regel wie lib/auth-guard.js: x-nf-client-connection-ip setzt Netlify
   selbst, der Aufrufer kann ihn nicht fälschen. */
function absender(event) {
  const h = (event && event.headers) || {};
  const roh = h['x-nf-client-connection-ip'] || String(h['x-forwarded-for'] || '').split(',')[0].trim() || '';
  const ip = ipNormalisieren(roh);
  return ip ? sha(ip).slice(0, 32) : null;
}

/* ---- Interne Aufrufe ------------------------------------------------------ */
// Aus einem Server-Geheimnis abgeleitet, das immer gesetzt ist. Der Header
// verrät das Geheimnis nicht, und ohne es lässt er sich nicht berechnen.
function internWert() {
  const geheim = process.env.INTERNAL_HOOK_SECRET || process.env.STATUS_UPDATE_SECRET || process.env.ADMIN_PASSWORD || '';
  return geheim ? crypto.createHmac('sha256', geheim).update('gnc-intern-v1').digest('hex') : '';
}
function internHeader() {
  const w = internWert();
  return w ? { 'x-gnc-intern': w } : {};
}
function istIntern(event) {
  const h = (event && event.headers) || {};
  const ist = String(h['x-gnc-intern'] || '');
  const soll = internWert();
  return !!soll && ist.length === soll.length && crypto.timingSafeEqual(Buffer.from(ist), Buffer.from(soll));
}

/* ---- Antworten ------------------------------------------------------------ */
const CORS = { 'Access-Control-Allow-Origin': '*' };
function antwort(statusCode, data, extra) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS, ...(extra || {}) },
    body: JSON.stringify(data),
  };
}

function groesse(event) {
  const b = (event && event.body) || '';
  return event && event.isBase64Encoded ? Math.floor(b.length * 3 / 4) : Buffer.byteLength(b);
}

/* ---- Aufräumen ------------------------------------------------------------ */
async function aufraeumen(s) {
  const alt = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  const { blobs } = await s.list({ prefix: alt + '/' });
  for (const b of blobs.slice(0, 200)) { try { await s.delete(b.key); } catch (e) {} }
}

/**
 * Grundschutz. Gibt eine fertige Antwort zurück, wenn abgelehnt wird, sonst null.
 * @param {object} o  name (Pflicht), max (Anfragen je Fenster), fensterMin (Standard 10),
 *                    maxKB (Standard 32)
 */
async function schutz(event, o) {
  if (event && event.httpMethod === 'OPTIONS') return null;   // Vorab-Anfrage des Browsers, zählt nicht
  const maxKB = o.maxKB || 32;
  if (groesse(event) > maxKB * 1024) {
    return antwort(413, { error: 'payload_too_large', hint: 'Die Anfrage ist zu groß.' });
  }
  if (istIntern(event)) return null;
  const ip = absender(event);
  if (!ip || !o.max) return null;

  try {
    const s = store();
    const z = await zaehlen(s, o.name + '/' + ip, o.max, o.fensterMin || 10);
    if (z.gesperrt) return antwort429(z.sek);
    if (Math.random() < 0.01) await aufraeumen(s);
  } catch (e) {
    console.error('bremse ' + o.name + ':', e.message);   // im Zweifel durchlassen
  }
  return null;
}

/* Ein Zähler im Fenster. Schlüssel bekommt den Tag vorangestellt (Aufräumen).
   Abgewiesene Anfragen zählen nicht weiter, der Zähler bleibt auf max. */
async function zaehlen(s, rest, max, fensterMin) {
  const fensterMs = fensterMin * 60 * 1000;
  const jetzt = Date.now();
  const key = new Date(jetzt).toISOString().slice(0, 10) + '/' + rest;
  const rec = await s.get(key, { type: 'json' });
  const frisch = !rec || jetzt - rec.seit > fensterMs;
  if (!frisch && rec.n >= max) {
    return { gesperrt: true, sek: Math.max(1, Math.ceil((rec.seit + fensterMs - jetzt) / 1000)), bis: rec.seit + fensterMs };
  }
  await s.setJSON(key, { n: frisch ? 1 : rec.n + 1, seit: frisch ? jetzt : rec.seit });
  return { gesperrt: false };
}

function antwort429(sek) {
  return antwort(429, { error: 'too_many_requests', hint: 'Zu viele Anfragen. Bitte in ein paar Minuten erneut versuchen.', retryAfter: sek }, { 'Retry-After': String(sek) });
}

/* ==========================================================================
   GRENZEN JE KENNUNG UND NOTBREMSE
   Werte: [höchstens, Fenster in Minuten]. Großzügig für echte Kunden:
   - mail/tel: eine Person, die mehrmals bestellt, sich vertippt oder bei
     abgelehnter Karte neu ansetzt, bleibt weit darunter.
   - code: GRILL5 prüft jeder Kunde, deshalb hoch. Bremst das Abfragen eines
     einzelnen Codes für viele Adressen (wer hat ihn schon dreimal genutzt?).
   - gastgeber: der Name, den der Gastgeber einer Gruppenbestellung eintippt.
   - gesamt: Notbremse über alle Absender, ein Vielfaches des vollsten Tages.
   ========================================================================== */
const GRENZEN = {
  'konto-code': { mail: [6, 60], gesamt: [100, 10] },                               // account.js request_code
  kasse:        { mail: [15, 60], tel: [15, 60], gesamt: [150, 10] },                // sumup-checkout.js
  bestellung:   { mail: [20, 60], tel: [20, 60], gesamt: [200, 10] },                // send-email.js Bestellwege
  gutschein:    { code: [300, 10], mail: [30, 10], tel: [30, 10], gesamt: [600, 10] }, // voucher-check.js
  catering:     { mail: [4, 60], gesamt: [20, 10] },                                 // send-email.js catering_request
  'gruppe-neu': { gastgeber: [15, 60], gesamt: [60, 10] },                           // group-order.js create
};
const BEZEICHNUNG = {
  'konto-code': 'Anmeldecodes fürs Kundenkonto',
  kasse: 'Online-Kasse',
  bestellung: 'Bestellungen',
  gutschein: 'Gutscheinprüfung',
  catering: 'Catering-Anfragen',
  'gruppe-neu': 'neue Gruppenbestellungen',
};

/* Kennung vereinheitlichen, damit Schreibweisen nicht als neue Person zählen.
   Leerer String = nichts zu zählen. */
function kennungVereinheitlichen(art, wert) {
  const roh = String(wert == null ? '' : wert).slice(0, 200);
  if (art === 'mail') {
    const m = require('./gutschein-nutzung').mailVereinheitlichen(roh);
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(m) ? m : '';
  }
  if (art === 'tel') return require('./gutschein-nutzung').telefonVereinheitlichen(roh);
  if (art === 'code') {
    const c = require('./gutschein-code').codeNormalisieren(roh);
    return c.length >= 3 ? c : '';
  }
  return roh.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * Grenze je Kennung. Gibt 429 zurück, wenn diese Kennung ihr Kontingent im
 * Fenster verbraucht hat, sonst null.
 * @param {object} o  name, art ('mail'|'tel'|'code'|'gastgeber'), wert, max, fensterMin (Standard 60)
 */
async function schutzKennung(event, o) {
  if (event && event.httpMethod === 'OPTIONS') return null;
  if (istIntern(event) || !o || !o.max) return null;
  const norm = kennungVereinheitlichen(o.art, o.wert);
  if (!norm) return null;
  try {
    const z = await zaehlen(store(), o.name + '.' + o.art + '/' + sha(o.art + ':' + norm).slice(0, 32), o.max, o.fensterMin || 60);
    if (z.gesperrt) {
      console.warn('bremse: ' + o.name + ' je ' + o.art + ' gesperrt (' + o.max + ' in ' + (o.fensterMin || 60) + ' Min)');
      return antwort429(z.sek);
    }
  } catch (e) {
    console.error('bremse ' + o.name + '.' + o.art + ':', e.message);   // im Zweifel durchlassen
  }
  return null;
}

/* Telegram an Kubi: je Endpunkt höchstens einmal pro Stunde. Der Merker liegt
   im Speicher (gilt für alle Function-Instanzen) und zusätzlich im
   Arbeitsspeicher, damit eine warme Instanz nicht bei jeder abgewiesenen
   Anfrage nachliest. */
const ALARM_PAUSE_MS = 60 * 60 * 1000;
const alarmZuletzt = {};
async function notbremseMelden(s, name, max, fensterMin, bis) {
  const jetzt = Date.now();
  if (alarmZuletzt[name] && jetzt - alarmZuletzt[name] < ALARM_PAUSE_MS) return false;
  const merker = await s.get('alarm/' + name, { type: 'json' });
  if (merker && jetzt - merker.at < ALARM_PAUSE_MS) { alarmZuletzt[name] = merker.at; return false; }
  alarmZuletzt[name] = jetzt;
  await s.setJSON('alarm/' + name, { at: jetzt });   // erst merken, dann senden: kein Doppel bei Gleichzeitigkeit
  const { telegram, esc } = require('./telegram');
  const uhr = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(new Date(bis));
  const was = BEZEICHNUNG[name] || name;
  await telegram(
    '<b>Notbremse: ' + esc(was) + '</b>\n'
    + 'In ' + fensterMin + ' Minuten kamen mehr als ' + max + ' Anfragen von vielen verschiedenen Absendern. '
    + 'Das sieht nach einem Angriff aus. Bis ' + uhr + ' Uhr weist die Seite weitere Anfragen dort ab, auch von echten Kunden.\n'
    + 'Interne Abläufe wie die Zahlungsbestätigung von SumUp laufen weiter. '
    + 'Hält es an, Pasquale Bescheid geben. Nächster Hinweis frühestens in einer Stunde.',
    { html: true },
  );
  return true;
}

/**
 * Notbremse: höchstens `max` Anfragen in `fensterMin` Minuten über ALLE
 * Absender zusammen. Darüber 429 und (höchstens stündlich) Telegram.
 * @param {object} o  name, max, fensterMin (Standard 10)
 */
async function gesamtGrenze(event, o) {
  if (event && event.httpMethod === 'OPTIONS') return null;
  if (istIntern(event) || !o || !o.max) return null;
  const fensterMin = o.fensterMin || 10;
  try {
    const s = store();
    const z = await zaehlen(s, o.name + '.gesamt/alle', o.max, fensterMin);
    if (z.gesperrt) {
      console.warn('bremse: Notbremse ' + o.name + ' (' + o.max + ' in ' + fensterMin + ' Min, alle Absender)');
      try { await notbremseMelden(s, o.name, o.max, fensterMin, z.bis); } catch (e) { console.error('bremse alarm:', e.message); }
      return antwort429(z.sek);
    }
  } catch (e) {
    console.error('bremse ' + o.name + '.gesamt:', e.message);   // im Zweifel durchlassen
  }
  return null;
}

/**
 * Alles für einen teuren Endpunkt in einem Aufruf, Werte aus GRENZEN:
 *
 *     const halt = await grenzen(event, 'kasse', { mail: email, tel: telefon });
 *     if (halt) return halt;
 *
 * Erst die Kennungen (parallel), dann die Notbremse. Wer schon an seiner
 * Kennung scheitert, zählt nicht mehr für die Notbremse.
 */
async function grenzen(event, name, werte) {
  const g = GRENZEN[name];
  if (!g) return null;
  const w = werte || {};
  const pruef = Object.keys(g)
    .filter((art) => art !== 'gesamt' && w[art])
    .map((art) => schutzKennung(event, { name, art, wert: w[art], max: g[art][0], fensterMin: g[art][1] }));
  const halt = (await Promise.all(pruef)).find(Boolean);
  if (halt) return halt;
  return g.gesamt ? gesamtGrenze(event, { name, max: g.gesamt[0], fensterMin: g.gesamt[1] }) : null;
}

/* ---- Eingaben säubern ----------------------------------------------------- */
// Kürzt Texte, entfernt Steuerzeichen (Zeilenumbruch und Tab bleiben), begrenzt
// Listen und Verschachtelung. Kein HTML-Escaping: das passiert beim Ausgeben
// (esc() in Mails, esc2() im Admin-Tool), sonst würde doppelt maskiert.
function saeubern(wert, o, tiefe) {
  const opt = o || {};
  const t = tiefe || 0;
  const maxText = opt.maxText || 2000;
  if (typeof wert === 'string') {
    return wert.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '').slice(0, maxText);
  }
  if (typeof wert === 'number') return Number.isFinite(wert) ? wert : 0;
  if (typeof wert === 'boolean' || wert === null) return wert;
  if (t >= (opt.maxTiefe || 6)) return null;
  if (Array.isArray(wert)) return wert.slice(0, opt.maxListe || 200).map((x) => saeubern(x, opt, t + 1));
  if (typeof wert === 'object') {
    const aus = {};
    for (const k of Object.keys(wert).slice(0, opt.maxFelder || 200)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      aus[saeubern(k, { maxText: 120 })] = saeubern(wert[k], opt, t + 1);
    }
    return aus;
  }
  return null;
}

module.exports = {
  schutz, saeubern, internHeader, istIntern, absender, ipNormalisieren,
  grenzen, schutzKennung, gesamtGrenze, kennungVereinheitlichen, GRENZEN,
};
