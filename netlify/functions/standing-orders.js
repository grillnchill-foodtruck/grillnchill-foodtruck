/**
 * standing-orders.js
 * ----------------------------------------------------------------------------
 * Stehende Bestellungen ("jeden Donnerstag, 12:30").
 *
 *   POST { action, email, token, ... }
 *     create   { weekday, time, mode, items, note?, remind }  → { ok, order }
 *     list     { }                                            → { ok, orders }
 *     pause    { id }                                         → { ok, order }
 *     resume   { id }                                         → { ok, order }
 *     skipNext { id }                                         → { ok, order }
 *     remind   { id, remind }   Erinnerungen an/aus           → { ok, order }
 *     delete   { id }                                         → { ok }
 *
 * WICHTIG – Einwilligung:
 * Erinnerungen sind standardmäßig AUS. Der Kunde muss sie beim Anlegen oder
 * später ausdrücklich einschalten (remind: true). Ohne diese Zustimmung
 * verschicken wir keine einzige Erinnerungsmail. Der Zeitpunkt der Zustimmung
 * wird als remindConsentAt festgehalten, damit sie nachweisbar ist.
 *
 * Es wird NICHTS automatisch bestellt. Die stehende Bestellung erzeugt nur
 * eine Erinnerung mit vorbereitetem Warenkorb – bezahlt wird wie immer im
 * normalen Bestellvorgang. Ohne hinterlegte Zahlungsermächtigung wäre eine
 * automatische Bestellung weder technisch sauber noch dem Kunden gegenüber
 * fair.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { naechsterTermin } = require('./lib/standing');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, body) => ({
  statusCode, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(body),
});

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

/* Muss zeichengenau zu account.js passen: dort ist der Schluessel
   'c:' + sha256(normEmail) als VOLLER Hex-Wert. Vorher auf 32 Zeichen
   gekuerzt – damit wurde der Kundendatensatz nie gefunden. */
const normEmail = (e) => String(e || '').trim().toLowerCase().slice(0, 120);
const emailKey = (e) => 'c:' + crypto.createHash('sha256')
  .update(normEmail(e)).digest('hex');

/* Anmeldung prüfen. WICHTIG: rec.tokens ist ein OBJEKT { token: zeitstempel },
   kein Array – genau wie checkToken() in account.js. Vorher stand hier ein
   .some() auf dem Objekt; das wirft, wurde vom catch geschluckt und endete
   als 401. Deshalb schlug "Bestellung anlegen" fehl.

   Danach stand hier ein direktes rec.tokens[token]. Das nahm auch geerbte
   Eigenschaften an ("__proto__" & Co.) und liess jeden, der eine E-Mail-
   Adresse kannte, an die stehenden Bestellungen dieses Kontos. Die Prüfung
   liegt deshalb jetzt in lib/kunden-token.js – dort steht die ganze
   Begründung. */
const { tokenGueltig } = require('./lib/kunden-token');
async function authCustomer(email, token) {
  if (!email || !token) return null;
  try {
    const rec = await store('customers').get(emailKey(email), { type: 'json' });
    if (!tokenGueltig(rec, token)) return null;
    return rec;
  } catch (e) { return null; }
}

