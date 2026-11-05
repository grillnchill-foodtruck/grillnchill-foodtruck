/**
 * giftcard-einloesen.js
 * ----------------------------------------------------------------------------
 * Geschenkgutschein am Truck einlösen (Scanner im Admin-Tool, alle Team-Rollen,
 * auch Minijobber).
 *
 *   POST { password, action:'pruefen', code }                     → Gutschein anzeigen
 *   POST { password, action:'einloesen', code, bestellwert }      → einlösen
 *   POST { password, action:'zuruecknehmen', code }               → Vertipper rückgängig
 *
 * Regeln wie online (AGB § 8): einmalig, ab einem Bestellwert in Höhe des
 * Gutscheinwerts, kein Restguthaben. Das Team gibt den Bestellwert ein und
 * kassiert in SumUp nur die Differenz. Zurücknehmen darf, wer eingelöst hat,
 * innerhalb von 15 Minuten; der Admin immer. Alles landet namentlich im
 * Protokoll.
 *
 * Doppelt einlösen verhindert die Sperre gr:<CODE> (onlyIfNew): zwei
 * Handys, die denselben Code gleichzeitig einlösen, bekommen nur einmal Ja.
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung } = require('./lib/admin-sitzung');
const { mitglied } = require('./lib/team-passwort');
const { codeNormalisieren } = require('./lib/gutschein-code');
const { berlin } = require('./lib/geschenk');

const RUECKNAHME_MIN = 15;

const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
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

async function protokoll(who, text) {
  try {
    await store('audit').setJSON('a:' + new Date().toISOString() + '_' + Math.random().toString(36).slice(2, 7), {
      at: new Date().toISOString(), name: (who && who.name) || '?', role: (who && who.role) || '?',
      action: 'Gutschein', detail: String(text || '').slice(0, 300),
    });
  } catch (e) {}
}

const euro = (n) => Number(n || 0).toFixed(2).replace('.', ',') + ' €';

function ansicht(v, d, jetzt) {
  const heute = berlin(jetzt).tag;
  let status = 'offen';
  if (v.active === false) status = 'gesperrt';
  else if ((v.uses || 0) >= (v.maxUses || 1)) status = 'eingeloest';
  else if (v.validUntil && v.validUntil < heute) status = 'abgelaufen';
  return {
    code: v.code, value: v.value, minOrder: v.minOrder || v.value, validUntil: v.validUntil || '',
    status, recipientName: (d && d.recipientName) || '',
    redeemedVia: v.redeemedVia || (status === 'eingeloest' ? 'online' : null),
    redeemedAt: v.manualRedeemedAt || v.lastRedeemedAt || null,
    redeemedBy: v.redeemedBy || null,
    bestellwert: v.truckBestellwert || null,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }

  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;
  const who = await authRole(await passwortAusSitzung(input.password));
  await meldeErgebnis(event, !!who);
  if (!who) return json(401, { error: 'unauthorized' });

  const code = codeNormalisieren(input.code);
  if (!/^GNC[A-Z0-9]{6}$/.test(code)) return json(400, { error: 'bad_code', hint: 'Ein Gutschein-Code beginnt mit GNC, dahinter sechs Zeichen.' });
  const vs = store('vouchers');
  const key = 'c:' + code;
  const v = await vs.get(key, { type: 'json' });
  if (!v || !v.giftcard) return json(404, { error: 'not_found', hint: 'Diesen Gutschein gibt es nicht.' });
  const d = await vs.get('gd:' + code, { type: 'json' }).catch(() => null);

  if (input.action === 'pruefen') return json(200, { ok: true, gift: ansicht(v, d) });

  if (input.action === 'einloesen') {
    const a = ansicht(v, d);
    if (a.status === 'eingeloest') return json(409, { error: 'used', hint: 'Dieser Gutschein ist schon eingelöst.', gift: a });
    if (a.status === 'abgelaufen') return json(409, { error: 'expired', hint: 'Dieser Gutschein ist abgelaufen.', gift: a });
    if (a.status === 'gesperrt') return json(409, { error: 'inactive', hint: 'Dieser Gutschein ist gesperrt.', gift: a });
    const bw = Math.round(Number(String(input.bestellwert == null ? '' : input.bestellwert).replace(',', '.')) * 100) / 100;
    if (!Number.isFinite(bw) || bw <= 0 || bw > 2000) return json(400, { error: 'bad_total', hint: 'Gib den Bestellwert ein.' });
    if (bw < a.minOrder) {
      return json(400, { error: 'too_low', hint: 'Die Bestellung muss mindestens ' + euro(a.minOrder) + ' kosten. Es fehlen noch ' + euro(a.minOrder - bw) + '.' });
    }
    // Sperre: nur ein Einlösen je Code, auch bei zwei Handys gleichzeitig
    try {
      const sperre = { at: new Date().toISOString(), by: who.name };
      const r = await vs.setJSON('gr:' + code, sperre, { onlyIfNew: true });
      if (r && r.modified === false) {
        // Alte Sperre (z. B. Admin hat die Einlösung im Gutschein-Reiter zurückgenommen): nach 2 Minuten frei
        const alt = await vs.get('gr:' + code, { type: 'json' }).catch(() => null);
        if (alt && Date.now() - Date.parse(alt.at || 0) < 120000) return json(409, { error: 'used', hint: 'Dieser Gutschein wurde gerade eingelöst.', gift: ansicht(v, d) });
        await vs.setJSON('gr:' + code, sperre);
      }
    } catch (e) {}
    const frisch = (await vs.get(key, { type: 'json' })) || v;
    if ((frisch.uses || 0) >= (frisch.maxUses || 1)) return json(409, { error: 'used', hint: 'Dieser Gutschein ist schon eingelöst.', gift: ansicht(frisch, d) });
    const jetzt = new Date().toISOString();
    frisch.uses = frisch.maxUses > 0 ? frisch.maxUses : (frisch.uses || 0) + 1;
    frisch.manualRedeemedAt = jetzt;
    frisch.redeemedVia = 'truck';
    frisch.redeemedBy = who.name;
    frisch.truckBestellwert = bw;
    await vs.setJSON(key, frisch);
    const rest = Math.round((bw - frisch.value) * 100) / 100;
    await protokoll(who, code + ' am Truck eingelöst (' + euro(frisch.value) + '), Bestellwert ' + euro(bw) + ', in SumUp ' + euro(rest));
    return json(200, { ok: true, gift: ansicht(frisch, d), rest });
  }

  if (input.action === 'zuruecknehmen') {
    if (v.redeemedVia !== 'truck') return json(409, { error: 'not_truck', hint: 'Nur Einlösungen am Truck lassen sich hier zurücknehmen.' });
    const alter = Date.now() - Date.parse(v.manualRedeemedAt || 0);
    const eigen = v.redeemedBy === who.name;
    if (who.role !== 'admin' && !(eigen && alter < RUECKNAHME_MIN * 60000)) {
      return json(403, { error: 'forbidden', hint: 'Zurücknehmen geht nur ' + RUECKNAHME_MIN + ' Minuten lang durch dieselbe Person. Danach kann es der Admin.' });
    }
    v.uses = 0;
    delete v.manualRedeemedAt; delete v.redeemedVia; delete v.redeemedBy; delete v.truckBestellwert;
    await vs.setJSON(key, v);
    try { await vs.delete('gr:' + code); } catch (e) {}
    await protokoll(who, code + ' Einlösung am Truck zurückgenommen (wieder einlösbar)');
    return json(200, { ok: true, gift: ansicht(v, d) });
  }

  return json(400, { error: 'bad_action' });
};
