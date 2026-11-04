/**
 * lib/geschenk.js
 * ----------------------------------------------------------------------------
 * Geschenkgutscheine (Seite /gutscheine): Eingaben prüfen, nach der Zahlung
 * genau einen Code ausstellen, Käufer und beschenkte Person mailen, Versand
 * zum Wunschdatum, PDF-Link.
 *
 * Speicher "vouchers":
 *   c:<CODE>    der einlösbare Gutschein (wie bisher, liest preisberechnung.js)
 *   gd:<CODE>   Geschenk-Daten: Namen, Nachricht, Zustellung, PDF-Schlüssel
 *   gz:<YYYY-MM-DD>:<CODE>   Auftrag: Mail an die beschenkte Person an
 *               diesem Tag ab 8 Uhr (Berlin). giftcard-zustellung.js arbeitet
 *               die fälligen Aufträge ab, auch fehlgeschlagene Sofort-Mails.
 * Speicher "orders":
 *   o:GNC-GC-…  der Kaufvorgang (wie bisher)
 *   gl:GNC-GC-… Sperre, damit Webhook, Rückkehr der Kundin und Abgleich
 *               nie zwei Codes für denselben Kauf erzeugen
 *
 * Einlöseregel unverändert (AGB § 8): ein Code, einmal einlösbar, ab einem
 * Bestellwert in Höhe des Gutscheinwerts, 3 Jahre gültig.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const MIN_BETRAG = 10;
const MAX_BETRAG = 200;
const NACHRICHT_MAX = 300;
const NAME_MAX = 40;
const ZUSTELL_STUNDE = 8;          // Wunschdatum: Mail ab 8 Uhr Berlin
const VORLAUF_MAX_TAGE = 365;      // Wunschdatum höchstens ein Jahr im Voraus
const GUELTIG_TAGE = 3 * 365;      // 3 Jahre ab Kauf (AGB § 8)

// Vorschläge auf der Seite. Der Server prüft, dass Betrag und Vorschlag
// zusammenpassen, sonst steht „Gedacht für“ ohne Grundlage auf der Karte.
const VORSCHLAEGE = {
  menue: { betrag: 15, titel: 'Ein Burger-Menü' },
  zwei: { betrag: 30, titel: 'Menü für zwei' },
  abend: { betrag: 50, titel: 'Ein Abend mit Freunden' },
  crew: { betrag: 100, titel: 'Mittag für die Crew' },
};

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}
const seite = () => (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');

/* ---- Datum in Berlin ---------------------------------------------------- */
function berlin(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(d || new Date()).map((x) => [x.type, x.value]));
  return { tag: p.year + '-' + p.month + '-' + p.day, stunde: Number(p.hour) };
}
function tagePlus(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n, 12));
  return t.toISOString().slice(0, 10);
}
const deDatum = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso.split('-').reverse().join('.') : '');

/* ---- Eingaben ----------------------------------------------------------- */
function text(v, max) {
  return String(v == null ? '' : v).replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function nachricht(v) {
  return String(v == null ? '' : v)
    .replace(/[<>]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, NACHRICHT_MAX);
}

/**
 * Kaufdaten aus dem Formular prüfen.
 * Ältere Seitenstände (ohne v: 2) schicken nur Betrag, E-Mail und Namen:
 * dann geht der Gutschein wie früher nur an die Käuferin.
 * @returns {{ ok: true, gift } | { ok: false, error }}
 */
function eingabePruefen(input, jetzt) {
  const neu = Number(input.v) === 2;
  const amount = Math.round(parseFloat(input.amount) || 0);
  if (!(amount >= MIN_BETRAG && amount <= MAX_BETRAG) || String(Math.round(amount)) !== String(amount)) return { ok: false, error: 'bad_amount' };
  const email = String(input.email || '').trim().toLowerCase().slice(0, 120);
  if (!EMAIL.test(email)) return { ok: false, error: 'bad_email' };
  const buyerName = text(input.buyerName, NAME_MAX);
  const recipientName = text(input.recipientName, NAME_MAX);
  if (!neu) return { ok: true, gift: { amount, email, buyerName, recipientName, delivery: 'self' } };

  if (input.terms !== true) return { ok: false, error: 'terms' };
  if (!buyerName) return { ok: false, error: 'bad_buyer' };
  const delivery = input.delivery === 'mail' ? 'mail' : 'print';
  let preset = String(input.preset || '');
  if (!VORSCHLAEGE[preset] || VORSCHLAEGE[preset].betrag !== amount) preset = '';
  const message = nachricht(input.message);
  const gift = { amount, email, buyerName, recipientName, delivery, preset, message, recipientEmail: '', sendOn: '' };
  if (delivery === 'mail') {
    if (!recipientName) return { ok: false, error: 'bad_recipient' };
    const recipientEmail = String(input.recipientEmail || '').trim().toLowerCase().slice(0, 120);
    if (!EMAIL.test(recipientEmail)) return { ok: false, error: 'bad_recipient_email' };
    gift.recipientEmail = recipientEmail;
    const sendOn = String(input.sendOn || '');
    if (sendOn) {
      const heute = berlin(jetzt).tag;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sendOn) || sendOn <= heute || sendOn > tagePlus(heute, VORLAUF_MAX_TAGE)) {
        return { ok: false, error: 'bad_date' };
      }
      gift.sendOn = sendOn;
    }
  }
  return { ok: true, gift };
}

