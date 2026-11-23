/**
 * lib/push-plan.js
 * ----------------------------------------------------------------------------
 * Geplante Push-Nachrichten: im Admin-Tool mit Zeitpunkt anlegen und bis zum
 * Versand ändern, sofort senden oder streichen (mit Rückgängig).
 *
 *   Store „push-plan“, Schlüssel p:<id>
 *   { id, title, body, url, ziel, sendAt, status, createdAt, createdBy,
 *     updatedAt, updatedBy, claimedAt?, sentAt?, ergebnis?, fehler? }
 *
 *   status: geplant → sendet → gesendet
 *           geplant → gestrichen (zurückholbar, solange der Zeitpunkt nicht vorbei ist)
 *           sendet  → fehler (nichts raus, z. B. VAPID fehlt) | unklar (Abbruch mitten im Versand)
 *
 * Doppelversand ist ausgeschlossen: Bevor der Zeitplan (push-plan-lauf.js,
 * alle 15 Minuten) oder „Jetzt senden“ eine Nachricht verschickt, setzt er
 * status „sendet“ mit onlyIfMatch auf den gelesenen Stand. Ändert jemand die
 * Nachricht in derselben Sekunde, gewinnt genau einer; danach lässt sich eine
 * Nachricht im Status „sendet“ nicht mehr ändern.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const versand = require('./push-versand');

const VORLAUF_MS = 60 * 1000;               // frühester Zeitpunkt: in einer Minute
const MAX_VORAUS_MS = 60 * 86400000;        // spätestens in 60 Tagen
const HAENGT_MS = 10 * 60 * 1000;           // „sendet“ länger als 10 Minuten: unklar
const AUFHEBEN_MS = 90 * 86400000;          // Erledigtes 90 Tage aufheben
const ZULETZT = 6;                          // so viele erledigte zeigt die Liste

const OFFEN = 'geplant';

function neueId() { return Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }
const schluessel = (id) => 'p:' + String(id || '').replace(/[^a-z0-9]/g, '').slice(0, 40);

async function lesen(s, key) {
  if (typeof s.getWithMetadata === 'function') {
    const g = await s.getWithMetadata(key, { type: 'json' });
    return g ? { rec: g.data, etag: g.etag || null } : { rec: null, etag: null };
  }
  return { rec: await s.get(key, { type: 'json' }), etag: null };
}
async function schreibenWenn(s, key, rec, etag) {
  const r = await s.setJSON(key, rec, etag ? { onlyIfMatch: etag } : {});
  return !(r && r.modified === false);
}

/** Eingaben prüfen. @returns {{ daten } | { fehler, hint }} */
function pruefen(e, jetzt) {
  const x = e || {};
  if (!String(x.title || '').trim() || !String(x.body || '').trim()) return { fehler: 'leer', hint: 'Titel und Nachricht ausfüllen.' };
  const t = Date.parse(x.sendAt);
  if (!Number.isFinite(t)) return { fehler: 'zeit', hint: 'Wähl Datum und Uhrzeit.' };
  if (t < jetzt + VORLAUF_MS) return { fehler: 'zeit_vorbei', hint: 'Der Zeitpunkt ist vorbei oder zu knapp. Wähl einen, der mindestens eine Minute entfernt liegt.' };
  if (t > jetzt + MAX_VORAUS_MS) return { fehler: 'zeit_weit', hint: 'Plan höchstens 60 Tage im Voraus.' };
  return { daten: { ...versand.nachricht(x), sendAt: new Date(t).toISOString() } };
}

/** Für die Anzeige: nur, was das Admin-Tool braucht */
function sicht(r) {
  return {
    id: r.id, title: r.title, body: r.body, ziel: r.ziel, sendAt: r.sendAt, status: r.status,
    createdBy: r.createdBy, updatedAt: r.updatedAt, updatedBy: r.updatedBy,
    sentAt: r.sentAt || null, ergebnis: r.ergebnis || null, fehler: r.fehler || null,
  };
}

