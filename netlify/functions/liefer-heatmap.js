/**
 * liefer-heatmap.js
 * ----------------------------------------------------------------------------
 * Wärmekarte der Lieferungen fürs Cockpit (cockpit.html). Nur für den
 * Inhaber, weil Adressdaten drinstecken: Hauptpasswort (Sitzung) oder ein
 * Gerät, das Kubi selbst gekoppelt hat. Gleiche Prüfung wie der Umsatz in
 * cockpit-data.js.
 *
 *   POST { password | teamToken, tage: 30 | 90 }
 *     → { ok, tage, archivTage, lieferungen, verortet, offen, nichtGefunden,
 *         zellen: [ { lat, lng, n } ], zelle: { dLat, dLng }, ausgeblendet,
 *         gebiete: [ { plz, stadtteil, n } ], truck }
 *     → 403 { error: 'nur_inhaber' } für alle anderen Team-Rollen
 *
 * DATENSCHUTZ
 * -----------
 * Die Antwort enthält nie eine Adresse oder eine echte Koordinate: nur die
 * Mitte von Rasterzellen (rund 250 m) und deren Anzahl. Zellen mit weniger
 * als 3 Bestellungen oder nur einer Adresse fallen weg, ebenso Postleitzahlen
 * unter 3 Bestellungen (lib/lieferung.js heatZellen, gebiete).
 *
 * TEMPO
 * -----
 * Koordinaten kommen aus dem Store "geo" (lib/geokodierung.js). Fehlende
 * werden in kleinen Portionen nachgeholt: höchstens 5 je Aufruf und nur,
 * solange der Aufruf jünger als 6 Sekunden ist (Nominatim: 1 pro Sekunde,
 * Function-Timeout 10 s). "offen" sagt, wie viele noch fehlen; das Cockpit
 * ruft dann nach kurzer Pause wieder auf, bis alles verortet ist.
 *
 * Das Bestell-Archiv reicht 90 Tage zurück (orders-reconcile.js räumt ältere
 * abgeschlossene Bestellungen weg). Mehr als 90 Tage gibt es also nicht.
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung } = require('./lib/admin-sitzung');
const { mitglied } = require('./lib/team-passwort');
const { geokodiere, ausCache, schluessel } = require('./lib/geokodierung');
const L = require('./lib/lieferung');

const ARCHIV_TAGE = 90;
const PORTION = 5;
const BUDGET_MS = 6000;

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

/* Wie cockpit-data.js: Hauptpasswort = Inhaber (superadmin) */
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
function teamPruefer() {
  try {
    const m = require('./lib/team-device');
    return (m && typeof m.pruefeTeamToken === 'function') ? m.pruefeTeamToken : null;
  } catch (e) { return null; }
}

function keyZeit(key) {
  const m = /^o:GNC-(\d{12,14})$/.exec(key);
  return m ? Number(m[1]) : null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  const start = Date.now();

  // Bremse und Grundschutz vor dem Lesen des Inhalts (lib/auth-guard.js)
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }
  if (!input || typeof input !== 'object') return json(400, { error: 'invalid_json' });

  let who = null;
  if (typeof input.password === 'string' && input.password) {
    who = await authRole(await passwortAusSitzung(input.password));
    await meldeErgebnis(event, !!who);
  } else if (typeof input.teamToken === 'string' && input.teamToken) {
    const pruefe = teamPruefer();
    if (!pruefe) return json(401, { error: 'unauthorized' });
    let res = null;
    try { res = await pruefe(input.teamToken); } catch (e) { res = null; }
    await meldeErgebnis(event, !!res);
    if (res) who = { role: 'team', name: res.name || 'Team-Gerät', owner: !!res.owner };
  }
  if (!who) return json(401, { error: 'unauthorized' });
  const owner = who.role === 'superadmin' || who.owner === true;
  if (!owner) return json(403, { error: 'nur_inhaber', hint: 'Die Liefer-Heatmap sieht nur der Inhaber.' });

  const tage = Number(input.tage) === 90 ? 90 : 30;
  const jetzt = Date.now();
  const seit = jetzt - tage * 86400000;

  try {
    const s = store('orders');
    const { blobs } = await s.list({ prefix: 'o:' });
    const keys = blobs.map((b) => b.key)
      .filter((k) => !/^o:GNC-GC-/.test(k))
      .filter((k) => { const t = keyZeit(k); return t === null || t >= seit - 2 * 86400000; });

    const adressen = [];   // je Bestellung eine Lieferadresse
    for (let i = 0; i < keys.length; i += 40) {
      const teil = keys.slice(i, i + 40);
      const recs = await Promise.all(teil.map((k) => s.get(k, { type: 'json' }).catch(() => null)));
      for (const rec of recs) {
        if (!rec || rec.status !== 'completed' || rec.kind === 'giftcard') continue;
        const o = rec.order || {};
        if (o.mode !== 'delivery' || o.isTest || !o.deliveryAddress) continue;
        const ms = Date.parse(rec.completedAt || rec.createdAt || '') || 0;
        if (ms < seit) continue;
        adressen.push(o.deliveryAddress);
      }
    }

    // Einmal je Adresse nachsehen, nicht je Bestellung
    const geo = store('geo');
    const jeAdresse = new Map();
    const eindeutig = [];
    for (const a of adressen) {
      const k = schluessel(a);
      if (!k) continue;
      if (!jeAdresse.has(k)) { jeAdresse.set(k, null); eindeutig.push({ k, a }); }
    }
    for (let i = 0; i < eindeutig.length; i += 40) {
      const teil = eindeutig.slice(i, i + 40);
      const got = await Promise.all(teil.map((x) => ausCache(x.a, geo)));
      got.forEach((c, j) => { jeAdresse.set(teil[j].k, c); });
    }

    // Fehlende in kleinen Portionen nachholen
    let neu = 0;
    for (const x of eindeutig) {
      const c = jeAdresse.get(x.k);
      if (!c || c.status !== 'fehlt') continue;
      if (neu >= PORTION || Date.now() - start > BUDGET_MS) break;
      neu++;
      await geokodiere(x.a, { store: geo });
      jeAdresse.set(x.k, await ausCache(x.a, geo));
    }

    const punkte = [];
    let offen = 0, nichtGefunden = 0;
    for (const a of adressen) {
      const k = schluessel(a);
      const c = k ? jeAdresse.get(k) : null;
      if (c && c.status === 'treffer') {
        punkte.push({ lat: c.wert.lat, lng: c.wert.lng, h: k, plz: c.wert.plz || String(a.zip || ''), stadtteil: c.wert.stadtteil || null });
      } else if (c && c.status === 'fehlt') offen++;
      else nichtGefunden++;
    }

    const heat = L.heatZellen(punkte, { min: 3, minAdressen: 2 });
    return json(200, {
      ok: true,
      tage,
      archivTage: ARCHIV_TAGE,
      lieferungen: adressen.length,
      verortet: punkte.length,
      offen,
      nichtGefunden,
      zellen: heat.zellen,
      zelle: { dLat: heat.dLat, dLng: heat.dLng, meter: L.ZELLE_M },
      ausgeblendet: heat.ausgeblendet,
      gebiete: L.gebiete(punkte, { min: 3, max: 8 }),
      truck: { lat: L.TRUCK.lat, lng: L.TRUCK.lng },
      stand: new Date(jetzt).toISOString(),
    });
  } catch (e) {
    console.error('liefer-heatmap:', e && e.message);
    return json(500, { error: 'read_failed' });
  }
};
