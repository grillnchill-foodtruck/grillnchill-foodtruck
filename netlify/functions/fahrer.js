/**
 * fahrer.js
 * ----------------------------------------------------------------------------
 * Team-Function für die Fahrer-Ansicht (fahrer.html, Kubis Handy).
 * Anmeldung wie im Admin-Tool: Sitzungs-Token nach Passwort und Code
 * (lib/admin-sitzung.js), alle Team-Rollen.
 *
 *   POST { password, action: 'liste' }
 *     → { ok, jetzt, truck, lieferungen: [...], buendel: [...], offen }
 *       Heutige Lieferungen, die noch nicht zugestellt sind, in Reihenfolge:
 *       erst "unterwegs", dann der Tourvorschlag (ab dem Truck jeweils zur
 *       nächstgelegenen Adresse, Luftlinie), dann Vorbestellungen für später.
 *       Adressen ohne Koordinaten werden hier geokodiert, höchstens so viele,
 *       wie in rund 6 Sekunden gehen (Nominatim: 1 pro Sekunde). "offen" sagt,
 *       wie viele noch fehlen; die Seite fragt dann gleich noch einmal.
 *
 *   POST { password, action: 'position', refs: [GNC-…], lat, lng, acc }
 *     → { ok, gespeichert }
 *       Live-Standort während der Fahrt. Gespeichert je Bestellung im Store
 *       "fahrt" (pos:<ref>), nur solange die Bestellung "on_the_way" ist.
 *       Der Bestelldatensatz wird dafür nicht angefasst.
 *
 *   POST { password, action: 'stopp', refs: [GNC-…] }
 *     → { ok, geloescht }   Teilen beenden, gespeicherte Positionen löschen.
 *
 * "Losfahren" und "Zugestellt" laufen bewusst NICHT hier, sondern über den
 * vorhandenen Weg order-status.js (action 'set'), damit Push, Mail und Live
 * Activity an den Kunden genau wie bisher laufen. Die Ankunftszeit geht dort
 * als ankunftMin mit und landet in rec.fahrt.
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung } = require('./lib/admin-sitzung');
const { mitglied } = require('./lib/team-passwort');
const { geokodiere, ausCache } = require('./lib/geokodierung');
const L = require('./lib/lieferung');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
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
  if (admin && pw === admin) return { role: 'admin', name: 'Kubi' };
  try {
    const t = store('team');
    const { blobs } = await t.list({ prefix: 'u:' });
    const { key, u } = (await mitglied(t, pw, blobs)) || {};
    if (u) return { role: u.role === 'admin' ? 'admin' : 'staff', name: u.name || key.slice(2) };
  } catch (e) {}
  return null;
}

/* ---------------- Zeit in Europe/Berlin ---------------- */
const TZ = 'Europe/Berlin';
const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtHM = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
const berlinDate = (ms) => fmtDate.format(new Date(ms));
function berlinMinute(ms) {
  const [h, m] = fmtHM.format(new Date(ms)).split(':').map(Number);
  return (h % 24) * 60 + m;
}