/* ---- Protokoll (Store audit, wie die übrigen Admin-Aktionen) ------------- */
async function protokoll(holeStore, wer, detail) {
  try {
    const at = new Date().toISOString();
    await holeStore('audit').setJSON('a:' + at + '_' + Math.random().toString(36).slice(2, 7), {
      at, name: (wer && wer.name) || '?', role: (wer && wer.role) || '?', action: 'Push', detail: String(detail || '').slice(0, 300),
    });
  } catch (e) {}
}
const zeitText = (iso) => {
  try {
    return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
  } catch (e) { return iso; }
};
const zielText = (z) => ({ alle: 'alle', app: 'nur App', web: 'nur Browser' }[z] || z);

/* ---- Anlegen, Liste, Ändern, Streichen, Zurückholen --------------------- */
async function anlegen(e, wer, deps = {}) {
  const holeStore = deps.holeStore || versand.store;
  const jetzt = deps.jetzt || Date.now();
  const p = pruefen(e, jetzt);
  if (p.fehler) return { status: 400, fehler: p.fehler, hint: p.hint };
  const s = holeStore('push-plan');
  const at = new Date(jetzt).toISOString();
  const rec = { id: neueId(), ...p.daten, status: OFFEN, createdAt: at, createdBy: (wer && wer.name) || '?', updatedAt: at, updatedBy: (wer && wer.name) || '?' };
  await s.setJSON(schluessel(rec.id), rec, { onlyIfNew: true });
  await protokoll(holeStore, wer, '„' + rec.title.slice(0, 60) + '“ geplant für ' + zeitText(rec.sendAt) + ' (' + zielText(rec.ziel) + ')');
  return { status: 200, eintrag: sicht(rec) };
}

async function liste(deps = {}) {
  const s = (deps.holeStore || versand.store)('push-plan');
  const { blobs } = await s.list({ prefix: 'p:' });
  const alle = [];
  for (const b of blobs) {
    const r = await s.get(b.key, { type: 'json' });
    if (r && r.id) alle.push(r);
  }
  const offen = alle.filter((r) => r.status === OFFEN || r.status === 'sendet')
    .sort((a, b) => String(a.sendAt).localeCompare(String(b.sendAt)));
  const erledigt = alle.filter((r) => r.status !== OFFEN && r.status !== 'sendet')
    .sort((a, b) => String(b.sentAt || b.updatedAt).localeCompare(String(a.sentAt || a.updatedAt)))
    .slice(0, ZULETZT);
  return { geplant: offen.map(sicht), zuletzt: erledigt.map(sicht) };
}

/**
 * Ändern, solange die Nachricht geplant ist. `stand` = updatedAt, den das
 * Admin-Tool beim Öffnen gesehen hat: Hat inzwischen jemand anderes geändert,
 * kommt 409 „geaendert“ statt still zu überschreiben.
 */
async function aendern(id, e, wer, stand, deps = {}) {
  const holeStore = deps.holeStore || versand.store;
  const jetzt = deps.jetzt || Date.now();
  const s = holeStore('push-plan');
  const key = schluessel(id);
  for (let versuch = 0; versuch < 3; versuch++) {
    const { rec, etag } = await lesen(s, key);
    if (!rec) return { status: 404, fehler: 'nicht_gefunden', hint: 'Diese Nachricht gibt es nicht mehr.' };
    if (rec.status !== OFFEN) return { status: 409, fehler: 'nicht_mehr_offen', hint: rec.status === 'gestrichen' ? 'Diese Nachricht ist gestrichen.' : 'Diese Nachricht wird gerade gesendet oder ist schon raus.', eintrag: sicht(rec) };
    if (stand && rec.updatedAt !== stand) return { status: 409, fehler: 'geaendert', hint: (rec.updatedBy || 'Jemand') + ' hat die Nachricht gerade geändert. Sieh dir den neuen Stand an.', eintrag: sicht(rec) };
    const p = pruefen(e, jetzt);
    if (p.fehler) return { status: 400, fehler: p.fehler, hint: p.hint };
    const neu = { ...rec, ...p.daten, updatedAt: new Date(jetzt).toISOString(), updatedBy: (wer && wer.name) || '?' };
    if (await schreibenWenn(s, key, neu, etag)) {
      const was = [];
      if (rec.title !== neu.title || rec.body !== neu.body) was.push('Text');
      if (rec.ziel !== neu.ziel) was.push('Empfänger ' + zielText(neu.ziel));
      if (rec.sendAt !== neu.sendAt) was.push('Zeit ' + zeitText(neu.sendAt));
      await protokoll(holeStore, wer, '„' + neu.title.slice(0, 60) + '“ geändert' + (was.length ? ': ' + was.join(', ') : ''));
      return { status: 200, eintrag: sicht(neu) };
    }
  }
  return { status: 409, fehler: 'besetzt', hint: 'Gerade gleichzeitig bearbeitet. Versuch es noch einmal.' };
}

