/**
 * bestellung-intern.js
 * ----------------------------------------------------------------------------
 * Telefon- und Laufkundschaft ins System: das Team legt im Admin-Tool
 * („Neue Bestellung") Bestellungen an, die nicht online kamen.
 *
 *   POST { password, action: 'anlegen', bestellung: {
 *            quelle: 'telefon' | 'truck',
 *            korb: [ { menuId, qty, double?, isMenu?, side?, drink?, dip? } ],
 *            mode: 'pickup' | 'delivery',
 *            zone?: 0..2            (Lieferung: Index in DELIVERY_ZONES)
 *            adresse?: { street, zip, city }   (Lieferung: Pflicht)
 *            name?, phone? (Lieferung: Pflicht), email?, note?,
 *            zahlart: 'bar' | 'karte' | 'offen' } }
 *        → { ok, reference, abholnr, total, statusUrl, mailed }
 *
 *   POST { password, action: 'bezahlt', reference, zahlart: 'bar' | 'karte' }
 *        Offene Zahlung am Tresen kassiert.
 *
 *   POST { password, action: 'stornieren', reference }
 *        Eingabefehler zurücknehmen: nur Bestellungen aus diesem Weg,
 *        status → 'cancelled', Tagesumsatz wird zurückgebucht.
 *
 * Anmeldung wie orders-list/orders-action (Sitzungs-Token mit 2FA, alle
 * Team-Rollen). Preis über lib/preisberechnung.js (betragErmitteln), also
 * dieselbe Rechnung wie online, in v1 ohne Gutscheine, Stempelkarte und
 * Trinkgeld.
 *
 * DATENSATZ (Store orders, o:GNC-<ms>, gleiches Format wie online)
 *   status 'completed', fstate 'confirmed', quelle, abholnr, abholTag,
 *   angelegtVon, order: { …, payment: 'cash', zahlart, bezahlt, paidWith }
 * payment 'cash' heißt für alle vorhandenen Stellen „vor Ort" (Admin-Liste,
 * Rechnung, Mails), zahlart sagt genauer, wie. accrued: true, damit nie eine
 * Stempelkarte gutgeschrieben wird (es gibt hier kein Kundenkonto).
 * Umsatz: Tagesaggregat rev:YYYY-MM-DD wie send-email (oCount, oTotal,
 * pickup/delivery) plus telefonCount/telefonTotal bzw. truckCount/truckTotal;
 * das Cockpit zählt den
 * Datensatz ohnehin selbst.
 *
 * ACHTUNG für später: Werden einmal Umsätze des SumUp-Kartenterminals
 * importiert, stecken die zahlart-'karte'-Bestellungen von hier schon im
 * Tagesumsatz. Sie dürfen dann nicht doppelt zählen.
 *
 * Mail: nur wenn eine E-Mail-Adresse angegeben ist (send-email, Art
 * 'intern_bestaetigung', nur intern aufrufbar). Ohne Adresse keine Mail.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { schutz, internHeader } = require('./lib/bremse');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung } = require('./lib/admin-sitzung');
const { mitglied } = require('./lib/team-passwort');
const { betragErmitteln } = require('./lib/preisberechnung');
const { vergebeAbholnr, berlinTag, nrText } = require('./lib/abholnummer');

let SK = null;
try { SK = require('../../speisekarte.js'); } catch (e) { SK = null; }

const QUELLEN = ['telefon', 'truck'];
const ZAHLARTEN = ['bar', 'karte', 'offen'];
const ZAHL_TEXT = { bar: 'Bar', karte: 'Karte (SumUp-Terminal)', offen: 'Offen' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  body: JSON.stringify(data),
});

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

async function authRole(pw) {
  if (!pw) return null;
  const admin = process.env.ADMIN_PASSWORD || '';
  if (admin && pw === admin) return { role: 'superadmin', name: 'Kubi' };
  try {
    const t = store('team');
    const { blobs } = await t.list({ prefix: 'u:' });
    const { key, u } = (await mitglied(t, pw, blobs)) || {};
    if (u) return { role: u.role === 'admin' ? 'admin' : 'staff', name: u.name || key.slice(2) };
  } catch (e) {}
  return null;
}

async function auditLog(who, action, detail) {
  try {
    const key = 'a:' + new Date().toISOString() + '_' + Math.random().toString(36).slice(2, 7);
    await store('audit').setJSON(key, {
      at: new Date().toISOString(),
      name: (who && who.name) || '?',
      role: (who && who.role) || '?',
      action,
      detail: String(detail || '').slice(0, 300),
    });
  } catch (e) {}
}

/* Tagesumsatz wie addRevenue() in send-email.js, aber für einen bestimmten Tag
   (Storno bucht auf den Tag der Bestellung zurück). */
