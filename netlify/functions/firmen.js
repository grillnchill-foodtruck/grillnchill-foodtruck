/**
 * firmen.js
 * ----------------------------------------------------------------------------
 * Öffentlicher Endpunkt für den Firmen-Mittag.
 *
 *   POST { action: 'antrag', firma, ansprechperson, email, telefon,
 *          lieferadresse: { street, zip, city }, rechnungsadresse: {…},
 *          ustId?, domain?, personen, gebiet?: { km, zone, fee },
 *          website (Honigtopf, bleibt leer), turnstileToken? }
 *        → { ok: true }
 *     Legt antrag:<id> im Store "firmen" an und meldet Kubi per Telegram.
 *
 *   POST { action: 'pruefen', code, email, betrag }
 *        → { ok: true, firma: { name, lieferadresse }, rest }
 *        | { ok: false, grund: 'code' | 'inaktiv' | 'domain' | 'limit', rest? }
 *     Für die Kasse: erst wenn das ok ist, erscheint "Auf Firmenrechnung".
 *     Verbindlich prüft send-email.js beim Bestellen noch einmal.
 *
 * Die Liefergebiet-Prüfung im Antrag macht der Browser (Nominatim, wie auf
 * /liefergebiet). Das Ergebnis wird mit Herkunft "browser" gespeichert,
 * Kubi sieht es vor dem Annehmen im Admin.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { schutz, saeubern } = require('./lib/bremse');
const { telegram, esc } = require('./lib/telegram');
const F = require('./lib/firmen');

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

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

function adresse(a) {
  const x = a && typeof a === 'object' ? a : {};
  const street = F.clean(x.street, 80);
  const zip = String(x.zip || '').replace(/\D/g, '').slice(0, 5);
  const city = F.clean(x.city, 40);
  if (!street || zip.length !== 5 || !city) return null;
  return { street, zip, city };
}

async function turnstileOk(token) {
  const secret = process.env.TURNSTILE_SECRET || '';
  if (!secret) return true;   // wie beim Catering-Formular: nur aktiv, wenn eingerichtet
  if (!token) return false;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, response: String(token).slice(0, 2048) }),
    });
    const d = await r.json().catch(() => null);
    return !!(d && d.success);
  } catch (e) {
    console.error('firmen turnstile:', e.message);
    return false;
  }
}

async function antrag(input) {
  // Honigtopf: Menschen sehen das Feld nicht. Bots bekommen ein freundliches ok.
  if (String(input.website || '').trim()) return json(200, { ok: true });

  const firma = F.clean(input.firma, 80);
  const ansprechperson = F.clean(input.ansprechperson, 60);
  const email = F.clean(input.email, 120).toLowerCase();
  const telefon = F.clean(input.telefon, 30);
  const lieferadresse = adresse(input.lieferadresse);
  const rechnungsadresse = adresse(input.rechnungsadresse) || lieferadresse;
  const personen = Math.max(1, Math.min(5000, parseInt(input.personen, 10) || 0));
  const ustRoh = String(input.ustId || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 14);
  const ustId = /^[A-Z]{2}[A-Z0-9]{2,12}$/.test(ustRoh) ? ustRoh : '';
  const domains = F.domainsLesen(input.domain);

  const fehlt = [];
  if (!firma) fehlt.push('firma');
  if (!ansprechperson) fehlt.push('ansprechperson');
  if (!EMAIL.test(email)) fehlt.push('email');
  if (telefon.replace(/\D/g, '').length < 6) fehlt.push('telefon');
  if (!lieferadresse) fehlt.push('lieferadresse');
  if (!(parseInt(input.personen, 10) > 0)) fehlt.push('personen');
  if (fehlt.length) return json(400, { error: 'felder', felder: fehlt });

  if (!(await turnstileOk(input.turnstileToken))) return json(403, { error: 'bot' });

  // Ergebnis der Gebietsprüfung im Browser (nur zur Info für Kubi)
  const g = input.gebiet && typeof input.gebiet === 'object' ? input.gebiet : null;
  const gebiet = g ? {
    km: Math.max(0, Math.min(999, Math.round((Number(g.km) || 0) * 10) / 10)),
    zone: Math.max(0, Math.min(9, parseInt(g.zone, 10) || 0)),
    fee: F.r2(g.fee),
    quelle: 'browser',
  } : null;
  if (gebiet && !gebiet.zone) return json(400, { error: 'gebiet' });

  const id = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
  const rec = {
    id, status: 'neu',
    firma, ansprechperson, email, telefon,
    lieferadresse, rechnungsadresse, ustId, domains, personen, gebiet,
    lang: F.clean(input.lang, 5) || 'de',
    at: new Date().toISOString(),
  };
  try {
    await F.store().setJSON('antrag:' + id, rec);
  } catch (e) {
    console.error('firmen antrag speichern:', e.message);
    return json(500, { error: 'speichern' });
  }

  await telegram(
    '<b>Neuer Firmen-Antrag</b>\n'
    + esc(firma) + ' · ca. ' + personen + ' Personen\n'
    + esc(ansprechperson) + ' · ' + esc(telefon) + '\n'
    + esc(email) + '\n'
    + esc(lieferadresse.street) + ', ' + esc(lieferadresse.zip) + ' ' + esc(lieferadresse.city)
    + (gebiet ? '\nZone ' + gebiet.zone + ' (' + String(gebiet.km).replace('.', ',') + ' km)' : '')
    + '\nAnnehmen im Admin unter Firmen.',
    { html: true });

  return json(200, { ok: true });
}

exports.handler = async (event) => {
  // Grundschutz: Anfragen je Absender und Größe begrenzen (lib/bremse.js)
  const halt = await schutz(event, { name: 'firmen', max: 30, maxKB: 16 });
  if (halt) return halt;
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input = {};
  try { input = saeubern(JSON.parse(event.body || '{}'), { maxText: 400 }); } catch (e) { return json(400, { error: 'invalid_json' }); }
  const action = String(input.action || '');

  try {
    if (action === 'antrag') {
      // Anträge strenger begrenzen als Code-Prüfungen
      const halt2 = await schutz(event, { name: 'firmen-antrag', max: 5, fensterMin: 60, maxKB: 16 });
      if (halt2) return halt2;
      return await antrag(input);
    }

    if (action === 'pruefen') {
      const betrag = Math.max(0, Math.min(5000, Number(input.betrag) || 0));
      const p = await F.pruefen({ code: input.code, email: input.email, betrag });
      if (!p.ok) return json(200, { ok: false, grund: p.grund, rest: p.grund === 'limit' ? p.rest : undefined });
      return json(200, { ok: true, firma: F.oeffentlich(p.firma), rest: p.rest });
    }

    return json(400, { error: 'unknown_action' });
  } catch (e) {
    console.error('firmen:', e && e.message);
    return json(500, { error: 'server' });
  }
};