async function statusWechsel(id, von, nach, wer, deps, extra) {
  const holeStore = deps.holeStore || versand.store;
  const jetzt = deps.jetzt || Date.now();
  const s = holeStore('push-plan');
  const key = schluessel(id);
  for (let versuch = 0; versuch < 3; versuch++) {
    const { rec, etag } = await lesen(s, key);
    if (!rec) return { status: 404, fehler: 'nicht_gefunden', hint: 'Diese Nachricht gibt es nicht mehr.' };
    if (rec.status !== von) return { status: 409, fehler: 'nicht_mehr_offen', hint: 'Diese Nachricht wird gerade gesendet oder ist schon raus.', eintrag: sicht(rec) };
    if (extra && extra.pruefe) { const f = extra.pruefe(rec, jetzt); if (f) return f; }
    const neu = { ...rec, status: nach, updatedAt: new Date(jetzt).toISOString(), updatedBy: (wer && wer.name) || '?' };
    if (await schreibenWenn(s, key, neu, etag)) return { status: 200, eintrag: sicht(neu), rec: neu };
  }
  return { status: 409, fehler: 'besetzt', hint: 'Gerade gleichzeitig bearbeitet. Versuch es noch einmal.' };
}

async function streichen(id, wer, deps = {}) {
  const r = await statusWechsel(id, OFFEN, 'gestrichen', wer, deps);
  if (r.status === 200) await protokoll(deps.holeStore || versand.store, wer, '„' + r.rec.title.slice(0, 60) + '“ gestrichen (war für ' + zeitText(r.rec.sendAt) + ' geplant)');
  delete r.rec;
  return r;
}

async function zurueckholen(id, wer, deps = {}) {
  const r = await statusWechsel(id, 'gestrichen', OFFEN, wer, deps, {
    pruefe: (rec, jetzt) => (Date.parse(rec.sendAt) < jetzt + VORLAUF_MS
      ? { status: 409, fehler: 'zeit_vorbei', hint: 'Der Zeitpunkt ist vorbei. Nutz die Nachricht als Vorlage und plan sie neu.', eintrag: sicht(rec) }
      : null),
  });
  if (r.status === 200) await protokoll(deps.holeStore || versand.store, wer, '„' + r.rec.title.slice(0, 60) + '“ wieder geplant für ' + zeitText(r.rec.sendAt));
  delete r.rec;
  return r;
}

/* ---- Versand ------------------------------------------------------------ */

/** Nachricht für den Versand sperren (status „sendet“). @returns rec oder null */
async function beanspruchen(s, key, jetzt, nurFaellig) {
  const { rec, etag } = await lesen(s, key);
  if (!rec || rec.status !== OFFEN) return null;
  if (nurFaellig && Date.parse(rec.sendAt) > jetzt) return null;
  const neu = { ...rec, status: 'sendet', claimedAt: new Date(jetzt).toISOString() };
  return (await schreibenWenn(s, key, neu, etag)) ? neu : null;
}

