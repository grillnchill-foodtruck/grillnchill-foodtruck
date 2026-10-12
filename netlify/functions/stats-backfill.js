/**
 * stats-backfill.js
 * ----------------------------------------------------------------------------
 * Baut die Jahres-Statistik der Kunden (cust.stats, cust.badgesAt, siehe
 * lib/abzeichen.js) aus dem Bestell-Archiv neu auf. Nur fuer Admins.
 *
 *   POST { password }                    startet einen Lauf
 *   POST { password, cursor }            naechster Abschnitt
 *   POST { password, force: true }       neuer Lauf, obwohl schon einer fertig ist
 *   POST { password, status: true }      nur Stand des letzten Laufs
 *   -> { ok, runId, processed, counted, customers, total, nextCursor | null, done }
 *
 * Der Admin-Client ruft so lange mit nextCursor weiter, bis nextCursor null
 * ist. Jeder Aufruf arbeitet hoechstens ~5 Sekunden und bleibt damit unter
 * dem Zeitlimit der Function.
 *
 * WAS GEZAEHLT WIRD
 * -----------------
 * Schluessel 'o:<ref>' im Store 'orders' mit status 'completed', kein
 * Gutschein-Kauf (kind 'giftcard'), keine Testbestellung, mit E-Mail und
 * accrued === true. accrued ist genau die Schranke, hinter der send-email.js
 * Treue und Statistik live bucht (verifizierte Zahlung). So zaehlt der
 * Neuaufbau dieselben Bestellungen wie der laufende Betrieb.
 * Kunden ohne Datensatz (Konto geloescht) werden nicht neu angelegt.
 *
 * WIE DOPPELTES ZAEHLEN VERHINDERT WIRD
 * -------------------------------------
 * Jeder Lauf bekommt eine runId (steht im Cursor und in meta:stats_backfill).
 * Die Bestell-Schluessel werden sortiert abgearbeitet; der Cursor ist der
 * letzte bearbeitete Schluessel.
 *
 *   Erste Beruehrung eines Kunden im Lauf:
 *     cust.stats = {}, cust.badgesAt = {}
 *     cust.statsRebuild    = runId
 *     cust.statsRebuildAt  = Zeitpunkt dieses Zuruecksetzens
 *     cust.statsRebuildKey = ''   (hoechster schon gezaehlter Bestell-Schluessel)
 *   Jede weitere Bestellung dieses Kunden im selben Lauf:
 *     zaehlt nur, wenn ihr Schluessel > statsRebuildKey ist. Bricht ein
 *     Abschnitt ab und wird mit demselben Cursor wiederholt, sind die schon
 *     geschriebenen Kunden dadurch geschuetzt. Ein Kunde wird je Abschnitt
 *     mit EINEM Schreibvorgang gespeichert, also ganz oder gar nicht.
 *   Bestellungen, die NACH statsRebuildAt abgeschlossen wurden, hat
 *     send-email.js schon live gezaehlt; der Neuaufbau laesst sie aus.
 *   Geschrieben wird mit onlyIfMatch (etag). Hat send-email.js den Kunden
 *     zwischen Lesen und Schreiben geaendert, wird neu gelesen und neu gerechnet.
 *
 * Kunden ohne Bestellung im Archiv werden nicht angefasst.
 *
 * WICHTIG: Das Archiv haelt abgeschlossene Bestellungen nur 90 Tage
 * (orders-reconcile.js). Ein Neuaufbau kennt also nur diese 90 Tage. Der
 * erste Lauf nach dem Start der Funktion ist richtig und gewollt. Ein
 * spaeterer Lauf wuerde aeltere, live gezaehlte Bestellungen verlieren;
 * deshalb verweigert die Function einen zweiten Lauf ohne force: true.
 * Am besten ausserhalb der Oeffnungszeiten laufen lassen.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung } = require('./lib/admin-sitzung');
const { addOrderToStats } = require('./lib/abzeichen');

const META_KEY = 'meta:stats_backfill';
const GRENZEN = {
  zeitMs: 5000,       // danach keine neuen Bestellungen mehr lesen
  maxJeAufruf: 300,   // Bestell-Schluessel je Aufruf
  leseWelle: 15,      // parallele Lesezugriffe
  schreibWelle: 5,    // parallele Kunden-Schreibvorgaenge
};

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

const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

// --- Team-Auth wie revenue-stats.js / backup-list.js ------------------------
async function authRole(pw) {
  if (!pw) return null;
  const admin = process.env.ADMIN_PASSWORD || '';
  if (admin && pw === admin) return { role: 'superadmin', name: 'Kubi' };
  try {
    const t = store('team');
    const { blobs } = await t.list({ prefix: 'u:' });
    const h = sha(pw);
    for (const b of blobs) {
      const u = await t.get(b.key, { type: 'json' });
      if (u && u.pwHash === h) return { role: u.role === 'admin' ? 'admin' : 'staff', name: u.name || b.key.slice(2) };
    }
  } catch (e) {}
  return null;
}

async function auditLog(who, text) {
  try {
    const key = 'a:' + new Date().toISOString() + '_' + Math.random().toString(36).slice(2, 7);
    await store('audit').setJSON(key, {
      at: new Date().toISOString(),
      name: (who && who.name) || '?',
      role: (who && who.role) || '?',
      action: 'Statistik',
      detail: String(text || '').slice(0, 300),
    });
  } catch (e) {}
}

// --- Cursor -----------------------------------------------------------------
function cursorBauen(runId, nachKey) {
  return Buffer.from(JSON.stringify({ r: runId, a: nachKey })).toString('base64url');
}
function cursorLesen(c) {
  try {
    const d = JSON.parse(Buffer.from(String(c || ''), 'base64url').toString('utf8'));
    if (!d || typeof d.r !== 'string' || typeof d.a !== 'string') return null;
    if (!/^[a-z0-9]{6,40}$/.test(d.r) || d.a.length > 80) return null;
    return d;
  } catch (e) { return null; }
}

/* Taugt dieser Archiv-Eintrag fuer die Statistik? Liefert { hash, order, at } oder null. */
function auswerten(rec) {
  if (!rec || rec.status !== 'completed' || rec.kind === 'giftcard') return null;
  if (rec.accrued !== true) return null;
  const o = rec.order;
  if (!o || typeof o !== 'object' || o.isTest || !o.email) return null;
  const at = new Date(rec.completedAt || rec.createdAt || 0);
  if (!isFinite(at.getTime()) || at.getTime() <= 0) return null;
  return { hash: sha(String(o.email).trim().toLowerCase()), order: o, at };
}