async function addRevenue(tag, patch) {
  try {
    const s = store('orders');
    const key = 'rev:' + tag;
    const agg = (await s.get(key, { type: 'json' })) || {
      oCount: 0, oTotal: 0, pickupCount: 0, pickupTotal: 0,
      deliveryCount: 0, deliveryTotal: 0, gcCount: 0, gcTotal: 0,
    };
    for (const [k, v] of Object.entries(patch)) {
      agg[k] = Math.round(((agg[k] || 0) + v) * 100) / 100;
    }
    await s.setJSON(key, agg);
  } catch (e) { console.error('bestellung-intern Umsatz:', e && e.message); }
}
function umsatzPatch(order, quelle, faktor) {
  const t = (typeof order.total === 'number' ? order.total : 0) * faktor;
  const lief = order.mode === 'delivery';
  return {
    oCount: faktor, oTotal: t,
    pickupCount: lief ? 0 : faktor, pickupTotal: lief ? 0 : t,
    deliveryCount: lief ? faktor : 0, deliveryTotal: lief ? t : 0,
    [quelle + 'Count']: faktor, [quelle + 'Total']: t,
  };
}

/* ---------------- Eingaben ---------------- */
function text(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}
function notiz(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '')
    .trim().slice(0, 300);
}
const istMail = (m) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/.test(m);
const ziffern = (p) => String(p || '').replace(/\D/g, '').length;

/* Zeile aus dem Admin prüfen und so bauen wie der Warenkorb in index.html
   (gleiche Schlüssel, gleiche Felder). Liefert [key, entry] oder einen Fehler. */
function zeile(roh) {
  if (!roh || typeof roh !== 'object') return { fehler: 'zeile_ungueltig' };
  const item = SK.MENU.find((m) => m.id === roh.menuId);
  if (!item) return { fehler: 'artikel_unbekannt' };
  const qty = Number(roh.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > 99) return { fehler: 'menge_ungueltig' };
  const burger = item.cat === 'burger';
  const dbl = !!roh.double && burger && !SK.DOUBLE_PATTY_EXCLUDE_IDS.includes(item.id);
  if (burger && roh.isMenu) {
    const side = SK.MENU_SIDE_OPTIONS.some((s) => s.id === roh.side) ? roh.side : SK.MENU_SIDE_OPTIONS[0].id;
    const drink = SK.MENU_DRINK_IDS.includes(roh.drink) ? roh.drink : SK.MENU_DRINK_IDS[0];
    const dip = SK.MENU_DIP_IDS.includes(roh.dip) ? roh.dip : SK.MENU_DIP_IDS[0];
    const key = `${item.id}${dbl ? '__double' : ''}__menu__${side}__${drink}__${dip}`;
    return { key, entry: { menuId: item.id, qty, double: dbl, isMenu: true, side, drink, dip } };
  }
  if (item.includesDip) {
    const dip = SK.MENU_DIP_IDS.includes(roh.dip) ? roh.dip : SK.MENU_DIP_IDS[0];
    return { key: `${item.id}__dip-${dip}`, entry: { menuId: item.id, qty, double: false, dip } };
  }
  return { key: dbl ? `${item.id}__double` : item.id, entry: { menuId: item.id, qty, double: dbl } };
}

