/**
 * voucher-check.js
 * ----------------------------------------------------------------------------
 * Prüft persönliche Gutschein-Codes (aus der Retargeting-Mail) serverseitig.
 *
 *   POST /voucher-check   Body: { code }
 *   → { valid: true, value: 3, minOrder: 15, expiresAt }
 *   → { valid: false, reason: 'not_found' | 'expired' | 'used' }
 *
 * Die Codes werden von retarget-daily.js erzeugt (Store: vouchers).
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(statusCode, data) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...CORS }, body: JSON.stringify(data) };
}

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}


// GRILL5: dauerhafter Aktionscode. Legt sich beim ersten Kontakt selbst als echter
// Gutschein an (zählt Einlösungen, im Admin steuerbar). Aktiv ab 20.07.2026.
async function ensureGrill5(vs) {
  try {
    const existing = await vs.get('c:GRILL5', { type: 'json' });
    if (existing) {
      // Migration: früher gesäter GRILL5 bekommt das Pro-Kunde-Limit nachgezogen
      if (existing.createdBy === 'System' && existing.maxPerCustomer === undefined) {
        existing.maxPerCustomer = 3;
        existing.note = 'Dauerhafter Aktionscode (5 € ab 20 €, max. 3× pro Kunde)';
        try { await vs.setJSON('c:GRILL5', existing); } catch (e) {}
      }
      return;
    }
    // Wurde GRILL5 im Admin bewusst gelöscht? Dann nicht wiederbeleben.
    const meta = await vs.get('meta:grill5', { type: 'json' });
    if (meta && meta.deleted) return;
    await vs.setJSON('c:GRILL5', {
      code: 'GRILL5', type: 'fixed', value: 5, maxDiscount: 0, minOrder: 20,
      validFrom: '2026-07-20', validUntil: null, maxUses: 0, oncePerCustomer: false, maxPerCustomer: 3,
      combinable: false, mode: 'any', active: true,
      note: 'Dauerhafter Aktionscode (5 € ab 20 €) – Nachfolger der WM-Aktion',
      createdAt: new Date().toISOString(), createdBy: 'System', uses: 0, usedBy: {},
    });
  } catch (e) {}
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let code = '', email = '', mode = '';
  try {
    const b = JSON.parse(event.body || '{}');
    code = (b.code || '').toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
    email = (b.email || '').toString().trim().toLowerCase().slice(0, 120);
    mode = (b.mode || '').toString();
  } catch (e) {}
  if (code.length < 3) return json(200, { valid: false, reason: 'not_found' });

  // ---- 1) Kampagnen-Gutschein (Admin-Tool, Prefix c:) ----
  try {
    const vs0 = store('vouchers');
    if (code === 'GRILL5') await ensureGrill5(vs0);
    const c = await vs0.get('c:' + code, { type: 'json' });
    if (c) {
      if (!c.active) return json(200, { valid: false, reason: 'not_found' });
      // Empfehlungs-Gutschein: nur für die Erstbestellung, kein Selbst-Werben
      if (c.referral && email) {
        const h0 = require('crypto').createHash('sha256').update(email).digest('hex');
        if (c.ownerKey === 'c:' + h0) return json(200, { valid: false, reason: 'ref_self' });
        try {
          const csOpts = { name: 'customers', consistency: 'strong' };
          if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
            csOpts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
            csOpts.token = process.env.NETLIFY_BLOBS_TOKEN;
          }
          const me = await getStore(csOpts).get('c:' + h0, { type: 'json' });
          if (me && (me.lastOrderAt || me.referredBy)) return json(200, { valid: false, reason: 'ref_not_first' });
        } catch (e) {}
      }
      const now = Date.now();
      // Zeitraum: Datumsangaben gelten in Europa/Berlin, Ende einschließlich
      if (c.validFrom && now < new Date(c.validFrom + 'T00:00:00+02:00').getTime() - 2 * 3600000) {
        return json(200, { valid: false, reason: 'not_started', validFrom: c.validFrom });
      }
      if (c.validUntil && now > new Date(c.validUntil + 'T23:59:59+02:00').getTime() + 2 * 3600000) {
        return json(200, { valid: false, reason: 'expired' });
      }
      if (c.maxUses > 0 && (c.uses || 0) >= c.maxUses) {
        return json(200, { valid: false, reason: 'limit_reached' });
      }
      // Pro-Kunde-Limit: maxPerCustomer (Zahl) oder Legacy-Schalter oncePerCustomer (=1)
      const perCust = c.maxPerCustomer > 0 ? c.maxPerCustomer : (c.oncePerCustomer ? 1 : 0);
      if (perCust > 0 && email) {
        const h = require('crypto').createHash('sha256').update(email).digest('hex');
        const prev = c.usedBy ? c.usedBy[h] : undefined;
        const count = typeof prev === 'number' ? prev : (prev ? 1 : 0);
        if (count >= perCust) {
          return json(200, { valid: false, reason: 'customer_limit', max: perCust });
        }
      }
      return json(200, {
        valid: true,
        kind: 'campaign',
        type: c.type,
        value: c.value,
        maxDiscount: c.maxDiscount || 0,
        minOrder: c.minOrder || 0,
        combinable: !!c.combinable,
        mode: c.mode || 'any',
        oncePerCustomer: !!c.oncePerCustomer,
        maxPerCustomer: c.maxPerCustomer > 0 ? c.maxPerCustomer : (c.oncePerCustomer ? 1 : 0),
        validUntil: c.validUntil || null,
      });
    }
  } catch (e) { /* weiter zum persönlichen Gutschein */ }

  // ---- 2) Persönlicher Retargeting-Gutschein (Prefix v:) ----
  if (!/^[A-Z2-9]{8}$/.test(code)) return json(200, { valid: false, reason: 'not_found' });

  try {
    const v = await store('vouchers').get('v:' + code, { type: 'json' });
    if (!v) return json(200, { valid: false, reason: 'not_found' });
    if (v.used) return json(200, { valid: false, reason: 'used' });
    if (v.expiresAt && Date.now() > new Date(v.expiresAt).getTime()) {
      return json(200, { valid: false, reason: 'expired' });
    }
    return json(200, { valid: true, kind: 'personal', type: 'fixed', value: v.value || 3, minOrder: v.minOrder || 15, expiresAt: v.expiresAt });
  } catch (e) {
    // Fail-closed: Bei Störungen keinen Rabatt gewähren
    // ---- 2) Persönlicher Empfehlungs-Code (Freunde werben Freunde) ----
  // 5 € Rabatt auf die ERSTE Bestellung des Geworbenen (ab 15 € Bestellwert).
  if (/^GRILL[A-Z0-9]{5}$/.test(code) && code !== 'GRILL5') {
    try {
      const cs = (() => {
        const opts = { name: 'customers', consistency: 'strong' };
        if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
          opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
          opts.token = process.env.NETLIFY_BLOBS_TOKEN;
        }
        return getStore(opts);
      })();
      const refIdx = await cs.get('ref:' + code, { type: 'json' });
      if (refIdx && refIdx.key) {
        if (email) {
          const h = require('crypto').createHash('sha256').update(email).digest('hex');
          if ('c:' + h === refIdx.key) return json(200, { valid: false, reason: 'ref_self' });
          const me = await cs.get('c:' + h, { type: 'json' });
          if (me && (me.lastOrderAt || me.referredBy)) return json(200, { valid: false, reason: 'ref_not_first' });
        }
        return json(200, {
          valid: true, kind: 'referral', code,
          type: 'fixed', value: 5, maxDiscount: 0, minOrder: 15,
          combinable: false, mode: 'any',
        });
      }
    } catch (e) {}
  }

  return json(200, { valid: false, reason: 'not_found' });
  }
};