/* ---- Code ausstellen ---------------------------------------------------- */
async function sperren(os, reference) {
  const k = 'gl:' + reference;
  const neu = { at: Date.now() };
  try {
    const r = await os.setJSON(k, neu, { onlyIfNew: true });
    if (r && r.modified === false) {
      const alt = await os.get(k, { type: 'json' });
      // Hängengebliebene Sperre (Abbruch mitten im Ausstellen): nach 2 Minuten freigeben
      if (alt && Date.now() - (alt.at || 0) < 120000) return false;
      await os.setJSON(k, neu);
    }
  } catch (e) { /* Speicher ohne onlyIfNew: Statusprüfung unten genügt */ }
  return true;
}

async function neuerCode(vs) {
  let code = '';
  for (let versuch = 0; versuch < 8; versuch++) {
    code = 'GNC';
    const buf = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) code += ALPHA[buf[i] % ALPHA.length];
    if (!(await vs.get('c:' + code, { type: 'json' }))) return code;
  }
  return code;
}

/**
 * Nach Zahlungseingang: Code erzeugen, Gutschein anlegen, Mails verschicken.
 * Genau einmal je Kauf (Status "pending" plus Sperre gl:).
 * @param rec  Kaufvorgang aus o:<reference> (kind giftcard)
 * @param o    { os, key, quelle, umsatz(os, patch) }
 * @returns {{ code, mailOk, doppelt? }}
 */
async function ausstellen(rec, o) {
  const os = o.os;
  const reference = o.key.slice(2);
  if (rec.status === 'completed' && rec.code) return { code: rec.code, mailOk: true, doppelt: true };
  if (!(await sperren(os, reference))) return { code: null, mailOk: false, doppelt: true };
  // Nach der Sperre frisch lesen: ein paralleler Lauf könnte gerade fertig geworden sein
  const frisch = (await os.get(o.key, { type: 'json' })) || rec;
  if (frisch.status === 'completed' && frisch.code) return { code: frisch.code, mailOk: true, doppelt: true };

  const vs = store('vouchers');
  const g = frisch.gift || {};
  const code = await neuerCode(vs);
  const validUntil = new Date(Date.now() + GUELTIG_TAGE * 86400000).toISOString().slice(0, 10);
  const jetzt = new Date().toISOString();
  await vs.setJSON('c:' + code, {
    code, type: 'fixed', value: g.amount, maxDiscount: 0,
    minOrder: g.amount,          // einlösbar ab Bestellwert in Gutscheinhöhe
    validFrom: null, validUntil, maxUses: 1, oncePerCustomer: false,
    combinable: false, mode: 'any', active: true, giftcard: true,
    note: 'Geschenkgutschein · Käufer: ' + (g.buyerName || g.email) + (g.recipientName ? ' · Für: ' + g.recipientName : ''),
    createdAt: jetzt, createdBy: o.quelle || 'Shop (Online-Kauf)',
    uses: 0, usedBy: {},
  });
  const details = {
    code, reference, amount: g.amount, validUntil, createdAt: jetzt,
    preset: g.preset || '', buyerName: g.buyerName || '', buyerEmail: g.email,
    recipientName: g.recipientName || '', recipientEmail: g.recipientEmail || '',
    message: g.message || '', delivery: g.delivery || 'self', sendOn: g.sendOn || '',
    pdfToken: crypto.randomBytes(18).toString('hex'),
    belegToken: crypto.randomBytes(18).toString('hex'),   // nur für die Käuferin
    recipientMailedAt: null, tries: 0,
  };
  await vs.setJSON('gd:' + code, details);
  // Kaufbeleg archivieren (aufbewahrungspflichtig, wie die Rechnungen inv:…)
  try {
    const { belegDaten } = require('./geschenk-beleg');
    await store('invoices').setJSON('gs:' + reference, belegDaten(details));
  } catch (e) { console.error('Gutschein-Beleg ablegen:', e.message); }

  frisch.status = 'completed';
  frisch.completedAt = jetzt;
  frisch.code = code;
  try { await os.setJSON(o.key, frisch); } catch (e) {}
  if (o.umsatz) await o.umsatz(os, { gcCount: 1, gcTotal: g.amount || frisch.total || 0 });

  const mail = require('./geschenk-mail');
  let mailOk = false;
  try { mailOk = await mail.kaeuferMail(details); } catch (e) { console.error('Gutschein Käufer-Mail:', e.message); }
  if (details.delivery === 'mail') {
    if (details.sendOn) await vs.setJSON('gz:' + details.sendOn + ':' + code, { code, at: jetzt });
    else {
      const ok = await zustellen(code).catch(() => false);
      if (!ok) await vs.setJSON('gz:' + berlin().tag + ':' + code, { code, at: jetzt, retry: true });
    }
  }
  try { await mail.betreiberInfo(details); } catch (e) {}
  return { code, mailOk };
}

