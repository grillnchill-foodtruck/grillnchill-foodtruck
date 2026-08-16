/**
 * vouchers-admin.js
 * ----------------------------------------------------------------------------
 * Gutschein-Verwaltung fürs Admin-Tool (Tab "Gutscheine") – nur Admins.
 *
 *   POST { password, action, ... }
 *     list                     → { vouchers: [...] }
 *     create { voucher }       → legt Kampagnen-Gutschein an (Store-Key c:<CODE>)
 *     toggle { code }          → aktiv <-> pausiert
 *     delete { code }          → löscht den Gutschein
 *
 * Kampagnen-Gutscheine (Prefix c:) leben im selben Store wie die persönlichen
 * Retargeting-Gutscheine (Prefix v:), stören sich aber nicht. Geprüft werden
 * beide von voucher-check.js; entwertet/gezählt wird in send-email.js.
 *
 * Felder je Gutschein:
 *   code            3–20 Zeichen A–Z/0–9
 *   type            'fixed' (€) | 'percent' (%)
 *   value           Betrag in € bzw. Prozent (1–100)
 *   maxDiscount     nur bei percent: Rabatt-Deckel in € (0 = kein Deckel)
 *   minOrder        Mindestbestellwert (Warenwert) in €
 *   validFrom/To    Gültigkeitszeitraum (Datum, Ende einschließlich 23:59 Berlin)
 *   maxUses         Einlösungen gesamt (0 = unbegrenzt)
 *   oncePerCustomer 1× pro Kunde (per E-Mail, als Hash gespeichert)
 *   combinable      mit Aktionscode/Treuebonus kombinierbar
 *   mode            'any' | 'pickup' | 'delivery'
 *   active          Schalter, ohne Löschen deaktivierbar
 *   note            interne Notiz (Zweck/Kampagne)
 *   uses/usedBy     Zähler + (bei oncePerCustomer) E-Mail-Hashes
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung } = require('./lib/admin-sitzung');

/* Reservierte Codes: die Aktion und der Code für Testbestellungen. Letzterer
   kommt aus TEST_ORDER_CODE – stünde er hier fest, liesse sich nach einer
   Änderung der Variable ein Gutschein mit genau diesem Namen anlegen, der die
   1-€-Regel überschreibt.
   TESTGNC1 bleibt gesperrt, obwohl der Code nichts mehr bewirkt: Er stand
   lange im öffentlichen Seitenquelltext, und ein Gutschein unter genau diesem
   Namen würde von den falschen Leuten gefunden. */
const RESERVED = ['WM', 'TESTGNC1',
  String(process.env.TEST_ORDER_CODE || '').trim().toUpperCase()].filter(Boolean);

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

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

async function authAdmin(pw) {
  if (!pw) return null;
  const admin = process.env.ADMIN_PASSWORD || '';
  if (admin && pw === admin) return { role: 'superadmin', name: 'Kubi' };
  try {
    const t = store('team');
    const { blobs } = await t.list({ prefix: 'u:' });
    const h = crypto.createHash('sha256').update(String(pw)).digest('hex');
    for (const b of blobs) {
      const u = await t.get(b.key, { type: 'json' });
      if (u && u.pwHash === h) return u.role === 'admin' ? { role: 'admin', name: u.name || '?' } : null;
    }
  } catch (e) {}
  return null;
}

async function auditLog(who, action, detail) {
  try {
    const s = store('audit');
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

/* Umlaute sind erlaubt. Wichtig: Schreiben (vouchers-admin) und Prüfen
   (voucher-check) müssen identisch normalisieren, sonst ist ein angelegter
   Code nicht einlösbar. toUpperCase() macht aus "ß" von sich aus "SS" –
   das ist in beiden Richtungen gleich und daher unproblematisch.
   Türkische Buchstaben Ş, Ğ und Ç sind zugelassen; die i-Familie (ı, i, İ)
   bewusst NICHT, weil ihre Großschreibung je nach Locale abweicht und ein
   Code dann nicht mehr zuverlässig gefunden würde. */
const cleanCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9ÄÖÜŞĞÇ]/g, '').slice(0, 20);

