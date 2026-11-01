/**
 * catering-angebot.js
 * ----------------------------------------------------------------------------
 * Catering-Angebote im Admin-Tool (Reiter "Catering"). Nur Admin und
 * Superadmin; Mitarbeiter sehen die Anfragen, aber keine Preise.
 *
 *   GET  ?liste=1              -> { angebote, summen, einstellungen }
 *   GET  ?id=<id>              -> { angebot, einstellungen }
 *   GET  ?pdf=<id>             -> application/pdf (mit Sitzung im Header)
 *   GET  ?pdf=<id>&exp=…&sig=… -> application/pdf (signierter 10-Minuten-Link,
 *                                 für iframe-Vorschau und neuen Tab)
 *   POST { password, action, … }
 *        neu          { anfrage? }          Entwurf, vorbefüllt aus der Anfrage
 *        speichern    { id, angebot }       nur Entwürfe
 *        senden       { id }                Mail mit PDF und Kundenlink
 *        status       { id, status }        angenommen | bezahlt | abgelehnt
 *        duplizieren  { id }
 *        loeschen     { id }                nur Entwürfe
 *        einstellungen { einstellungen }
 *        pdfLink      { id }                -> { url } signierter Link (10 Minuten)
 *
 * Anmeldung wie catering-list.js (Sitzungs-Token mit Zwei-Faktor, Bremse
 * über lib/auth-guard.js). Logik in lib/catering-angebot.js.
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung, nachweis } = require('./lib/admin-sitzung');
const { mitglied } = require('./lib/team-passwort');
const { saeubern, schutz } = require('./lib/bremse');
const A = require('./lib/catering-angebot');

const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(data),
});

function teamStore() {
  const opts = { name: 'team', consistency: 'strong' };
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
    const t = teamStore();
    const { blobs } = await t.list({ prefix: 'u:' });
    const { key, u } = (await mitglied(t, pw, blobs)) || {};
    if (u) return { role: u.role === 'admin' ? 'admin' : 'staff', name: u.name || key.slice(2) };
  } catch (e) {}
  return null;
}

// Fehlercodes, die das Admin-Tool in Klartext übersetzt
const BEKANNT = ['bad_key', 'anfrage_fehlt', 'nicht_gefunden', 'nur_entwurf', 'status', 'email_fehlt', 'name_fehlt',
  'betrag_fehlt', 'datum_vorbei', 'status_nicht_moeglich', 'online_bezahlt'];

async function pdfAntwort(id, herunterladen) {
  const s = A.store();
  const a = await A.laden(s, id);
  if (!a) return json(404, { error: 'nicht_gefunden' });
  const e = await A.einstellungenLesen(s);
  const pdf = await require('./lib/angebot-pdf').angebotPdf(a, e);
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': (herunterladen ? 'attachment' : 'inline') + '; filename="Angebot-' + a.nummer + '.pdf"',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    },
    body: pdf.toString('base64'),
    isBase64Encoded: true,
  };
}

exports.handler = async (event) => {
  const methode = event.httpMethod;
  if (methode !== 'GET' && methode !== 'POST') return json(405, { error: 'method_not_allowed' });
  const p = event.queryStringParameters || {};

  // Signierter PDF-Link (ohne Sitzung): nur dieses PDF, 10 Minuten
  if (methode === 'GET' && p.pdf && p.sig) {
    const halt = await schutz(event, { name: 'angebot-pdf', max: 60, maxKB: 4 });
    if (halt) return halt;
    if (!A.pdfLinkGueltig(p.pdf, p.exp, p.sig)) return json(403, { error: 'link_ungueltig' });
    try { return await pdfAntwort(p.pdf, p.download === '1'); }
    catch (err) { console.error('catering-angebot pdf:', (err && err.stack) || err); return json(500, { error: 'server_error' }); }
  }
  let input = {};
  if (methode === 'POST') {
    try { input = saeubern(JSON.parse(event.body || '{}'), { maxText: 2000 }); } catch (e) { return json(400, { error: 'bad_json' }); }
  }

  // Bremse gegen Durchprobieren, siehe lib/auth-guard.js
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;
  const who = await authRole(await passwortAusSitzung(methode === 'GET' ? nachweis(event, p.password) : input.password));
  await meldeErgebnis(event, !!who);
  if (!who) return json(401, { error: 'unauthorized' });
  if (who.role !== 'admin') return json(403, { error: 'forbidden' });
  const wer = who.name || 'Admin';

  try {
    if (methode === 'GET') {
      if (p.pdf) return await pdfAntwort(p.pdf, p.download === '1');
      const e = await A.einstellungenLesen();
      if (p.id) {
        const a = await A.laden(A.store(), p.id);
        if (!a) return json(404, { error: 'nicht_gefunden' });
        return json(200, { angebot: A.adminAnsicht(a), einstellungen: e });
      }
      const angebote = await A.alle();
      return json(200, { angebote, summen: A.summen(angebote), einstellungen: e });
    }

    const id = String(input.id || '');
    switch (input.action) {
      case 'neu': {
        const a = await A.anlegen({ anfrageKey: input.anfrage ? String(input.anfrage) : null, wer });
        return json(200, { ok: true, angebot: A.adminAnsicht(a) });
      }
      case 'speichern': {
        const a = await A.speichern(id, input.angebot, { wer });
        return json(200, { ok: true, angebot: A.adminAnsicht(a) });
      }
      case 'senden': {
        const a = await A.senden(id, { wer });
        return json(200, { ok: true, angebot: A.adminAnsicht(a) });
      }
      case 'status': {
        const a = await A.statusSetzen(id, String(input.status || ''), { wer });
        return json(200, { ok: true, angebot: A.adminAnsicht(a) });
      }
      case 'duplizieren': {
        const a = await A.duplizieren(id, { wer });
        return json(200, { ok: true, angebot: A.adminAnsicht(a) });
      }
      case 'loeschen': {
        await A.loeschen(id);
        return json(200, { ok: true });
      }
      case 'pdfLink': {
        if (!(await A.laden(A.store(), id))) return json(404, { error: 'nicht_gefunden' });
        return json(200, { ok: true, url: A.pdfLink(id) });
      }
      case 'einstellungen': {
        const e = await A.einstellungenSpeichern(input.einstellungen, wer);
        return json(200, { ok: true, einstellungen: e });
      }
      default:
        return json(400, { error: 'bad_action' });
    }
  } catch (err) {
    if (err && BEKANNT.includes(err.code)) return json(err.status || 400, { error: err.code });
    console.error('catering-angebot:', (err && err.stack) || err);
    // Mailfehler beim Senden: Angebot bleibt Entwurf, Kubi kann es erneut versuchen
    if (input.action === 'senden') return json(502, { error: 'mail_fehlgeschlagen' });
    return json(500, { error: 'server_error' });
  }
};
