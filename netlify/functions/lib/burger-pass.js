/**
 * lib/burger-pass.js
 * ----------------------------------------------------------------------------
 * Burger-Pass, Version 1: ein Menü-Paket ohne automatische Verlängerung.
 * Der Kunde zahlt einmal (gehostete SumUp-Kasse, burger-pass.js) und bekommt
 * eine feste Zahl Menüs, die bis zu einem Ablaufdatum gelten.
 *
 * ZWEI ABLAGEN, EINE WAHRHEIT
 *   Kundendatensatz (Store 'customers'), Feld passMenus: Liste von Töpfen
 *     [{ pass, name, menus, gesamt, bis }]
 *   Getrennt von `menus` (Stempelkarte) und `rewards` (5-€-Boni). Diese Liste
 *   ist maßgeblich fürs Einlösen, online wie am Truck.
 *
 *   Pass-Datensatz (Store 'paesse', Schlüssel p:<Bestellnummer>): Käufer,
 *   Menüs gesamt und übrig, gültig bis, Bestellnummer der Zahlung, jede
 *   Einlösung, Erinnerungen. Für Nachweis, Admin-Liste und Erinnerungsmails.
 *
 * REGELN
 *   - Gutgeschrieben wird nur nach bestätigter Zahlung (SumUp meldet PAID,
 *     vom Server selbst abgefragt) und genau einmal: der Pass-Datensatz wird
 *     mit onlyIfNew angelegt, nur wer ihn anlegt, schreibt gut.
 *   - Eingelöst wird zuerst der Topf mit dem frühesten Ablauf.
 *   - Abgelaufene Töpfe zählen nicht mehr und werden beim nächsten Schreiben
 *     entfernt (verfallen). Die Erinnerung läuft täglich
 *     (burger-pass-erinnerung.js).
 *   - Welches Menü gratis ist, regelt speisekarte.js (gratisMenuWert), genau
 *     wie beim Menü aufs Haus.
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');

const PASS_STORE = 'paesse';
const TAG_MS = 86400000;

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

const ms = (x) => { const t = new Date(x).getTime(); return Number.isFinite(t) ? t : 0; };
const jetztMs = (jetzt) => (jetzt instanceof Date ? jetzt.getTime() : (Number(jetzt) || Date.now()));

/* ---------------------------------------------------------------------------
   Reine Funktionen auf dem Kundendatensatz (kein Speicher)
--------------------------------------------------------------------------- */

// Gültige Töpfe, frühester Ablauf zuerst
function gueltigeToepfe(cust, jetzt) {
  const t = jetztMs(jetzt);
  const liste = Array.isArray(cust && cust.passMenus) ? cust.passMenus : [];
  return liste
    .filter((b) => b && typeof b === 'object' && Number(b.menus) > 0 && ms(b.bis) > t)
    .sort((a, b) => ms(a.bis) - ms(b.bis));
}

function gueltigePassMenus(cust, jetzt) {
  return gueltigeToepfe(cust, jetzt).reduce((n, b) => n + Math.floor(Number(b.menus) || 0), 0);
}

// Der Topf, aus dem das nächste Menü käme (oder null)
function naechsterPass(cust, jetzt) {
  const b = gueltigeToepfe(cust, jetzt)[0];
  return b ? { id: b.pass, name: b.name || 'Burger-Pass', bis: b.bis } : null;
}

/* Entfernt leere und abgelaufene Töpfe. Gibt die verfallenen zurück
   (abgelaufen mit Menüs übrig), damit der Aufrufer sie vermerken kann. */
function aufraeumen(cust, jetzt) {
  if (!cust || !Array.isArray(cust.passMenus)) return [];
  const t = jetztMs(jetzt);
  const verfallen = [];
  cust.passMenus = cust.passMenus.filter((b) => {
    if (!b || typeof b !== 'object') return false;
    if (ms(b.bis) <= t) { if (Number(b.menus) > 0) verfallen.push({ ...b }); return false; }
    return Number(b.menus) > 0;
  });
  return verfallen;
}

/* Ein Pass-Menü abziehen, frühester Ablauf zuerst. Ändert cust direkt.
   Rückgabe: Bezug { pass, name, nr, gesamt, uebrig, bis } oder null. */