async function abschicken(s, key, rec, wer, deps) {
  const holeStore = deps.holeStore || versand.store;
  const senden = deps.versenden || versand.versenden;
  let ende;
  try {
    const ergebnis = await senden({ title: rec.title, body: rec.body, url: rec.url, ziel: rec.ziel });
    ende = { ...rec, status: 'gesendet', sentAt: new Date().toISOString(), ergebnis };
    await protokoll(holeStore, wer, '„' + rec.title.slice(0, 60) + '“ (' + zielText(rec.ziel) + ') an ' + ergebnis.sent + ' Abonnenten gesendet'
      + (ergebnis.ios === 'gesendet' ? ' + iOS-App' : '') + (wer && wer.role === 'system' ? ', geplant' : ''));
  } catch (e) {
    const nichtsRaus = e && e.code === 'vapid_not_configured';
    ende = { ...rec, status: nichtsRaus ? 'fehler' : 'unklar', sentAt: new Date().toISOString(),
      fehler: nichtsRaus ? 'Push ist nicht eingerichtet (VAPID-Schlüssel fehlen), nichts gesendet.' : 'Abbruch beim Senden: ' + String((e && e.message) || e).slice(0, 160) };
    await protokoll(holeStore, wer, '„' + rec.title.slice(0, 60) + '“: ' + ende.fehler);
  }
  await s.setJSON(key, ende);
  return ende;
}

/** „Jetzt senden“ aus der Liste: ohne auf den Zeitpunkt zu warten */
async function jetztSenden(id, wer, deps = {}) {
  const s = (deps.holeStore || versand.store)('push-plan');
  const key = schluessel(id);
  const jetzt = deps.jetzt || Date.now();
  const rec = await beanspruchen(s, key, jetzt, false);
  if (!rec) {
    const { rec: r } = await lesen(s, key);
    if (!r) return { status: 404, fehler: 'nicht_gefunden', hint: 'Diese Nachricht gibt es nicht mehr.' };
    return { status: 409, fehler: 'nicht_mehr_offen', hint: 'Diese Nachricht wird gerade gesendet oder ist schon raus.', eintrag: sicht(r) };
  }
  const ende = await abschicken(s, key, rec, wer, deps);
  return { status: 200, eintrag: sicht(ende) };
}

/**
 * Zeitplan: fällige Nachrichten senden, hängende als unklar markieren,
 * Erledigtes nach 90 Tagen löschen.
 */
async function faelligeSenden(deps = {}) {
  const holeStore = deps.holeStore || versand.store;
  const jetzt = deps.jetzt || Date.now();
  const s = holeStore('push-plan');
  const { blobs } = await s.list({ prefix: 'p:' });
  const bericht = { gesendet: 0, unklar: 0, geloescht: 0, offen: 0 };
  const system = { name: 'Zeitplan', role: 'system' };
  for (const b of blobs) {
    const r = await s.get(b.key, { type: 'json' });
    if (!r) continue;
    if (r.status === OFFEN) {
      if (Date.parse(r.sendAt) > jetzt) { bericht.offen++; continue; }
      const rec = await beanspruchen(s, b.key, jetzt, true);
      if (!rec) continue;                       // jemand war schneller (Jetzt senden, Ändern)
      const ende = await abschicken(s, b.key, rec, system, deps);
      if (ende.status === 'gesendet') bericht.gesendet++;
      continue;
    }
    if (r.status === 'sendet' && jetzt - Date.parse(r.claimedAt || r.updatedAt) > HAENGT_MS) {
      await s.setJSON(b.key, { ...r, status: 'unklar', fehler: 'Versand hat nicht zurückgemeldet. Vor erneutem Senden im Protokoll prüfen.' });
      bericht.unklar++;
      continue;
    }
    const fertig = Date.parse(r.sentAt || r.updatedAt);
    if (r.status !== 'sendet' && Number.isFinite(fertig) && jetzt - fertig > AUFHEBEN_MS) {
      await s.delete(b.key);
      bericht.geloescht++;
    }
  }
  return bericht;
}

module.exports = {
  anlegen, liste, aendern, streichen, zurueckholen, jetztSenden, faelligeSenden, pruefen,
  VORLAUF_MS, MAX_VORAUS_MS, HAENGT_MS,
};