function describe(v) {
  const val = v.type === 'percent' ? v.value + ' %' : v.value.toFixed(2).replace('.', ',') + ' €';
  return v.code + ' (' + val + (v.minOrder ? ', ab ' + v.minOrder + ' €' : '') + ')';
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

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }

  // Bremse gegen Durchprobieren – siehe lib/auth-guard.js
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;
  const who = await authAdmin(await passwortAusSitzung(input.password));
  await meldeErgebnis(event, !!who);
  if (!who) return json(401, { error: 'unauthorized' });

  const s = store('vouchers');
  const action = String(input.action || 'list');

  try {
    if (action === 'list') {
      await ensureGrill5(s);
      const { blobs } = await s.list({ prefix: 'c:' });
      const out = [];
      for (const b of blobs) {
        const v = await s.get(b.key, { type: 'json' });
        if (!v) continue;
        const { usedBy, ...rest } = v; // Hashes bleiben serverseitig
        rest.uniqueCustomers = usedBy ? Object.keys(usedBy).length : 0;
        out.push(rest);
      }
      out.sort((a, b2) => new Date(b2.createdAt || 0) - new Date(a.createdAt || 0));

      // Fest im Shop hinterlegte Aktionen zur Übersicht mit anzeigen (read-only).
      // WM: gestaffelter Aktionscode im Shop-Code (index.html), läuft automatisch aus.
      // GRILL5: frühere Aktion, archiviert. Verschwindet aus der Anzeige, sobald
      // ein echter Gutschein mit gleichem Code angelegt wird.
      const system = [];
      system.push({
        code: 'WM',
        system: true,
        type: 'percent',
        valueLabel: '10–20 % gestaffelt (10 % ab 20 €, 15 % ab 50 €, 20 % ab 100 €)',
        minOrder: 20,
        active: Date.now() < new Date('2026-07-21T00:00:00+02:00').getTime(),
        validUntil: '2026-07-20',
        combinable: false,
        note: 'WM-Aktion – fest im Shop hinterlegt, endet automatisch am 20.07.2026',
      });
      // Gekaufte Geschenkgutscheine (Kauf-Vorgänge aus dem Bestell-Store)
      const purchases = [];
      try {
        const os2 = (() => {
          const o = { name: 'orders', consistency: 'strong' };
          if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
            o.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
            o.token = process.env.NETLIFY_BLOBS_TOKEN;
          }
          return getStore(o);
        })();
        const { blobs: ob } = await os2.list({ prefix: 'o:GNC-GC-' });
        for (const b2 of ob) {
          const rec = await os2.get(b2.key, { type: 'json' });
          if (!rec || rec.kind !== 'giftcard') continue;
        if (rec.status === 'cancelled') continue; // Rückzieher/Storno: unsichtbar (Webhook-Sicherheitsnetz bleibt)
          const entry = {
            reference: b2.key.slice(2),
            status: rec.status || 'pending',
            createdAt: rec.createdAt || null,
            completedAt: rec.completedAt || null,
            gift: rec.gift || {},
            code: rec.code || null,
          };
          // Gutschein-Zustand dazuladen: Ablauf + Einlöse-Status (Checkout oder manuell)
          if (entry.code) {
            try {
              const v2 = await s.get('c:' + entry.code, { type: 'json' });
              if (v2) {
                entry.validUntil = v2.validUntil || null;
                entry.voucherActive = !!v2.active;
                entry.redeemed = (v2.uses || 0) >= (v2.maxUses || 1);
                entry.redeemedVia = v2.redeemedVia || (entry.redeemed ? 'checkout' : null);
                entry.redeemedAt = v2.manualRedeemedAt || v2.lastRedeemedAt || null;
              }
            } catch (e) {}
          }
          purchases.push(entry);
        }
        purchases.sort((a, b3) => new Date(b3.createdAt || 0) - new Date(a.createdAt || 0));
      } catch (e) {}
      return json(200, { ok: true, vouchers: [...system, ...out], purchases: purchases.slice(0, 100) });
    }

    if (action === 'create') {
      const inV = input.voucher || {};
      const code = cleanCode(inV.code);
      if (code.length < 3) return json(400, { error: 'bad_code', hint: 'Code: 3–20 Zeichen, nur A–Z und 0–9' });
      if (RESERVED.includes(code)) return json(409, { error: 'reserved', hint: 'Dieser Code ist für Aktionen reserviert' });
      if (await s.get('c:' + code, { type: 'json' })) return json(409, { error: 'exists', hint: 'Code existiert bereits' });
      if (/^[A-Z2-9]{8}$/.test(code) && await s.get('v:' + code, { type: 'json' })) {
        return json(409, { error: 'exists', hint: 'Kollidiert mit einem persönlichen Gutschein' });
      }

      const type = inV.type === 'percent' ? 'percent' : 'fixed';
      const value = Math.round((parseFloat(inV.value) || 0) * 100) / 100;
      if (type === 'percent' && (value < 1 || value > 100)) return json(400, { error: 'bad_value', hint: 'Prozent: 1–100' });
      if (type === 'fixed' && (value < 0.5 || value > 200)) return json(400, { error: 'bad_value', hint: 'Betrag: 0,50–200 €' });

      const v = {
        code,
        type,
        value,
        maxDiscount: type === 'percent' ? Math.max(0, Math.round((parseFloat(inV.maxDiscount) || 0) * 100) / 100) : 0,
        minOrder: Math.max(0, Math.round((parseFloat(inV.minOrder) || 0) * 100) / 100),
        validFrom: inV.validFrom ? String(inV.validFrom).slice(0, 10) : null,
        validUntil: inV.validUntil ? String(inV.validUntil).slice(0, 10) : null,
        maxUses: Math.max(0, parseInt(inV.maxUses, 10) || 0),
        oncePerCustomer: !!inV.oncePerCustomer,
        maxPerCustomer: Math.min(50, Math.max(0, parseInt(inV.maxPerCustomer, 10) || 0)),
        combinable: !!inV.combinable,
        mode: ['pickup', 'delivery'].includes(inV.mode) ? inV.mode : 'any',
        active: true,
        note: String(inV.note || '').slice(0, 120),
        createdAt: new Date().toISOString(),
        createdBy: who.name,
        uses: 0,
        usedBy: {},
      };
      if (v.validFrom && v.validUntil && v.validFrom > v.validUntil) {
        return json(400, { error: 'bad_dates', hint: '„Gültig bis" liegt vor „Gültig ab"' });
      }
      await s.setJSON('c:' + code, v);
      if (code === 'GRILL5') {
        try { await s.delete('meta:grill5'); } catch (e) {}
      }
      await auditLog(who, 'Gutschein', 'Angelegt: ' + describe(v) + (v.note ? ' – ' + v.note : ''));
      return json(200, { ok: true, code });
    }

    // Manuell als eingelöst markieren / Einlösung zurücknehmen (z. B. Einlösung am Truck)
    if (action === 'markUsed' || action === 'markUnused') {
      const code = cleanCode(input.code);
      const key = 'c:' + code;
      const v = await s.get(key, { type: 'json' });
      if (!v) return json(404, { error: 'not_found' });
      if (action === 'markUsed') {
        v.uses = v.maxUses > 0 ? v.maxUses : (v.uses || 0) + 1;
        v.manualRedeemedAt = new Date().toISOString();
        v.redeemedVia = 'manual';
        await s.setJSON(key, v);
        await auditLog(who, 'Gutschein', code + ' manuell als eingelöst markiert');
        return json(200, { ok: true, redeemed: true });
      }
      v.uses = 0;
      delete v.manualRedeemedAt;
      delete v.lastRedeemedAt;
      delete v.redeemedVia;
      await s.setJSON(key, v);
      await auditLog(who, 'Gutschein', code + ' Einlösung zurückgenommen (wieder einlösbar)');
      return json(200, { ok: true, redeemed: false });
    }

    if (action === 'toggle' || action === 'delete') {
      const code = cleanCode(input.code);
      const key = 'c:' + code;
      const v = await s.get(key, { type: 'json' });
      if (!v) return json(404, { error: 'not_found' });
      if (action === 'toggle') {
        v.active = !v.active;
        await s.setJSON(key, v);
        await auditLog(who, 'Gutschein', (v.active ? 'Aktiviert: ' : 'Pausiert: ') + code);
        return json(200, { ok: true, active: v.active });
      }
      await s.delete(key);
      if (code === 'GRILL5') {
        try { await s.setJSON('meta:grill5', { deleted: true, at: new Date().toISOString(), by: who.name }); } catch (e) {}
      }
      await auditLog(who, 'Gutschein', 'Gelöscht: ' + code + ' (nach ' + (v.uses || 0) + ' Einlösungen)');
      return json(200, { ok: true });
    }
  } catch (e) {
    return json(500, { error: 'voucher_failed', detail: String((e && e.message) || e) });
  }
  return json(400, { error: 'unknown_action' });
};