const kurzDip = (id) => { const d = SK.MENU.find((m) => m.id === id); return d ? d.name.replace(/^(Dip|Sos):\s*/, '') : ''; };
const name = (id) => { const d = SK.MENU.find((m) => m.id === id); return d ? d.name : ''; };

/* Positionen wie in index.html (submitOrder), deutsche Namen */
function positionen(korb) {
  return Object.keys(korb).map((key) => {
    const e = korb[key];
    const item = SK.MENU.find((m) => m.id === e.menuId);
    const preis = SK.einzelpreis(e);
    let anzeige;
    if (e.isMenu) {
      const side = SK.MENU_SIDE_OPTIONS.find((s) => s.id === e.side) || SK.MENU_SIDE_OPTIONS[0];
      anzeige = `${item.name}-Menü${e.double ? ' (Double Patty)' : ''} [${side.label}, ${name(e.drink)}, ${kurzDip(e.dip)}]`;
    } else {
      anzeige = e.double ? `${item.name} (Double Patty)` : item.name;
      if (e.dip) anzeige += ` [${kurzDip(e.dip)}]`;
    }
    return {
      name: anzeige, qty: e.qty,
      price: Math.round(preis * 100) / 100,
      total: Math.round(preis * e.qty * 100) / 100,
      double: !!e.double, isMenu: !!e.isMenu,
    };
  });
}