const clean = (v, max) => String(v == null ? '' : v).replace(/[<>]/g, '').trim().slice(0, max);

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let b = {};
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad_json' }); }

  /* Aufruf aus der Erinnerungsmail: nur Kennung + Link-Token, keine Anmeldung.
     Gibt ausschliesslich die Artikel dieser einen Reihe zurueck – kein
     Aendern, kein Loeschen, keine anderen Daten. */
  if (b.action === 'byLink') {
    const id = String(b.id || '').replace(/[^a-f0-9]/g, '').slice(0, 24);
    const secret = process.env.STATUS_SECRET || process.env.ADMIN_PASSWORD || 'gnc';
    const erwartet = crypto.createHmac('sha256', secret).update('so:' + id).digest('hex').slice(0, 16);
    if (!id || b.linkToken !== erwartet) return json(403, { error: 'forbidden' });
    try {
      const st = store('standing');
      const { blobs } = await st.list({ prefix: 'so:' });
      const treffer = blobs.find(x => x.key.endsWith(':' + id));
      if (!treffer) return json(404, { error: 'not_found' });
      const rec = await st.get(treffer.key, { type: 'json' });
      if (!rec) return json(404, { error: 'not_found' });
      return json(200, { ok: true, order: { id: rec.id, items: rec.items, mode: rec.mode, time: rec.time } });
    } catch (e) { return json(500, { error: 'server_error' }); }
  }

  const kunde = await authCustomer(b.email, b.token);
  if (!kunde) return json(401, { error: 'unauthorized' });

  const s = store('standing');
  const praefix = 'so:' + emailKey(b.email) + ':';

  async function alle() {
    const { blobs } = await s.list({ prefix: praefix });
    const out = [];
    for (const x of blobs) {
      const r = await s.get(x.key, { type: 'json' });
      if (r) out.push(r);
    }
    out.sort((a, c) => (a.weekday - c.weekday) || String(a.time).localeCompare(String(c.time)));
    return out;
  }

  try {
    const action = String(b.action || '');

    if (action === 'list') return json(200, { ok: true, orders: await alle() });

    if (action === 'create') {
      const vorhandene = await alle();
      if (vorhandene.length >= 3) {
        return json(400, { error: 'limit', hint: 'Höchstens drei stehende Bestellungen je Konto' });
      }
      const weekday = Math.max(0, Math.min(6, parseInt(b.weekday, 10) || 0));
      const time = /^\d{1,2}:\d{2}$/.test(String(b.time || '')) ? String(b.time) : '12:30';
      const items = Array.isArray(b.items) ? b.items.slice(0, 40) : [];
      if (!items.length) return json(400, { error: 'empty' });

      const id = crypto.randomBytes(6).toString('hex');
      // Erinnerungen nur bei ausdrücklicher Zustimmung – Voreinstellung ist AUS.
      const remind = b.remind === true;
      const rec = {
        id,
        name: clean(b.name, 32),
        email: String(b.email).trim().toLowerCase(),
        weekday, time,
        mode: b.mode === 'delivery' ? 'delivery' : 'pickup',
        items,
        note: clean(b.note, 200),
        paused: false,
        remind,
        remindConsentAt: remind ? new Date().toISOString() : null,
        skipUntil: null,
        createdAt: new Date().toISOString(),
        lastRemindedFor: null,
      };
      rec.nextRun = naechsterTermin(weekday, time, null);
      await s.setJSON(praefix + id, rec);
      return json(200, { ok: true, order: rec });
    }

    const id = String(b.id || '').replace(/[^a-f0-9]/g, '').slice(0, 24);
    if (!id) return json(400, { error: 'bad_id' });
    const key = praefix + id;
    const rec = await s.get(key, { type: 'json' });
    if (!rec) return json(404, { error: 'not_found' });

    if (action === 'delete') { await s.delete(key); return json(200, { ok: true }); }

    if (action === 'pause')  rec.paused = true;
    if (action === 'resume') { rec.paused = false; rec.nextRun = naechsterTermin(rec.weekday, rec.time, rec.skipUntil); }
    if (action === 'skipNext') {
      // Diesen einen Termin überspringen – die Reihe läuft danach weiter.
      rec.skipUntil = rec.nextRun;
      rec.nextRun = naechsterTermin(rec.weekday, rec.time, rec.skipUntil);
    }
    if (action === 'remind') {
      const an = b.remind === true;
      rec.remind = an;
      // Zustimmung mit Zeitpunkt festhalten; beim Abschalten wieder leeren.
      rec.remindConsentAt = an ? new Date().toISOString() : null;
    }
    await s.setJSON(key, rec);
    return json(200, { ok: true, order: rec });
  } catch (e) {
    console.error('standing-orders:', e);
    return json(500, { error: 'server_error' });
  }
};
