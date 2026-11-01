/**
 * burger-pass.js
 * ----------------------------------------------------------------------------
 * Burger-Pass kaufen (Kundenkonto) und Verkäufe ansehen (Admin).
 *
 *   POST { action:'kaufen', email, token, lang?, appMode?, supersedes? }
 *        → { id, hosted_checkout_url, reference }
 *        Nur mit gültiger Konto-Anmeldung und nur, wenn der Admin-Schalter
 *        an ist (lib/zahl-einstellungen.js). Preis, Menüs und Laufzeit kommen
 *        aus den Einstellungen, nie aus der Anfrage.
 *   POST { action:'abbrechen', supersedes:{ reference, checkoutId } }
 *        Kunde kam ohne Zahlung von SumUp zurück: Vorgang stornieren.
 *   POST { action:'pruefen', reference, checkoutId }
 *        → { status, pass? }  Fragt SumUp selbst; bei PAID wird der Pass
 *        ausgestellt (genau einmal, lib/burger-pass.js).
 *   POST { action:'liste', password }  (Admin) → verkaufte Pässe
 *
 * Vorlage: giftcard-checkout.js. Gehostete SumUp-Kasse, Abschluss über
 * sumup-webhook (Sekunden), Rückkehr des Kunden (sofort) und
 * orders-reconcile (5-Minuten-Netz).
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');
const { schutz, saeubern } = require('./lib/bremse');
const { tokenGueltig } = require('./lib/kunden-token');
const einstellungen = require('./lib/zahl-einstellungen');
const bp = require('./lib/burger-pass');

const SUMUP_API_BASE = 'https://api.sumup.com/v0.1';
const SPRACHEN = ['de', 'en', 'tr', 'it', 'es', 'pt', 'fr', 'nl'];

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

const refSauber = (r) => String(r || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
const normEmail = (e) => String(e || '').trim().toLowerCase().slice(0, 120);

/* Vorherigen, nicht bezahlten Kaufversuch stornieren. Sicherheit wie bei
   den Gutscheinen: Referenz UND geheime Checkout-ID müssen passen, nur
   'pending'. Zahlt jemand doch noch, belebt der Webhook den Vorgang wieder. */
async function stornieren(sup, grund) {
  if (!sup || typeof sup.reference !== 'string' || !/^GNC-BP-/.test(sup.reference) || !sup.checkoutId) return false;
  const os = store('orders');
  const okey = 'o:' + refSauber(sup.reference);
  const alt = await os.get(okey, { type: 'json' });
  if (!alt || alt.status !== 'pending' || alt.checkoutId !== sup.checkoutId) return false;
  alt.status = 'cancelled';
  alt.cancelledAt = new Date().toISOString();
  alt.cancelReason = grund;
  await os.setJSON(okey, alt);
  return true;
}

/* Admin-Anmeldung wie in loyalty-scan.js (Sitzung mit Zwei-Faktor) */
async function adminRolle(event, pw) {
  const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
  const { passwortAusSitzung } = require('./lib/admin-sitzung');
  const { mitglied } = require('./lib/team-passwort');
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return { halt: gesperrt };
  const klar = await passwortAusSitzung(pw);
  let who = null;
  if (klar) {
    const admin = process.env.ADMIN_PASSWORD || '';
    if (admin && klar === admin) who = { role: 'admin', name: 'Kubi' };
    else {
      try {
        const t = store('team');
        const { blobs } = await t.list({ prefix: 'u:' });
        const { key, u } = (await mitglied(t, klar, blobs)) || {};
        if (u) who = { role: u.role === 'admin' ? 'admin' : 'staff', name: u.name || key.slice(2) };
      } catch (e) {}
    }
  }
  await meldeErgebnis(event, !!who);
  return { who };
}

