/**
 * feedback.js
 * ----------------------------------------------------------------------------
 * Bewertung nach jeder Bestellung (Statusseite /s/<Bestellnummer>?k=…) und
 * die Liste dazu im Admin-Tool (Reiter „Feedback").
 *
 *   POST { action: 'senden', reference, k, stars (1-5), text?, lang? }
 *        → { ok: true }
 *        Öffentlich. Nachweis ist derselbe Schlüssel k, mit dem die
 *        Statusseite die Bestellung öffnet (order-status.js, statusKey).
 *        Nur nach Abschluss (abgeholt, geliefert), genau eine Bewertung je
 *        Bestellung (409 schon_bewertet). Unter 4 Sternen geht sofort eine
 *        Telegram-Nachricht an Kubi.
 *
 *   POST { action: 'liste', password }
 *        → { ok, gesamt, gelesen, schnitt, liste: [ {ref, stars, text, at, lang, art} ] }
 *        Admin und Inhaber. Neueste zuerst, höchstens die neuesten 500.
 *
 * Speicher: Store "feedback", Schlüssel f:<Bestellnummer>, Wert
 *   { ref, stars, text (max 500), at (ISO), lang, art ('pickup'|'delivery') }
 * (Datenvertrag aller Pakete; das Cockpit liest ihn für den Wochenbericht.)
 * Name, Mail und Telefon stehen bewusst nicht drin.
 *
 * Die Google-Bewertung bietet die Statusseite danach JEDEM an, egal wie
 * viele Sterne. Nach Sternen auszuwählen verbietet Google.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { schutz } = require('./lib/bremse');
const { telegram, esc } = require('./lib/telegram');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung } = require('./lib/admin-sitzung');
const { mitglied } = require('./lib/team-passwort');
const { nrText } = require('./lib/abholnummer');

const SPRACHEN = ['de', 'en', 'tr', 'it', 'es', 'pt', 'fr', 'nl'];
const FERTIG = ['picked_up', 'delivered', 'completed'];   // wie FEEDBACK_STATES in order-status.js
const MAX_TEXT = 500;
const MAX_LISTE = 500;

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

/* Gleiche Formel wie statusKey() in order-status.js und statusPageUrl() in
   send-email.js: sha256(ref|STATUS_UPDATE_SECRET), 20 Zeichen. */
function statusKey(ref) {
  const secret = process.env.STATUS_UPDATE_SECRET || '';
  return crypto.createHash('sha256').update(ref + '|' + secret).digest('hex').slice(0, 20);
}
function keyStimmt(ref, k) {
  const soll = statusKey(ref);
  const ist = String(k || '');
  return ist.length === soll.length && crypto.timingSafeEqual(Buffer.from(ist), Buffer.from(soll));
}

/* Freitext: Zeilenumbrüche bleiben, Steuer- und Richtungszeichen raus. */
function textSaeubern(t) {
  if (typeof t !== 'string') return '';
  return t.replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT);
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

const sterneText = (n) => '★'.repeat(n) + '☆'.repeat(5 - n);