/** Mail an die beschenkte Person. true, wenn verschickt oder nicht mehr nötig. */
async function zustellen(code) {
  const vs = store('vouchers');
  const d = await vs.get('gd:' + code, { type: 'json' });
  if (!d || d.delivery !== 'mail' || !d.recipientEmail) return true;
  if (d.recipientMailedAt) return true;
  const v = await vs.get('c:' + code, { type: 'json' });
  if (!v || v.active === false) return true;        // rückerstattet: nichts mehr verschicken
  let ok = false;
  try { ok = await require('./geschenk-mail').empfaengerMail(d); } catch (e) { console.error('Gutschein Empfänger-Mail:', e.message); }
  if (ok) d.recipientMailedAt = new Date().toISOString();
  else d.tries = (d.tries || 0) + 1;
  await vs.setJSON('gd:' + code, d);
  return ok;
}

/**
 * Fällige Zustellungen abarbeiten (giftcard-zustellung.js, stündlich).
 * Fällig: Tag vor heute, oder heute ab 8 Uhr Berlin.
 */
async function faelligeZustellen(jetzt) {
  const vs = store('vouchers');
  const { tag, stunde } = berlin(jetzt);
  const ergebnis = { verschickt: 0, offen: 0, fehler: 0 };
  let liste = [];
  try { liste = (await vs.list({ prefix: 'gz:' })).blobs || []; } catch (e) { return ergebnis; }
  for (const b of liste) {
    const datum = b.key.slice(3, 13);
    const code = b.key.slice(14);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(datum) || !code) continue;
    if (datum > tag) { ergebnis.offen++; continue; }
    if (datum === tag && stunde < ZUSTELL_STUNDE) {
      // Wunschdatum heute: erst ab 8 Uhr. Wiederholung einer Sofort-Mail: gleich.
      const auftrag = await vs.get(b.key, { type: 'json' }).catch(() => null);
      if (!auftrag || !auftrag.retry) { ergebnis.offen++; continue; }
    }
    const ok = await zustellen(code).catch(() => false);
    if (ok) { await vs.delete(b.key); ergebnis.verschickt++; continue; }
    ergebnis.fehler++;
    const d = await vs.get('gd:' + code, { type: 'json' }).catch(() => null);
    if (d && d.tries === 3) {
      try {
        const { telegram, esc } = require('./telegram');
        await telegram('⚠️ <b>Gutschein-Mail hängt</b>\n' + esc(code) + ' an ' + esc(d.recipientEmail) + ' klappt seit 3 Versuchen nicht.', { html: true });
      } catch (e) {}
    }
  }
  return ergebnis;
}

/* ---- Lesen für Danke-Ansicht, Prüfen und PDF ----------------------------- */
function pdfLink(d, download, art) {
  const beleg = art === 'beleg';
  return seite() + '/.netlify/functions/giftcard-pdf?c=' + encodeURIComponent(d.code) + '&t=' + (beleg ? d.belegToken : d.pdfToken)
    + (beleg ? '&art=beleg' : '') + (download ? '&dl=1' : '');
}

/** Was die Käuferin nach der Zahlung sieht (giftcard-status.js). */
function kaeuferSicht(d) {
  return {
    code: d.code, amount: d.amount, validUntil: d.validUntil,
    recipientName: d.recipientName, delivery: d.delivery, sendOn: d.sendOn,
    recipientMailed: !!d.recipientMailedAt,
    pdf: pdfLink(d, false), pdfDownload: pdfLink(d, true),
    beleg: d.belegToken ? pdfLink(d, true, 'beleg') : null,
  };
}

function tokenStimmt(d, t, art) {
  const a = Buffer.from(String(d && (art === 'beleg' ? d.belegToken : d.pdfToken) || ''));
  const b = Buffer.from(String(t || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Gutschein prüfen (Seite „Gutschein prüfen“). Verrät nur Wert, Gültigkeit
 * und ob er noch offen ist, keine Namen, keine Adressen.
 */
async function pruefen(code, jetzt) {
  const vs = store('vouchers');
  const v = await vs.get('c:' + code, { type: 'json' });
  if (!v || !v.giftcard) return { valid: false, reason: 'unknown' };
  const heute = berlin(jetzt).tag;
  const basis = { code, value: v.value, minOrder: v.minOrder || v.value, validUntil: v.validUntil || '' };
  if (v.active === false) return { valid: false, reason: 'inactive', ...basis };
  if (v.validUntil && v.validUntil < heute) return { valid: false, reason: 'expired', ...basis };
  if ((v.uses || 0) >= (v.maxUses || 1)) return { valid: false, reason: 'used', ...basis };
  return { valid: true, ...basis };
}

module.exports = {
  MIN_BETRAG, MAX_BETRAG, NACHRICHT_MAX, NAME_MAX, VORSCHLAEGE, ZUSTELL_STUNDE,
  store, seite, berlin, tagePlus, deDatum,
  eingabePruefen, ausstellen, zustellen, faelligeZustellen,
  kaeuferSicht, pdfLink, tokenStimmt, pruefen,
};