/* ---------------- Eingaben ---------------- */
const sauber = (x, max) => String(x == null ? '' : x).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200);
const refSauber = (x) => String(x || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
function refListe(x) {
  const a = Array.isArray(x) ? x : [x];
  return [...new Set(a.map(refSauber).filter((r) => /^GNC-\d{6,16}$/.test(r)))].slice(0, 6);
}

/* ---------------- Bestellungen lesen ---------------- */
const FENSTER_TAGE = 4;     // Vorbestellungen der Vortage, die heute fällig sind
function keyZeit(key) {
  const m = /^o:GNC-(\d{12,14})$/.exec(key);
  return m ? Number(m[1]) : null;
}
async function liesOffeneLieferungen(jetzt) {
  const s = store('orders');
  const { blobs } = await s.list({ prefix: 'o:' });
  const ab = jetzt - FENSTER_TAGE * 86400000;
  const keys = blobs.map((b) => b.key)
    .filter((k) => !/^o:GNC-GC-/.test(k))
    .filter((k) => { const t = keyZeit(k); return t === null || t >= ab; });
  const recs = [];
  for (let i = 0; i < keys.length; i += 40) {
    const teil = keys.slice(i, i + 40);
    const got = await Promise.all(teil.map((k) => s.get(k, { type: 'json' }).catch(() => null)));
    got.forEach((rec, j) => { if (rec) recs.push({ key: teil[j], rec }); });
  }
  const heute = berlinDate(jetzt);
  return recs.filter(({ rec }) => {
    if (!rec || rec.kind === 'giftcard' || rec.status !== 'completed') return false;
    const o = rec.order || {};
    if (o.mode !== 'delivery' || !o.deliveryAddress) return false;
    const fs = rec.fstate || 'confirmed';
    if (fs === 'delivered' || fs === 'picked_up') return false;
    if (fs === 'on_the_way') return true;
    const ms = Date.parse(rec.completedAt || rec.createdAt || '') || 0;
    if (berlinDate(ms) === heute) return true;
    return !!(o.isPreorder || o.scheduledFor);   // Vorbestellung von den Vortagen, noch offen
  });
}

/* Wunschzeit steht als Text in der Sprache des Gastes ("Heute, ab 14:30",
   "domani, ab 12:45"). Die Uhrzeit lässt sich lesen; "morgen" in allen 8
   Sprachen auch. Mehr wird nicht geraten. */
const MORGEN = /\b(morgen|tomorrow|yarın|domani|mañana|amanhã|demain)\b/i;
function faelligkeit(rec, jetzt) {
  const o = rec.order || {};
  const txt = String(o.scheduledFor || '');
  if (!txt) return { spaeter: false, minute: null };
  const m = /(\d{1,2})[:.](\d{2})/.exec(txt);
  const minute = m ? Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]) : null;
  const ms = Date.parse(rec.completedAt || rec.createdAt || '') || 0;
  const heuteBestellt = berlinDate(ms) === berlinDate(jetzt);
  if (MORGEN.test(txt) && heuteBestellt) return { spaeter: true, minute };
  if (minute !== null && minute > berlinMinute(jetzt) + 60) return { spaeter: true, minute };
  return { spaeter: false, minute };
}

function zeile(key, rec, jetzt) {
  const o = rec.order || {};
  const a = o.deliveryAddress || {};
  const items = Array.isArray(o.items) ? o.items : [];
  const artikel = items.reduce((n, it) => n + Math.max(0, Math.min(99, parseInt(it && it.qty, 10) || 0)), 0);
  const total = typeof o.total === 'number' ? o.total : (typeof rec.total === 'number' ? rec.total : 0);
  const online = o.payment === 'sumup';
  const f = faelligkeit(rec, jetzt);
  return {
    ref: (o.reference && /^GNC-/.test(o.reference)) ? refSauber(o.reference) : key.slice(2),
    abholnr: (typeof rec.abholnr === 'number' && rec.abholnr > 0) ? rec.abholnr : null,
    name: sauber(o.name, 60),
    telefon: sauber(o.phone, 30).replace(/[^\d+ /()-]/g, ''),
    adresse: { street: sauber(a.street, 120), zip: sauber(a.zip, 10), city: sauber(a.city, 60) },
    artikel,
    total: Math.round(total * 100) / 100,
    zahlung: online ? (o.paymentPending ? 'online_offen' : 'online') : 'bar',
    notiz: sauber(o.note, 300),
    wunschzeit: sauber(o.scheduledFor, 60) || null,
    vorbestellung: !!(o.isPreorder || o.scheduledFor),
    test: !!o.isTest,
    fstate: rec.fstate || 'confirmed',
    fahrt: rec.fahrt && rec.fahrt.start ? { start: rec.fahrt.start, ankunft: rec.fahrt.ankunft || null, minuten: rec.fahrt.minuten || null } : null,
    gruppe: rec.fstate === 'on_the_way' ? 'unterwegs' : (f.spaeter ? 'spaeter' : 'jetzt'),
    faelligMin: f.minute,
    bestelltAm: rec.completedAt || rec.createdAt || null,
  };
}

