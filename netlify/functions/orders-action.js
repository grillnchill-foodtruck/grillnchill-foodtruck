/**
 * orders-action.js
 * ----------------------------------------------------------------------------
 * Admin-Aktionen für einzelne Bestellungen (Tab "Bestellungen").
 *
 *   POST { password, reference, action }
 *
 *   action = "check"    → Zahlungsstatus live bei SumUp prüfen.
 *                         PAID → Benachrichtigungen auslösen (send-email hebt
 *                         den Eintrag auf "completed"), FAILED/EXPIRED →
 *                         "abandoned". Sonst: Status unverändert zurückmelden.
 *   action = "complete" → Bestellung manuell abschließen: löst Kundenmail,
 *                         Inhaber-Mail und Telegram aus (idempotent – bereits
 *                         abgeschlossene Bestellungen werden nicht doppelt
 *                         benachrichtigt).
 *   action = "refund"   → Bestellung im Archiv als "rückerstattet" markieren
 *                         (die eigentliche Erstattung erfolgt in SumUp).
 *
 *   Antwort: { ok, status, payStatus? }
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');

const SUMUP_API_BASE = 'https://api.sumup.com/v0.1';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify(data),
});

function store() {
  const opts = { name: 'orders', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

// Geschenkgutschein ausstellen: Code erzeugen, Voucher anlegen, Käufer-Mail auslösen.
// Wird beim manuellen "Ausstellen" genutzt; der reguläre Weg läuft über den SumUp-Webhook.
async function fulfillGiftcard(rec, s, key) {
  const crypto = require('crypto');
  const vopts = { name: 'vouchers', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    vopts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    vopts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  const vs = getStore(vopts);
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    code = 'GNC';
    const buf = crypto.randomBytes(6);
    for (let i = 0; i < 6; i++) code += ALPHA[buf[i] % ALPHA.length];
    if (!(await vs.get('c:' + code, { type: 'json' }))) break;
  }
  const amount = rec.gift.amount;
  const validUntil = new Date(Date.now() + 3 * 365 * 86400000).toISOString().slice(0, 10);
  await vs.setJSON('c:' + code, {
    code, type: 'fixed', value: amount, maxDiscount: 0, minOrder: amount,
    validFrom: null, validUntil, maxUses: 1, oncePerCustomer: false,
    combinable: false, mode: 'any', active: true, giftcard: true,
    note: 'Geschenkgutschein · Käufer: ' + (rec.gift.buyerName || rec.gift.email) + (rec.gift.recipientName ? ' · Für: ' + rec.gift.recipientName : ''),
    createdAt: new Date().toISOString(), createdBy: 'Admin (manuell ausgestellt)',
    uses: 0, usedBy: {},
  });
  const siteUrl = (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');
  const res = await fetch(siteUrl + '/.netlify/functions/send-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'giftcard', gift: { ...rec.gift, code, validUntil, reference: key.slice(2) } }),
  });
  rec.status = 'completed';
  rec.completedAt = new Date().toISOString();
  rec.code = code;
  await s.setJSON(key, rec);
  await addRevenue(s, { gcCount: 1, gcTotal: (rec.gift && rec.gift.amount) || rec.total || 0 });
  return { mailOk: res.ok, code };
}

async function notify(order) {
  const siteUrl = (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');
  const res = await fetch(siteUrl + '/.netlify/functions/send-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'order_confirmation', order }),
  });
  return res.ok;
}


// --- Team-Auth: admin (ADMIN_PASSWORD) oder staff (Team-Store, siehe team.js) ---
const _teamCrypto = require('crypto');
function _teamStore() {
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
    const t = _teamStore();
    const { blobs } = await t.list({ prefix: 'u:' });
    const h = _teamCrypto.createHash('sha256').update(String(pw)).digest('hex');
    for (const b of blobs) {
      const u = await t.get(b.key, { type: 'json' });
      if (u && u.pwHash === h) return { role: u.role === 'admin' ? 'admin' : 'staff', name: u.name || b.key.slice(2) };
    }
  } catch (e) {}
  return null;
}


// --- Änderungs-Protokoll (Store: audit) – best effort, blockiert nie ---
async function auditLog(who, action, detail) {
  try {
    const opts = { name: 'audit', consistency: 'strong' };
    if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
      opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
      opts.token = process.env.NETLIFY_BLOBS_TOKEN;
    }
    const s = getStore(opts);
    const key = 'a:' + new Date().toISOString() + '_' + Math.random().toString(36).slice(2, 7);
    await s.setJSON(key, {
      at: new Date().toISOString(),
      name: (who && who.name) || '?',
      role: (who && who.role) || '?',
      action,
      detail: String(detail || '').slice(0, 300),
    });
  } catch (e) {}
}


// Tages-Umsatz-Aggregat fortschreiben (Basis der Admin-Umsatzübersicht)
async function addRevenue(s, patch) {
  try {
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const key = 'rev:' + d;
    const agg = (await s.get(key, { type: 'json' })) || {
      oCount: 0, oTotal: 0, pickupCount: 0, pickupTotal: 0,
      deliveryCount: 0, deliveryTotal: 0, gcCount: 0, gcTotal: 0,
    };
    for (const [k, v] of Object.entries(patch)) {
      agg[k] = Math.round(((agg[k] || 0) + v) * 100) / 100;
    }
    await s.setJSON(key, agg);
  } catch (e) {}
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }

  // Bremse gegen Durchprobieren – siehe lib/auth-guard.js
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;
  const who = await authRole(input.password);
  await meldeErgebnis(event, !!who);
  if (!who) return json(401, { error: 'unauthorized' });

  const reference = String(input.reference || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 60);
  const action = String(input.action || '');
  if (!reference || !['check', 'complete', 'refund', 'resend', 'cancel'].includes(action)) {
    return json(400, { error: 'bad_request', hint: 'reference und action (check|complete|refund|resend|cancel) sind Pflicht' });
  }

  const s = store();
  const key = 'o:' + reference;
  const rec = await s.get(key, { type: 'json' });
  if (!rec) return json(404, { error: 'not_found', reference });

  try {
    // ---------- Rückerstattet markieren (nur Admin) ----------
    if (action === 'refund') {
      if (who.role !== 'admin') return json(403, { error: 'forbidden', hint: 'Rückerstattungen kann nur der Admin markieren' });
      rec.status = 'refunded';
      rec.refundedAt = new Date().toISOString();
      await s.setJSON(key, rec);
      // Geschenkgutschein: zugehörigen Code deaktivieren, damit er nicht mehr einlösbar ist
      if (rec.kind === 'giftcard' && rec.code) {
        try {
          const vopts = { name: 'vouchers', consistency: 'strong' };
          if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
            vopts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
            vopts.token = process.env.NETLIFY_BLOBS_TOKEN;
          }
          const vs = getStore(vopts);
          const v = await vs.get('c:' + rec.code, { type: 'json' });
          if (v) { v.active = false; await vs.setJSON('c:' + rec.code, v); }
        } catch (e) {}
      }
      await auditLog(who, 'Bestellung', '#' + reference + (rec.kind === 'giftcard' ? ' (Gutschein-Kauf) rückerstattet – Code deaktiviert' : ' als rückerstattet markiert'));
      return json(200, { ok: true, status: 'refunded' });
    }

    // ---------- Manuell abschließen (Mails/Telegram auslösen) ----------
    if (action === 'complete') {
      if (rec.status === 'completed') return json(200, { ok: true, status: 'completed', note: 'already_completed' });
      if (rec.kind === 'giftcard') {
        if (!rec.gift) return json(409, { error: 'no_gift_data' });
        const r2 = await fulfillGiftcard(rec, s, key);
        await auditLog(who, 'Bestellung', '#' + reference + ' Gutschein manuell ausgestellt (' + r2.code + ')' + (r2.mailOk ? ' – Mail versendet' : ' – MAIL FEHLGESCHLAGEN'));
        return r2.mailOk
          ? json(200, { ok: true, status: 'completed', code: r2.code })
          : json(502, { error: 'mail_failed', code: r2.code, hint: 'Code wurde angelegt, aber die Mail schlug fehl – Code steht im Gutschein-Tab' });
      }
      if (!rec.order) return json(409, { error: 'no_order_data' });
      const ok = await notify(rec.order); // send-email setzt den Eintrag auf "completed"
      if (!ok) return json(502, { error: 'notify_failed', hint: 'send-email nicht erreichbar – bitte erneut versuchen' });
      await auditLog(who, 'Bestellung', '#' + reference + ' manuell abgeschlossen – Mails/Telegram ausgelöst');
      return json(200, { ok: true, status: 'completed' });
    }

    // ---------- Offene Bestellung stornieren (nur wenn wirklich unbezahlt) ----------
    if (action === 'cancel') {
      if (rec.status !== 'pending' && rec.status !== 'abandoned') {
        return json(409, { error: 'not_cancellable', hint: 'Nur offene/abgebrochene Vorgänge können storniert werden' });
      }
      // Sicherheitsnetz: live bei SumUp prüfen – bezahlte Bestellungen NIE stornieren
      if (rec.checkoutId) {
        try {
          const r = await fetch(`https://api.sumup.com/v0.1/checkouts/${rec.checkoutId}`, {
            headers: { Authorization: `Bearer ${process.env.SUMUP_API_KEY}` },
          });
          const d = await r.json().catch(() => null);
          if (r.ok && d && String(d.status || '').toUpperCase() === 'PAID') {
            return json(409, { error: 'is_paid', hint: 'Diese Bestellung IST bezahlt – bitte „Zahlung prüfen" nutzen' });
          }
        } catch (e) { /* SumUp nicht erreichbar → Storno trotzdem erlauben (Betreiber-Entscheidung) */ }
      }
      rec.status = 'cancelled';
      rec.cancelledAt = new Date().toISOString();
      rec.cancelledBy = who.name;
      await s.setJSON(key, rec);
      await auditLog(who, 'Bestellung', '#' + reference + (rec.kind === 'giftcard' ? ' (Gutschein-Kauf)' : '') + ' storniert (unbezahlter Vorgang)');
      return json(200, { ok: true, status: 'cancelled' });
    }

    // ---------- Gutschein-Mail erneut an den Käufer senden ----------
    if (action === 'resend') {
      if (rec.kind !== 'giftcard') return json(400, { error: 'not_a_giftcard' });
      if (rec.status !== 'completed' || !rec.code || !rec.gift) {
        return json(409, { error: 'not_issued', hint: 'Erst ausstellen – dann kann die Mail erneut gesendet werden' });
      }
      // Ablaufdatum aus dem Gutschein selbst holen (für den Mail-Text)
      let validUntil = null;
      try {
        const vopts = { name: 'vouchers', consistency: 'strong' };
        if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
          vopts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
          vopts.token = process.env.NETLIFY_BLOBS_TOKEN;
        }
        const v = await getStore(vopts).get('c:' + rec.code, { type: 'json' });
        if (v) validUntil = v.validUntil || null;
      } catch (e) {}
      const siteUrl = (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');
      const res = await fetch(siteUrl + '/.netlify/functions/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'giftcard', gift: { ...rec.gift, code: rec.code, validUntil, reference } }),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        const why = (errBody && (errBody.detail || errBody.error)) || ('HTTP ' + res.status);
        return json(502, { error: 'mail_failed', hint: 'Mailversand fehlgeschlagen: ' + String(why).slice(0, 180) });
      }
      await auditLog(who, 'Gutschein', rec.code + ' – Kauf-Mail erneut gesendet an ' + (rec.gift.email || '?'));
      return json(200, { ok: true, sentTo: rec.gift.email || null });
    }

    // ---------- Zahlung live bei SumUp prüfen ----------
    if (action === 'check') {
      if (rec.status === 'completed') return json(200, { ok: true, status: 'completed' });
      if (rec.status === 'refunded') return json(200, { ok: true, status: 'refunded' });
      const apiKey = process.env.SUMUP_API_KEY;
      if (!rec.checkoutId || !apiKey) {
        return json(200, { ok: true, status: rec.status, payStatus: 'UNKNOWN', hint: 'Keine Checkout-ID – Barzahlung oder alte Bestellung' });
      }
      const res = await fetch(`${SUMUP_API_BASE}/checkouts/${encodeURIComponent(rec.checkoutId)}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = await res.json().catch(() => null);
      const payStatus = res.ok && data ? String(data.status || '').toUpperCase() : 'UNKNOWN';

      if (payStatus === 'PAID') {
        if (rec.kind === 'giftcard') {
          const siteUrl = (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');
          const wres = await fetch(siteUrl + '/.netlify/functions/sumup-webhook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: rec.checkoutId }),
          });
          const ok2 = wres.ok;
          if (ok2) await auditLog(who, 'Bestellung', '#' + reference + ' Gutschein-Zahlung geprüft: bezahlt – Gutschein ausgestellt');
          return ok2
            ? json(200, { ok: true, status: 'completed', payStatus })
            : json(502, { error: 'fulfill_failed', payStatus });
        }
        const ok = await notify(rec.order);
        if (ok) await auditLog(who, 'Bestellung', '#' + reference + ' Zahlung geprüft: bezahlt – Benachrichtigungen ausgelöst');
        return ok
          ? json(200, { ok: true, status: 'completed', payStatus })
          : json(502, { error: 'notify_failed', payStatus });
      }
      if (payStatus === 'FAILED' || payStatus === 'EXPIRED') {
        rec.status = 'abandoned';
        rec.abandonedAt = new Date().toISOString();
        rec.payStatus = payStatus;
        await s.setJSON(key, rec);
        return json(200, { ok: true, status: 'abandoned', payStatus });
      }
      return json(200, { ok: true, status: rec.status, payStatus });
    }
  } catch (e) {
    return json(500, { error: 'action_failed', detail: String((e && e.message) || e) });
  }
};