function passMenuAbziehen(cust, jetzt) {
  const b = gueltigeToepfe(cust, jetzt)[0];
  if (!b) return null;
  b.menus = Math.floor(Number(b.menus)) - 1;
  const bezug = {
    pass: b.pass, name: b.name || 'Burger-Pass',
    nr: (Number(b.gesamt) || 0) - b.menus, gesamt: Number(b.gesamt) || 0,
    uebrig: b.menus, bis: b.bis,
  };
  aufraeumen(cust, jetzt);
  return bezug;
}

// Für das Kundenkonto: Summe und je Pass „3 von 4, gültig bis …"
function uebersicht(cust, jetzt) {
  const liste = gueltigeToepfe(cust, jetzt).map((b) => ({
    id: b.pass, name: b.name || 'Burger-Pass',
    menus: Math.floor(Number(b.menus) || 0), gesamt: Number(b.gesamt) || 0, bis: b.bis,
  }));
  return { menus: liste.reduce((n, b) => n + b.menus, 0), liste };
}

// Topf gutschreiben (idempotent je Pass-ID)
function topfAnlegen(cust, pass) {
  cust.passMenus = Array.isArray(cust.passMenus) ? cust.passMenus : [];
  if (cust.passMenus.some((b) => b && b.pass === pass.id)) return false;
  cust.passMenus.push({ pass: pass.id, name: pass.name, menus: pass.menusGesamt, gesamt: pass.menusGesamt, bis: pass.gueltigBis });
  return true;
}

/* ---------------------------------------------------------------------------
   Mit Speicher
--------------------------------------------------------------------------- */

function kundenSchluessel(mail) {
  const crypto = require('crypto');
  return 'c:' + crypto.createHash('sha256').update(String(mail || '').trim().toLowerCase()).digest('hex');
}

/* Ende des letzten gültigen Tages (Europe/Berlin): Wer am 1. kauft und 60 Tage
   bekommt, kann bis einschließlich zum 60. Tag danach einlösen, bis 23:59. */
function gueltigBisBerechnen(abMs, tage) {
  const tag = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(abMs + tage * TAG_MS));
  // 23:59:59 in Berlin. Sommer-/Winterzeit: Versatz für genau diesen Tag ermitteln.
  const probe = new Date(tag + 'T12:00:00Z');
  const berlin = new Date(probe.toLocaleString('en-US', { timeZone: 'Europe/Berlin' }));
  const utc = new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }));
  const versatzMin = Math.round((berlin - utc) / 60000);
  return new Date(Date.parse(tag + 'T23:59:59Z') - versatzMin * 60000).toISOString();
}

/* Pass ausstellen. rec ist der Archiv-Eintrag (Store 'orders', kind
   'burgerpass') einer Zahlung, die SumUp als PAID bestätigt hat. Der Aufrufer
   hat das geprüft; diese Funktion fragt SumUp nicht selbst.
   Rückgabe { neu, pass }. neu = false heißt: gab es schon, nichts gebucht. */
async function passAusstellen(rec, jetzt) {
  const t = jetztMs(jetzt);
  const bp = (rec && rec.bp) || {};
  const ref = String(rec && rec.reference || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 60);
  if (!ref || !bp.email) throw new Error('burger-pass: Vorgang unvollständig');
  const ps = store(PASS_STORE);
  const key = 'p:' + ref;

  const pass = {
    id: ref,
    name: bp.name || 'Burger-Pass',
    kaeufer: { email: bp.email, name: bp.kundeName || '' },
    menusGesamt: Math.max(1, Math.floor(Number(bp.menus) || 1)),
    menusUebrig: Math.max(1, Math.floor(Number(bp.menus) || 1)),
    tage: Math.floor(Number(bp.tage) || 0),
    preis: Number(bp.preis) || 0,
    gekauftAm: new Date(t).toISOString(),
    gueltigBis: gueltigBisBerechnen(t, Math.floor(Number(bp.tage) || 0)),
    bestellnummer: ref,
    checkoutId: rec.checkoutId || null,
    lang: bp.lang || 'de',
    status: 'aktiv',
    gutgeschrieben: false,
    einloesungen: [],
    erinnert: { letztes: null, ablauf: null },
  };

  const vorhanden = await ps.get(key, { type: 'json' });
  if (vorhanden) return { neu: false, pass: vorhanden };
  const w = await ps.setJSON(key, pass, { onlyIfNew: true });
  if (w && w.modified === false) {
    return { neu: false, pass: (await ps.get(key, { type: 'json' })) || pass };
  }

  // Nur wer den Datensatz angelegt hat, schreibt gut.
  const cs = store('customers');
  const ck = kundenSchluessel(bp.email);
  const cust = (await cs.get(ck, { type: 'json' })) || {
    email: String(bp.email).trim().toLowerCase(), name: '', phone: '', addresses: [],
    spent: 0, rewards: 0, tokens: {}, createdAt: new Date(t).toISOString(),
  };
  aufraeumen(cust, t);
  topfAnlegen(cust, pass);
  await cs.setJSON(ck, cust);
  pass.gutgeschrieben = true;
  await ps.setJSON(key, pass);
  return { neu: true, pass };
}