exports.handler = async (event) => {
  const halt = await schutz(event, { name: 'burgerpass', max: 30, maxKB: 8 });
  if (halt) return halt;
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input = {};
  try { input = saeubern(JSON.parse(event.body || '{}'), { maxText: 400 }); } catch (e) { return json(400, { error: 'invalid_json' }); }
  const action = String(input.action || '');

  try {
    /* ---------------- Kaufversuch abbrechen ---------------- */
    if (action === 'abbrechen') {
      const ok = await stornieren(input.supersedes, 'user_back').catch(() => false);
      return json(200, { ok: true, cancelled: !!ok });
    }

    /* ---------------- Zahlung prüfen (Rückkehr des Kunden) ---------------- */
    if (action === 'pruefen') {
      const ref = refSauber(input.reference);
      const ck = String(input.checkoutId || '').slice(0, 80);
      if (!/^GNC-BP-/.test(ref) || !ck) return json(400, { error: 'bad_reference' });
      const os = store('orders');
      const key = 'o:' + ref;
      const rec = await os.get(key, { type: 'json' });
      // Die Checkout-ID ist der Nachweis: nur wer gekauft hat, kennt sie.
      if (!rec || rec.kind !== 'burgerpass' || rec.checkoutId !== ck) return json(404, { error: 'not_found' });
      if (rec.status === 'completed' && rec.passId) {
        const p = await store(bp.PASS_STORE).get('p:' + rec.passId, { type: 'json' });
        return json(200, { status: 'PAID', pass: p ? { name: p.name, menus: p.menusGesamt, bis: p.gueltigBis } : null });
      }
      const apiKey = process.env.SUMUP_API_KEY;
      if (!apiKey) return json(500, { error: 'not_configured' });
      const res = await fetch(`${SUMUP_API_BASE}/checkouts/${encodeURIComponent(ck)}`, {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      });
      const d = await res.json().catch(() => null);
      if (!res.ok || !d) return json(502, { error: 'lookup_failed' });
      const status = String(d.status || 'UNKNOWN').toUpperCase();
      if (status === 'PAID') {
        if (rec.status === 'cancelled' || rec.status === 'abandoned') { rec.revivedAt = new Date().toISOString(); }
        const r = await bp.kaufAbschliessen(os, key, rec);
        return json(200, { status: 'PAID', pass: { name: r.pass.name, menus: r.pass.menusGesamt, bis: r.pass.gueltigBis } });
      }
      return json(200, { status });
    }

    /* ---------------- Verkäufe (Admin) ---------------- */
    if (action === 'liste') {
      const a = await adminRolle(event, input.password);
      if (a.halt) return a.halt;
      if (!a.who) return json(401, { error: 'unauthorized' });
      if (a.who.role !== 'admin') return json(403, { error: 'forbidden' });
      const ps = store(bp.PASS_STORE);
      const { blobs } = await ps.list({ prefix: 'p:' });
      const liste = [];
      for (const b of blobs.slice(-300)) {
        const p = await ps.get(b.key, { type: 'json' });
        if (!p) continue;
        const abgelaufen = new Date(p.gueltigBis).getTime() <= Date.now();
        liste.push({
          id: p.id, name: p.name, kunde: p.kaeufer && (p.kaeufer.name || p.kaeufer.email), email: p.kaeufer && p.kaeufer.email,
          preis: p.preis, gesamt: p.menusGesamt, uebrig: p.menusUebrig, bis: p.gueltigBis, gekauftAm: p.gekauftAm,
          status: p.status === 'aktiv' && abgelaufen ? 'abgelaufen' : p.status, einloesungen: (p.einloesungen || []).length,
        });
      }
      liste.sort((x, y) => String(y.gekauftAm).localeCompare(String(x.gekauftAm)));
      return json(200, { ok: true, liste });
    }

    if (action !== 'kaufen') return json(400, { error: 'unknown_action' });

    /* ---------------- Kaufen ---------------- */
    const e = await einstellungen.lesen();
    if (!e.pass.aktiv) return json(403, { error: 'pass_aus', hint: 'Der Burger-Pass ist gerade nicht erhältlich.' });

    const email = normEmail(input.email);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(400, { error: 'bad_email' });
    const cs = store('customers');
    const kunde = await cs.get(bp.kundenSchluessel(email), { type: 'json' });
    // Nur angemeldete Kunden: der Pass hängt am Konto.
    if (!kunde || !tokenGueltig(kunde, input.token)) return json(401, { error: 'unauthorized' });

    const apiKey = process.env.SUMUP_API_KEY;
    const merchantCode = process.env.SUMUP_MERCHANT_CODE;
    if (!apiKey || !merchantCode) return json(500, { error: 'not_configured' });

    const siteUrl = (process.env.SITE_URL || process.env.URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');
    const reference = 'GNC-BP-' + Date.now();
    const lang = SPRACHEN.includes(input.lang) ? input.lang : 'de';
    const kundeName = String(kunde.name || '').replace(/[<>]/g, '').trim().slice(0, 60);
    const payload = {
      checkout_reference: reference,
      amount: e.pass.preis,
      currency: 'EUR',
      merchant_code: merchantCode,
      description: (`Grilln Chill ${e.pass.name} ${e.pass.menus} Menues` + (kundeName ? ` - ${kundeName}` : '')).replace(/<[^>]*>/g, '').slice(0, 100),
      return_url: `${siteUrl}/.netlify/functions/sumup-webhook`,
      redirect_url: `${siteUrl}/index.html?pass=return&ref=${encodeURIComponent(reference)}` + (input.appMode ? '&app=1' : ''),
      hosted_checkout: { enabled: true },
    };
    const res = await fetch(`${SUMUP_API_BASE}/checkouts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.id) {
      console.error('SumUp Burger-Pass:', res.status, JSON.stringify(data).slice(0, 500));
      return json(502, { error: 'sumup_error' });
    }

    // Vorgang sichern. Ausgestellt wird erst NACH bestätigter Zahlung.
    // Preis, Menüs und Laufzeit zum Kaufzeitpunkt mitschreiben: ändert der
    // Admin später die Einstellungen, gilt für diesen Kauf trotzdem das Angebot.
    await store('orders').setJSON('o:' + reference, {
      status: 'pending',
      kind: 'burgerpass',
      reference,
      createdAt: new Date().toISOString(),
      checkoutId: data.id,
      total: e.pass.preis,
      bp: { email, kundeName, name: e.pass.name, preis: e.pass.preis, menus: e.pass.menus, tage: e.pass.tage, lang },
    });
    try { await stornieren(input.supersedes, 'superseded'); } catch (err) {}

    return json(200, { id: data.id, hosted_checkout_url: data.hosted_checkout_url || null, reference });
  } catch (err) {
    console.error('burger-pass:', (err && err.message) || err);
    return json(502, { error: 'request_failed', hint: 'Da ist etwas schiefgelaufen. Bitte gleich noch einmal versuchen.' });
  }
};