function statusUrl(ref) {
  const secret = process.env.STATUS_UPDATE_SECRET || '';
  const k = crypto.createHash('sha256').update(ref + '|' + secret).digest('hex').slice(0, 20);
  const siteUrl = (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');
  return siteUrl + '/s/' + ref + '?k=' + k;
}

/* ---------------- Aktionen ---------------- */
async function anlegen(who, b) {
  if (!SK) return json(500, { error: 'speisekarte_fehlt' });
  if (!b || typeof b !== 'object') return json(400, { error: 'bad_request' });
  const quelle = QUELLEN.includes(b.quelle) ? b.quelle : null;
  if (!quelle) return json(400, { error: 'quelle_fehlt', hint: 'Telefon oder Truck wählen' });
  const zahlart = ZAHLARTEN.includes(b.zahlart) ? b.zahlart : null;
  if (!zahlart) return json(400, { error: 'zahlart_fehlt', hint: 'Bar, Karte oder Offen wählen' });
  const mode = b.mode === 'delivery' ? 'delivery' : 'pickup';

  if (!Array.isArray(b.korb) || !b.korb.length) return json(400, { error: 'korb_leer', hint: 'Mindestens einen Artikel wählen' });
  if (b.korb.length > 40) return json(400, { error: 'korb_zu_gross' });
  const korb = {};
  for (const roh of b.korb) {
    const z = zeile(roh);
    if (z.fehler) return json(400, { error: z.fehler, hint: 'Artikel prüfen' });
    if (korb[z.key]) korb[z.key].qty = Math.min(99, korb[z.key].qty + z.entry.qty);
    else korb[z.key] = z.entry;
  }

  const kunde = {
    name: text(b.name, 60),
    phone: text(b.phone, 30),
    email: text(b.email, 120).toLowerCase(),
    note: notiz(b.note),
  };
  if (kunde.phone && ziffern(kunde.phone) < 5) return json(400, { error: 'telefon_ungueltig', hint: 'Telefonnummer prüfen' });
  if (kunde.email && !istMail(kunde.email)) return json(400, { error: 'mail_ungueltig', hint: 'E-Mail-Adresse prüfen oder leer lassen' });

  let deliveryAddress = null, fee = 0;
  if (mode === 'delivery') {
    const a = b.adresse || {};
    const street = text(a.street, 80), zip = text(a.zip, 10), city = text(a.city, 60);
    if (street.length < 3 || !/^\d{5}$/.test(zip) || city.length < 2) {
      return json(400, { error: 'adresse_fehlt', hint: 'Lieferung braucht Straße, PLZ und Ort' });
    }
    if (ziffern(kunde.phone) < 5) return json(400, { error: 'telefon_fehlt', hint: 'Lieferung braucht eine Telefonnummer' });
    const zi = Number(b.zone);
    const zone = Number.isInteger(zi) ? SK.DELIVERY_ZONES[zi] : null;
    if (!zone) return json(400, { error: 'zone_fehlt', hint: 'Lieferzone wählen' });
    fee = zone.fee;
    deliveryAddress = { street, zip, city, zone: zone.label, distance: null };
  }

  // Preis: dieselbe Rechnung wie online (ohne Gutschein, Treue, Trinkgeld)
  const p = await betragErmitteln({ cartSnapshot: korb, mode, deliveryFee: fee, total: 0 });
  if (!p.sicher || !(p.berechnet > 0)) return json(400, { error: 'preis_unklar', hint: 'Preis ließ sich nicht berechnen: ' + (p.grund || '?') });
  const total = p.berechnet;
  const subtotal = p.posten ? p.posten.warenwert : Math.round(SK.warenwert(korb) * 100) / 100;

  // Bestellnummer wie online: GNC-<ms>, eindeutig im Store
  const os = store('orders');
  let ms = Date.now();
  for (let i = 0; i < 5 && await os.get('o:GNC-' + ms, { type: 'json' }); i++) ms++;
  const reference = 'GNC-' + ms;
  const jetzt = new Date(ms).toISOString();
  const tag = berlinTag(ms);

  let abholnr = null;
  try { abholnr = (await vergebeAbholnr(reference, tag)).nr; } catch (e) {
    console.error('bestellung-intern Abholnummer:', e && e.message);
  }

  const order = {
    reference,
    name: kunde.name,
    email: kunde.email,
    phone: kunde.phone,
    note: kunde.note,
    mode,
    payment: 'cash',
    zahlart,
    bezahlt: zahlart !== 'offen',
    paidWith: zahlart === 'offen' ? null : ZAHL_TEXT[zahlart],
    items: positionen(korb),
    subtotal,
    discount: 0,
    loyaltyDiscount: 0,
    loyaltyApplied: false,
    loyaltyType: null,
    deliveryFee: fee,
    tip: 0,
    total,
    isTest: false,
    cartSnapshot: korb,
    promo: null,
    voucherCode: null,
    deliveryAddress,
    pickupTime: '',
    scheduledFor: '',
    isPreorder: false,
    quelle,
    abholnr,
    abholTag: tag,
  };
  const rec = {
    status: 'completed',
    createdAt: jetzt,
    completedAt: jetzt,
    checkoutId: null,
    quelle,
    abholnr,
    abholTag: tag,
    angelegtVon: who.name,
    accrued: true,
    order,
    fstate: 'confirmed',
    fstateAt: { confirmed: jetzt },
  };
  try {
    const res = await os.setJSON('o:' + reference, rec, { onlyIfNew: true });
    if (res && res.modified === false) return json(409, { error: 'doppelt', hint: 'Bitte noch einmal tippen' });
  } catch (e) {
    console.error('bestellung-intern speichern:', e && e.message);
    return json(500, { error: 'speichern_fehlgeschlagen', hint: 'Bestellung wurde nicht gespeichert' });
  }
  await addRevenue(tag, umsatzPatch(order, quelle, 1));

  // Bestätigung nur mit Mailadresse
  let mailed = false;
  if (kunde.email) {
    try {
      const siteUrl = (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');
      const r = await fetch(siteUrl + '/.netlify/functions/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...internHeader() },
        body: JSON.stringify({ type: 'intern_bestaetigung', order }),
      });
      mailed = r.ok;
    } catch (e) { console.error('bestellung-intern Mail:', e && e.message); }
  }

  await auditLog(who, 'Bestellung', '#' + reference + (abholnr ? ' ' + nrText(abholnr) : '')
    + ' angelegt (' + (quelle === 'telefon' ? 'Telefon' : 'Truck') + ', '
    + (mode === 'delivery' ? 'Lieferung' : 'Abholung') + ', '
    + total.toFixed(2).replace('.', ',') + ' €, ' + ZAHL_TEXT[zahlart] + ')');

  return json(200, { ok: true, reference, abholnr, total, statusUrl: statusUrl(reference), mailed });
}

async function ladeIntern(reference) {
  const ref = String(reference || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
  if (!/^GNC-\d{10,14}$/.test(ref)) return { fehler: json(400, { error: 'bad_ref' }) };
  const s = store('orders');
  const rec = await s.get('o:' + ref, { type: 'json' });
  if (!rec) return { fehler: json(404, { error: 'not_found' }) };
  if (!QUELLEN.includes(rec.quelle)) {
    return { fehler: json(409, { error: 'nicht_intern', hint: 'Nur Telefon- und Truck-Bestellungen' }) };
  }
  return { s, ref, rec };
}

async function bezahlt(who, input) {
  const zahlart = input.zahlart === 'bar' || input.zahlart === 'karte' ? input.zahlart : null;
  if (!zahlart) return json(400, { error: 'zahlart_fehlt' });
  const l = await ladeIntern(input.reference);
  if (l.fehler) return l.fehler;
  const { s, ref, rec } = l;
  if (rec.status !== 'completed') return json(409, { error: 'nicht_aktiv' });
  const o = rec.order || {};
  if (o.zahlart !== 'offen') return json(409, { error: 'schon_bezahlt' });
  o.zahlart = zahlart;
  o.bezahlt = true;
  o.paidWith = ZAHL_TEXT[zahlart];
  rec.order = o;
  rec.bezahltAm = new Date().toISOString();
  rec.bezahltBei = who.name;
  await s.setJSON('o:' + ref, rec);
  await auditLog(who, 'Bestellung', '#' + ref + ' kassiert: ' + ZAHL_TEXT[zahlart]);
  return json(200, { ok: true, zahlart });
}

async function stornieren(who, input) {
  const l = await ladeIntern(input.reference);
  if (l.fehler) return l.fehler;
  const { s, ref, rec } = l;
  if (rec.status !== 'completed') return json(409, { error: 'nicht_aktiv' });
  rec.status = 'cancelled';
  rec.cancelledAt = new Date().toISOString();
  rec.cancelledBy = who.name;
  rec.cancelReason = 'eingabe';
  await s.setJSON('o:' + ref, rec);
  const tag = rec.abholTag || berlinTag(new Date(rec.createdAt || Date.now()).getTime());
  await addRevenue(tag, umsatzPatch(rec.order || {}, rec.quelle, -1));
  await auditLog(who, 'Bestellung', '#' + ref + (rec.abholnr ? ' ' + nrText(rec.abholnr) : '') + ' storniert (Eingabefehler)');
  return json(200, { ok: true, status: 'cancelled' });
}

exports.handler = async (event) => {
  // Grundschutz: Größe und Menge je Absender (lib/bremse.js)
  const halt = await schutz(event, { name: 'bestellung-intern', max: 120, maxKB: 32 });
  if (halt) return halt;
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }
  if (!input || typeof input !== 'object') return json(400, { error: 'invalid_json' });

  // Bremse gegen Durchprobieren, siehe lib/auth-guard.js
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;
  const who = await authRole(await passwortAusSitzung(input.password));
  await meldeErgebnis(event, !!who);
  if (!who) return json(401, { error: 'unauthorized' });

  try {
    if (input.action === 'anlegen') return await anlegen(who, input.bestellung);
    if (input.action === 'bezahlt') return await bezahlt(who, input);
    if (input.action === 'stornieren') return await stornieren(who, input);
    return json(400, { error: 'unknown_action' });
  } catch (e) {
    console.error('bestellung-intern:', e && e.message);
    return json(500, { error: 'fehler', hint: 'Das hat nicht geklappt. Bitte noch einmal versuchen.' });
  }
};