/* Einlösung im Pass-Datensatz vermerken (nach dem Abziehen im Kundendatensatz).
   Wirft nie: der Kundendatensatz ist maßgeblich. */
async function einloesungVermerken(bezug, info) {
  if (!bezug || !bezug.pass) return;
  try {
    const ps = store(PASS_STORE);
    const key = 'p:' + bezug.pass;
    const p = await ps.get(key, { type: 'json' });
    if (!p) return;
    p.menusUebrig = Math.max(0, Number(bezug.uebrig) || 0);
    p.einloesungen = Array.isArray(p.einloesungen) ? p.einloesungen : [];
    p.einloesungen.push({ at: new Date().toISOString(), nr: bezug.nr, ...(info || {}) });
    p.einloesungen = p.einloesungen.slice(-50);
    if (p.menusUebrig <= 0) p.status = 'verbraucht';
    await ps.setJSON(key, p);
  } catch (e) {
    console.error('burger-pass vermerken:', e && e.message);
  }
}

/* Für send-email (online) und loyalty-scan (Truck): ein Menü aus der
   Stempelkarte ODER aus dem Pass abziehen. Pass zuerst, wenn einer gilt.
   Ändert cust direkt; Rückgabe { quelle: 'pass'|'karte'|null, bezug }. */
function menuAbziehen(cust, jetzt, nurPass) {
  const bezug = passMenuAbziehen(cust, jetzt);
  if (bezug) return { quelle: 'pass', bezug };
  if (nurPass) return { quelle: null, bezug: null };
  if ((cust.menus || 0) >= 1) {
    cust.menus = cust.menus - 1;
    return { quelle: 'karte', bezug: null };
  }
  return { quelle: null, bezug: null };
}

/* Bezahlten Kauf abschließen: Pass ausstellen, Archiv-Eintrag auf
   „completed“, beim ersten Mal Kaufmail und Telegram. Aufrufer: sumup-webhook
   (nach eigener PAID-Prüfung bei SumUp) und burger-pass.js (Aktion 'pruefen',
   ebenfalls nach eigener PAID-Prüfung). os = Store 'orders', key = 'o:<ref>'. */
async function kaufAbschliessen(os, key, rec) {
  const r = await passAusstellen(rec);
  rec.status = 'completed';
  rec.completedAt = rec.completedAt || new Date().toISOString();
  rec.passId = r.pass.id;
  try { await os.setJSON(key, rec); } catch (e) { console.error('burger-pass Archiv:', e && e.message); }
  if (r.neu) {
    try {
      const { telegram, esc } = require('./telegram');
      const p = r.pass;
      await telegram('<b>' + esc(p.name) + ' verkauft</b>\n'
        + Number(p.preis).toFixed(2).replace('.', ',') + ' € · ' + p.menusGesamt + ' Menüs · gültig bis '
        + require('./burger-pass-post').datumText(p.gueltigBis, 'de') + '\n'
        + esc(p.kaeufer.name || '-') + ' (' + esc(p.kaeufer.email) + ')\n#' + esc(p.bestellnummer), { html: true });
    } catch (e) {}
    try { await require('./burger-pass-post').senden('kauf', r.pass); } catch (e) {}
  }
  return r;
}

/* Kurzform für Bestellung, Ticket und Archiv (Feld `pass` der Bestellung) */
function bestellBezug(b) {
  if (!b) return null;
  const id = b.pass || b.id;
  if (!id) return null;
  return {
    id: String(id).slice(0, 60), name: String(b.name || 'Burger-Pass').slice(0, 40),
    ...(b.nr ? { nr: b.nr, gesamt: b.gesamt } : {}), bis: b.bis || null,
  };
}

module.exports = {
  PASS_STORE, store, kundenSchluessel,
  gueltigeToepfe, gueltigePassMenus, naechsterPass, aufraeumen, passMenuAbziehen,
  uebersicht, topfAnlegen, gueltigBisBerechnen, passAusstellen, einloesungVermerken,
  menuAbziehen, bestellBezug, kaufAbschliessen,
};