async function senden(event, input) {
  // Strenger als der Grundschutz: niemand bewertet zehn Bestellungen in zehn Minuten
  const halt = await schutz(event, { name: 'feedback-senden', max: 8, maxKB: 4 });
  if (halt) return halt;

  const ref = String(input.reference || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
  if (!/^GNC-\d{10,14}$/.test(ref)) return json(400, { error: 'bad_ref' });
  if (!keyStimmt(ref, input.k)) return json(403, { error: 'forbidden' });
  const stars = Number(input.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return json(400, { error: 'bad_stars' });
  const text = textSaeubern(input.text);
  const lang = SPRACHEN.includes(input.lang) ? input.lang : 'de';

  let rec = null;
  try { rec = await store('orders').get('o:' + ref, { type: 'json' }); } catch (e) {
    console.error('feedback: Bestellung nicht lesbar:', e && e.message);
    return json(503, { error: 'unavailable' });
  }
  if (!rec || rec.kind === 'giftcard' || rec.status !== 'completed') return json(404, { error: 'not_found' });
  if (!FERTIG.includes(rec.fstate)) return json(409, { error: 'noch_nicht_fertig' });

  const art = (rec.order && rec.order.mode) === 'delivery' ? 'delivery' : 'pickup';
  const fb = { ref, stars, text, at: new Date().toISOString(), lang, art };
  const fs = store('feedback');
  const key = 'f:' + ref;
  try {
    if (await fs.get(key, { type: 'json' })) return json(409, { error: 'schon_bewertet' });
    // onlyIfNew: zwei gleichzeitige Absendungen ergeben trotzdem nur eine Bewertung
    const res = await fs.setJSON(key, fb, { onlyIfNew: true });
    if (res && res.modified === false) return json(409, { error: 'schon_bewertet' });
  } catch (e) {
    console.error('feedback: speichern fehlgeschlagen:', e && e.message);
    return json(503, { error: 'unavailable' });
  }

  if (stars < 4) {
    const nr = nrText(rec.abholnr);
    await telegram(
      '<b>Feedback unter 4 Sternen</b>\n'
      + 'Bestellung #' + esc(ref) + (nr ? ' · ' + esc(nr) : '') + '\n'
      + sterneText(stars) + ' ' + stars + ' von 5 · ' + (art === 'delivery' ? 'Lieferung' : 'Abholung') + '\n'
      + (text ? '„' + esc(text) + '“' : 'Ohne Text'),
      { html: true });
  }
  return json(200, { ok: true });
}

async function liste(event, input) {
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;
  const who = await authRole(await passwortAusSitzung(input.password));
  await meldeErgebnis(event, !!who);
  if (!who) return json(401, { error: 'unauthorized' });
  if (who.role === 'staff') return json(403, { error: 'forbidden', hint: 'Feedback sehen Admins und der Inhaber' });

  try {
    const fs = store('feedback');
    const { blobs } = await fs.list({ prefix: 'f:' });
    const zeit = (k) => { const m = /^f:GNC-(\d{10,14})$/.exec(k); return m ? Number(m[1]) : 0; };
    const keys = blobs.map((b) => b.key).sort((a, b) => zeit(b) - zeit(a));
    const lesen = keys.slice(0, MAX_LISTE);
    const out = [];
    for (let i = 0; i < lesen.length; i += 40) {
      const teil = lesen.slice(i, i + 40);
      const recs = await Promise.all(teil.map((k) => fs.get(k, { type: 'json' }).catch(() => null)));
      recs.forEach((r) => {
        if (!r || !Number.isInteger(r.stars)) return;
        out.push({
          ref: String(r.ref || ''), stars: r.stars, text: String(r.text || '').slice(0, MAX_TEXT),
          at: r.at || null, lang: r.lang || 'de', art: r.art === 'delivery' ? 'delivery' : 'pickup',
        });
      });
    }
    out.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    const summe = out.reduce((x, r) => x + r.stars, 0);
    return json(200, {
      ok: true,
      gesamt: keys.length,
      gelesen: out.length,
      schnitt: out.length ? Math.round(summe / out.length * 10) / 10 : null,
      liste: out,
    });
  } catch (e) {
    console.error('feedback liste:', e && e.message);
    return json(500, { error: 'read_failed' });
  }
}

exports.handler = async (event) => {
  // Grundschutz: Anfragen je Absender und Größe begrenzen (lib/bremse.js)
  const halt = await schutz(event, { name: 'feedback', max: 40, maxKB: 4 });
  if (halt) return halt;
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }
  if (!input || typeof input !== 'object') return json(400, { error: 'invalid_json' });

  if (input.action === 'senden') return senden(event, input);
  if (input.action === 'liste') return liste(event, input);
  return json(400, { error: 'unknown_action' });
};