/* ---------------- Aktionen ---------------- */
async function aktionListe() {
  const start = Date.now();
  const jetzt = start;
  const offen = await liesOffeneLieferungen(jetzt);
  const zeilen = offen.map(({ key, rec }) => zeile(key, rec, jetzt));

  // Koordinaten: erst aus dem Zwischenspeicher, dann neue, solange Zeit ist
  const geo = store('geo');
  const fehlen = [];
  await Promise.all(zeilen.map(async (z) => {
    const c = await ausCache(z.adresse, geo);
    if (c.status === 'treffer') { z.lat = c.wert.lat; z.lng = c.wert.lng; }
    else if (c.status === 'fehlt') fehlen.push(z);
    else z.nichtGefunden = true;
  }));
  let rest = 0;
  for (const z of fehlen) {
    if (Date.now() - start > 6000) { rest++; continue; }
    const p = await geokodiere(z.adresse, { store: geo });
    if (p) { z.lat = p.lat; z.lng = p.lng; }
    else {
      const c = await ausCache(z.adresse, geo);   // leer = nicht gefunden, fehlt = Netzfehler
      if (c.status === 'leer') z.nichtGefunden = true; else rest++;
    }
  }

  for (const z of zeilen) {
    if (typeof z.lat === 'number') {
      const d = L.km(L.TRUCK, z);
      z.km = Math.round(d * 10) / 10;
      z.richtung = L.richtung(L.peilung(L.TRUCK, z));
      z.vorschlag = L.ankunftVorschlag(d);
    } else {
      z.km = null; z.richtung = null; z.vorschlag = { minuten: null, wahl: 15 };
    }
  }

  const unterwegs = zeilen.filter((z) => z.gruppe === 'unterwegs')
    .sort((a, b) => String(a.fahrt && a.fahrt.ankunft || '').localeCompare(String(b.fahrt && b.fahrt.ankunft || '')));
  const jetztListe = L.tour(L.TRUCK, zeilen.filter((z) => z.gruppe === 'jetzt'));
  jetztListe.forEach((z, i) => { z.tourNr = i + 1; });
  const spaeter = zeilen.filter((z) => z.gruppe === 'spaeter')
    .sort((a, b) => (a.faelligMin == null ? 9999 : a.faelligMin) - (b.faelligMin == null ? 9999 : b.faelligMin));
  const buendel = L.buendel(L.TRUCK, jetztListe);

  await L.positionenAufraeumen(jetzt);

  return json(200, {
    ok: true,
    jetzt: new Date(jetzt).toISOString(),
    truck: { lat: L.TRUCK.lat, lng: L.TRUCK.lng, adresse: L.TRUCK.adresse },
    wahl: L.WAHL,
    lieferungen: unterwegs.concat(jetztListe, spaeter),
    buendel,
    offen: rest,
  });
}

async function aktionPosition(input) {
  const lat = Number(input.lat), lng = Number(input.lng);
  const acc = Number(input.acc);
  // Nur Deutschland, alles andere ist ein Messfehler oder kein Handy im Truck
  if (!isFinite(lat) || !isFinite(lng) || lat < 47 || lat > 55.2 || lng < 5.8 || lng > 15.1) return json(400, { error: 'bad_position' });
  const refs = refListe(input.refs);
  if (!refs.length) return json(400, { error: 'bad_refs' });
  const s = store('orders');
  const fs = L.fahrtStore();
  const wert = {
    lat: Math.round(lat * 1e5) / 1e5,
    lng: Math.round(lng * 1e5) / 1e5,
    acc: isFinite(acc) && acc >= 0 ? Math.min(5000, Math.round(acc)) : null,
    at: new Date().toISOString(),
  };
  const gespeichert = [];
  for (const ref of refs) {
    const rec = await s.get('o:' + ref, { type: 'json' }).catch(() => null);
    if (!rec || rec.kind === 'giftcard' || (rec.order || {}).mode !== 'delivery' || rec.fstate !== 'on_the_way') continue;
    await fs.setJSON(L.posKey(ref), wert);
    // Kam "Zugestellt" genau dazwischen, die eben geschriebene Position gleich wieder weg
    const nach = await s.get('o:' + ref, { type: 'json' }).catch(() => null);
    if (!nach || nach.fstate !== 'on_the_way') { await L.positionenLoeschen(ref); continue; }
    gespeichert.push(ref);
  }
  return json(200, { ok: true, gespeichert });
}

async function aktionStopp(input) {
  const refs = refListe(input.refs);
  if (!refs.length) return json(400, { error: 'bad_refs' });
  const n = await L.positionenLoeschen(refs);
  return json(200, { ok: true, geloescht: n });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  // Bremse gegen Durchprobieren und Grundschutz (Größe, Anfragen je Absender),
  // siehe lib/auth-guard.js und lib/bremse.js. Vor dem Lesen des Inhalts.
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }
  if (!input || typeof input !== 'object') return json(400, { error: 'invalid_json' });
  const who = await authRole(await passwortAusSitzung(typeof input.password === 'string' ? input.password : ''));
  await meldeErgebnis(event, !!who);
  if (!who) return json(401, { error: 'unauthorized' });

  try {
    if (input.action === 'liste') return await aktionListe();
    if (input.action === 'position') return await aktionPosition(input);
    if (input.action === 'stopp') return await aktionStopp(input);
    return json(400, { error: 'unknown_action' });
  } catch (e) {
    console.error('fahrer:', input.action, e && e.message);
    return json(500, { error: 'failed' });
  }
};