/* Einen Kunden mit seinen Bestellungen dieses Abschnitts fortschreiben.
   Rueckgabe: Anzahl gezaehlter Bestellungen, null wenn es den Kunden nicht gibt. */
async function kundeAktualisieren(cs, hash, liste, runId) {
  const key = 'c:' + hash;
  for (let versuch = 0; versuch < 4; versuch++) {
    const got = await cs.getWithMetadata(key, { type: 'json' });
    const cust = got && got.data;
    if (!cust || typeof cust !== 'object') return null;   // Konto geloescht: nicht neu anlegen

    if (cust.statsRebuild !== runId) {
      cust.stats = {};
      cust.badgesAt = {};
      cust.statsRebuild = runId;
      cust.statsRebuildAt = new Date().toISOString();
      cust.statsRebuildKey = '';
    }
    const grenzeZeit = new Date(cust.statsRebuildAt || 0).getTime() || Date.now();
    const schonBis = String(cust.statsRebuildKey || '');

    // Chronologisch zaehlen, damit "erreicht am" so gut wie moeglich stimmt
    const offen = liste
      .filter((x) => x.key > schonBis && x.at.getTime() < grenzeZeit)
      .sort((a, b) => a.at - b.at);
    let gezaehlt = 0;
    for (const x of offen) {
      addOrderToStats(cust, x.order, x.at);
      gezaehlt++;
    }
    const maxKey = liste.reduce((m, x) => (x.key > m ? x.key : m), schonBis);
    cust.statsRebuildKey = maxKey;

    const res = got.etag
      ? await cs.setJSON(key, cust, { onlyIfMatch: got.etag })
      : await cs.setJSON(key, cust);
    if (!res || res.modified !== false) return gezaehlt;
    // Zwischendurch geaendert (z. B. Live-Bestellung): neu lesen, neu rechnen
  }
  throw new Error('Kunde ' + hash.slice(0, 8) + ' konnte nicht gespeichert werden');
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  const start = Date.now();

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }

  // Bremse gegen Durchprobieren - siehe lib/auth-guard.js
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;
  const who = await authRole(await passwortAusSitzung(input.password));
  await meldeErgebnis(event, !!who);
  if (!who) return json(401, { error: 'unauthorized' });
  if (who.role !== 'superadmin' && who.role !== 'admin') {
    return json(403, { error: 'forbidden', hint: 'Nur für Admins' });
  }

  const os = store('orders');
  const cs = store('customers');

  try {
    let meta = await os.get(META_KEY, { type: 'json' });
    if (input.status) return json(200, { ok: true, meta: meta || null });

    let runId, nachKey;
    if (input.cursor) {
      const c = cursorLesen(input.cursor);
      if (!c) return json(400, { error: 'bad_cursor' });
      if (!meta || meta.runId !== c.r) {
        return json(409, { error: 'run_superseded', hint: 'Ein neuerer Lauf wurde gestartet. Bitte neu beginnen.' });
      }
      runId = c.r;
      nachKey = c.a;
    } else {
      if (meta && meta.finishedAt && input.force !== true) {
        return json(409, {
          error: 'already_done', meta,
          hint: 'Die Statistik wurde schon aufgebaut. Ein neuer Lauf kennt nur die letzten 90 Tage und ersetzt ältere Zahlen. Nur mit force: true starten.',
        });
      }
      runId = Date.now().toString(36) + crypto.randomBytes(5).toString('hex');
      nachKey = '';
      meta = { runId, startedAt: new Date().toISOString(), finishedAt: null, by: who.name,
        processed: 0, counted: 0, customers: 0 };
      await os.setJSON(META_KEY, meta);
      await auditLog(who, 'Statistik-Neuaufbau gestartet (Lauf ' + runId + (input.force ? ', erzwungen' : '') + ')');
    }

    // --- Schluessel holen, sortieren, ab Cursor ------------------------------
    const { blobs } = await os.list({ prefix: 'o:' });
    const alle = blobs.map((b) => b.key).sort();
    const rest = alle.filter((k) => k > nachKey);

    // --- Lesen, solange Zeit und Menge reichen -------------------------------
    const proKunde = {};
    let gelesen = 0;
    let letzterKey = nachKey;
    for (let i = 0; i < rest.length && gelesen < GRENZEN.maxJeAufruf; i += GRENZEN.leseWelle) {
      // Mindestens eine Welle je Aufruf, sonst kaeme der Lauf nie voran
      if (gelesen > 0 && Date.now() - start > GRENZEN.zeitMs) break;
      const welle = rest.slice(i, Math.min(i + GRENZEN.leseWelle, i + (GRENZEN.maxJeAufruf - gelesen)));
      const recs = await Promise.all(welle.map((k) => os.get(k, { type: 'json' }).catch(() => null)));
      welle.forEach((k, j) => {
        const x = auswerten(recs[j]);
        if (x) (proKunde[x.hash] = proKunde[x.hash] || []).push({ key: k, order: x.order, at: x.at });
      });
      gelesen += welle.length;
      letzterKey = welle[welle.length - 1];
    }

    // --- Kunden schreiben ------------------------------------------------------
    const hashes = Object.keys(proKunde);
    let gezaehlt = 0;
    let kunden = 0;
    for (let i = 0; i < hashes.length; i += GRENZEN.schreibWelle) {
      const welle = hashes.slice(i, i + GRENZEN.schreibWelle);
      const n = await Promise.all(welle.map((h) => kundeAktualisieren(cs, h, proKunde[h], runId)));
      for (const x of n) if (x !== null) { kunden++; gezaehlt += x; }
    }

    const fertig = rest.length <= gelesen;
    meta = (await os.get(META_KEY, { type: 'json' })) || meta;
    if (meta.runId === runId) {
      meta.processed = (meta.processed || 0) + gelesen;
      meta.counted = (meta.counted || 0) + gezaehlt;
      meta.customers = (meta.customers || 0) + kunden;
      if (fertig) meta.finishedAt = new Date().toISOString();
      await os.setJSON(META_KEY, meta);
    }
    if (fertig) {
      await auditLog(who, 'Statistik-Neuaufbau fertig (Lauf ' + runId + '): '
        + (meta.counted || 0) + ' Bestellungen gezählt');
    }

    return json(200, {
      ok: true,
      runId,
      processed: gelesen,
      counted: gezaehlt,
      customers: kunden,
      total: alle.length,
      remaining: Math.max(0, rest.length - gelesen),
      nextCursor: fertig ? null : cursorBauen(runId, letzterKey),
      done: fertig,
    });
  } catch (e) {
    console.error('stats-backfill:', e && e.message);
    console.error('stats-backfill:', e && e.message);
    return json(500, { error: 'backfill_failed' });
  }
};

// Fuer Tests
exports._intern = { auswerten, kundeAktualisieren, cursorBauen, cursorLesen, GRENZEN };
