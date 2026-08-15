/**
 * account.js
 * ----------------------------------------------------------------------------
 * Kundenkonten – passwortlos per E-Mail-Code (6-stellig, 10 Min gültig).
 *
 *   POST { action, ... }
 *     request_code { email }                  → Code per Mail (Brevo)
 *     verify       { email, code, localLoyalty? } → { token, profile }
 *     get          { email, token }           → { profile }
 *     save         { email, token, name?, phone?, addresses? } → { profile }
 *     logout       { email, token }           → { ok }
 *
 * Store 'customers', Key c:<sha256(email)>:
 *   { email, name, phone, addresses[≤3], spent, rewards, merged,
 *     tokens{tok:ts, ≤5}, login{codeHash,exp,tries}, createdAt, lastOrderAt }
 *
 * Die Stempelkarte (spent/rewards) wird serverseitig in send-email.js bei jeder
 * abgeschlossenen Bestellung fortgeschrieben – auch OHNE Konto (Skeleton-Datensatz),
 * damit Gäste beim ersten Login ihr bereits gesammeltes Guthaben vorfinden.
 * Regeln identisch zum Client: 100 € Umsatz → 5 € Bonus (10 Stempel à 10 €).
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const LOYALTY_GOAL = 100;
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_RESEND_MS = 60 * 1000;
const MAX_TRIES = 5;
const MAX_TOKENS = 5;
// Erstes Eintragen frei, danach genau EINE Korrektur fuer Tippfehler –
// wer nichts aendert, bleibt beim Eingetragenen. Danach ist das Feld
// gesperrt; korrigieren kann dann nur noch das Team beim Scannen.
const BIRTHDAY_MAX_CHANGES = 1;
const MAX_ADDRESSES = 3;

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

function vouchersStore() {
  const opts = { name: 'vouchers', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}
async function ensureReferralVoucher(rec, key) {
  // Empfehlungs-Code als echter Gutschein-Eintrag: läuft über den bewährten
  // Gutschein-Pfad, ist im Admin sichtbar (mit Zähler) und trägt die Zusatzregeln
  // (nur Erstbestellung, kein Selbst-Werben) als Flags.
  if (!rec.refCode) return;
  try {
    const vs = vouchersStore();
    const vkey = 'c:' + rec.refCode;
    const existing = await vs.get(vkey, { type: 'json' });
    if (existing) {
      // Selbstheilung: früher angelegte Codes bekommen die Konto-Zuordnung nachgezogen
      if (!existing.ownerEmail || (rec.name && existing.ownerName !== rec.name)) {
        existing.ownerEmail = rec.email;
        existing.ownerName = rec.name || '';
        try { await vs.setJSON(vkey, existing); } catch (e) {}
      }
      return;
    }
    await vs.setJSON(vkey, {
      code: rec.refCode, type: 'fixed', value: 5, maxDiscount: 0, minOrder: 15,
      validFrom: null, validUntil: null, maxUses: 0, oncePerCustomer: false,
      maxPerCustomer: 1, combinable: false, mode: 'any', active: true,
      referral: true, ownerKey: key, ownerEmail: rec.email, ownerName: rec.name || '',
      note: 'Persönlicher Empfehlungs-Code (Kundenkonto)',
      createdAt: new Date().toISOString(), createdBy: 'System', uses: 0, usedBy: {},
    });
  } catch (e) {}
}

function store() {
  const opts = { name: 'customers', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
const normEmail = (e) => String(e || '').trim().toLowerCase().slice(0, 120);
const validEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const clean = (x, n) => String(x || '').replace(/[<>]/g, '').trim().slice(0, n);

const LEVEL_NAMES = ['Grill Rookie', 'Bun Boss', 'Patty Pro', 'Sauce Sensei', 'Cheese Melter', 'Flame Rider', 'Ember Elite', 'Grill Guru', 'Street Legende', 'King of Chill'];
function custLevel(rec) {
  const lv = Math.min(10, 1 + (rec.cards || 0));
  return { level: lv, levelName: LEVEL_NAMES[lv - 1] };
}
function publicProfile(rec) {
  return {
    email: rec.email,
    name: rec.name || '',
    phone: rec.phone || '',
    birthday: rec.birthday || '',
    // Sagt dem Konto, ob das Feld noch bearbeitet werden darf
    business: rec.business || { isBusiness: false, company: '', street: '', zip: '', city: '' },
    birthdayLocked: !!(rec.birthday && Number(rec.birthdayChanges || 0) >= BIRTHDAY_MAX_CHANGES),
    birthdayChangesLeft: rec.birthday
      ? Math.max(0, BIRTHDAY_MAX_CHANGES - Number(rec.birthdayChanges || 0)) : BIRTHDAY_MAX_CHANGES,
    refCode: rec.refCode || '',
    qrToken: rec.qrToken || '',
    ...custLevel(rec),
    referrals: rec.referrals || 0,
    orders: (rec.orders || []).slice(0, 5),
    addresses: rec.addresses || [],
    loyalty: {
      spent: Math.round((rec.spent || 0) * 100) / 100,
      rewards: rec.rewards || 0,
      goal: LOYALTY_GOAL,
      reward: 5,
      stamps: 10,
    },
  };
}

async function sendCodeMail(email, code) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || 'Grilln Chill';
  if (!apiKey || !senderEmail) throw new Error('mail_not_configured');
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;background:#0F0D0A;border-radius:14px;overflow:hidden;">
    <div style="background:#CC4715;padding:20px 26px;">
      <div style="font-size:19px;font-weight:800;color:#fff;">GRILL'N CHILL</div>
      <div style="font-size:12px;color:#FFD9C4;letter-spacing:1px;">DEIN ANMELDE-CODE</div>
    </div>
    <div style="padding:26px;background:#fff;text-align:center;">
      <p style="margin:0 0 14px;color:#333;">Dein Code für die Anmeldung – 10 Minuten gültig:</p>
      <div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#CC4715;font-family:Consolas,Menlo,monospace;padding:14px 0;background:#FFF8F4;border-radius:10px;border:2px dashed #CC4715;">${code}</div>
      <p style="margin:16px 0 0;color:#888;font-size:12px;">Nicht angefordert? Dann kannst du diese Mail einfach ignorieren.</p>
    </div>
  </div>`;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { email: senderEmail, name: senderName },
      to: [{ email }],
      subject: `${code} ist dein Grill'n Chill Anmelde-Code`,
      htmlContent: html,
    }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => null);
    throw new Error('brevo_' + res.status + (d && d.message ? ': ' + d.message : ''));
  }
}

function checkToken(rec, token) {
  return !!(rec && rec.tokens && token && rec.tokens[token]);
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }
  const action = String(input.action || '');
  const email = normEmail(input.email);
  if (!validEmail(email)) return json(400, { error: 'bad_email' });

  const s = store();
  const key = 'c:' + sha(email);

  try {
    if (action === 'request_code') {
      let rec = (await s.get(key, { type: 'json' })) || {
        email, name: '', phone: '', addresses: [], spent: 0, rewards: 0,
        tokens: {}, createdAt: new Date().toISOString(),
      };
      rec.email = email; // Skeleton-Datensätze (nur Treue) bekommen hier die Mail
      if (rec.login && rec.login.sentAt && Date.now() - rec.login.sentAt < CODE_RESEND_MS) {
        return json(429, { error: 'too_soon', hint: 'Bitte warte kurz – der Code wurde gerade erst gesendet.' });
      }
      const code = String(crypto.randomInt(100000, 1000000));
      rec.login = { codeHash: sha(code + '|' + email), exp: Date.now() + CODE_TTL_MS, tries: 0, sentAt: Date.now() };
      await s.setJSON(key, rec);
      await sendCodeMail(email, code);
      return json(200, { ok: true, sent: true });
    }

    const rec = await s.get(key, { type: 'json' });

    if (action === 'verify') {
      const code = String(input.code || '').replace(/\D/g, '').slice(0, 6);
      if (!rec || !rec.login) return json(401, { error: 'no_code', hint: 'Bitte zuerst einen Code anfordern.' });
      if (Date.now() > rec.login.exp) return json(401, { error: 'code_expired' });
      if (rec.login.tries >= MAX_TRIES) return json(429, { error: 'too_many_tries' });
      if (sha(code + '|' + email) !== rec.login.codeHash) {
        rec.login.tries = (rec.login.tries || 0) + 1;
        await s.setJSON(key, rec);
        return json(401, { error: 'wrong_code', triesLeft: MAX_TRIES - rec.login.tries });
      }
      delete rec.login;
      // Einmalige Übernahme der lokalen Stempelkarte (Browser-Guthaben mitnehmen)
      if (!rec.merged && input.localLoyalty && typeof input.localLoyalty === 'object') {
        const ls = Math.max(0, Math.min(500, parseFloat(input.localLoyalty.spent) || 0));
        const lr = Math.max(0, Math.min(10, parseInt(input.localLoyalty.rewards, 10) || 0));
        rec.spent = (rec.spent || 0) + ls;
        rec.rewards = (rec.rewards || 0) + lr;
        while (rec.spent >= LOYALTY_GOAL) { rec.rewards += 1; rec.spent -= LOYALTY_GOAL; }
        rec.merged = true;
      }
      const token = crypto.randomBytes(24).toString('hex');
      rec.tokens = rec.tokens || {};
      const toks = Object.entries(rec.tokens).sort((a, b) => new Date(a[1]) - new Date(b[1]));
      while (toks.length >= MAX_TOKENS) { delete rec.tokens[toks.shift()[0]]; }
      rec.tokens[token] = new Date().toISOString();
      await s.setJSON(key, rec);
      return json(200, { ok: true, token, profile: publicProfile(rec) });
    }

    // Ab hier: Token-geschützt
    if (!checkToken(rec, input.token)) return json(401, { error: 'unauthorized' });

    if (action === 'get') {
      if (!rec.qrToken) {
        // Kundenkarten-Token (einmalig, zufällig) + Rückwärts-Index für den Scan
        for (let i = 0; i < 5 && !rec.qrToken; i++) {
          const cand = crypto.randomBytes(9).toString('hex');
          const taken = await s.get('qr:' + cand, { type: 'json' });
          if (!taken) { rec.qrToken = cand; await s.setJSON('qr:' + cand, { key }); }
        }
        await s.setJSON(key, rec);
      }
      if (!rec.refCode) {
        // Persönlichen Empfehlungs-Code anlegen (einmalig) + Rückwärts-Index für die Einlösung
        for (let i = 0; i < 5 && !rec.refCode; i++) {
          const cand = 'GRILL' + crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 5);
          const taken = await s.get('ref:' + cand, { type: 'json' });
          if (!taken) {
            rec.refCode = cand;
            await s.setJSON('ref:' + cand, { key });
          }
        }
        await s.setJSON(key, rec);
      }
      await ensureReferralVoucher(rec, key); // legt fehlende Gutschein-Einträge nach (auch Migration)
      return json(200, { ok: true, profile: publicProfile(rec) });
    }

    if (action === 'save') {
      if (input.name !== undefined) rec.name = clean(input.name, 60);
      if (input.phone !== undefined) rec.phone = clean(input.phone, 30);
      /* Geburtstag: einmal eintragen, eine Korrektur fuer Tippfehler, danach
         gesperrt. Die Sperre steht hier im Server – im Browser waere sie in
         zehn Sekunden umgangen. Das Team kann den Tag beim Scannen der
         Kundenkarte weiterhin aendern (loyalty-scan).
         Zur Einordnung: Der Geburtstagsbonus hat ohnehin eine Jahressperre
         (lastBirthdayGiftYear), es gibt also hoechstens 5 EUR im Kalenderjahr.
         Die Sperre verhindert vor allem, dass jemand den Zeitpunkt frei
         waehlt. */
      if (input.birthday !== undefined) {
        const b = String(input.birthday || '').trim();
        const bisher = rec.birthday || '';
        const aenderungen = Number(rec.birthdayChanges || 0);
        const neu = (() => {
          if (b === '') return '';
          const m = b.match(/^(\d{1,2})\.(\d{1,2})\.?$/);
          if (!m) return null;                       // unlesbar -> ignorieren
          const dd = Math.min(31, Math.max(1, parseInt(m[1], 10)));
          const mm = Math.min(12, Math.max(1, parseInt(m[2], 10)));
          return String(dd).padStart(2, '0') + '.' + String(mm).padStart(2, '0') + '.';
        })();
        if (neu !== null && neu !== bisher) {
          if (bisher && aenderungen >= BIRTHDAY_MAX_CHANGES) {
            return json(403, { error: 'birthday_locked',
              hint: 'Der Geburtstag kann nicht mehr geändert werden. Das Team am Truck kann ihn korrigieren.' });
          }
          rec.birthday = neu;
          // Nur echte Aenderungen zaehlen, das erste Eintragen nicht
          if (bisher) rec.birthdayChanges = aenderungen + 1;
        }
      }
      /* Firmendaten. Nur wer sich ausdruecklich als Firmenkunde markiert,
         bekommt die Felder ueberhaupt zu sehen – deshalb steuert das Kennzeichen
         alles Weitere. Wird es abgewaehlt, bleiben die Daten stehen (falls
         jemand versehentlich klickt), werden aber nicht mehr verwendet. */
      if (input.business !== undefined && input.business !== null) {
        const b = input.business || {};
        rec.business = {
          isBusiness: !!b.isBusiness,
          company: clean(b.company, 80),
          street: clean(b.street, 80),
          zip: clean(b.zip, 10),
          city: clean(b.city, 40),
        };
      }
      if (Array.isArray(input.addresses)) {
        rec.addresses = input.addresses.slice(0, MAX_ADDRESSES).map(a => ({
          label: clean(a.label, 24) || 'Adresse',
          // Voreingestellte Namen werden als Schluessel gespeichert, damit sie
          // in jeder Sprache richtig erscheinen. Frei getippte Namen bleiben
          // als Text stehen (labelKey ist dann leer).
          labelKey: (a.labelKey === 'home' || a.labelKey === 'work') ? a.labelKey : '',
          street: clean(a.street, 80),
          zip: clean(a.zip, 10),
          city: clean(a.city, 40),
        })).filter(a => a.street && a.zip);
      }
      await s.setJSON(key, rec);
      return json(200, { ok: true, profile: publicProfile(rec) });
    }

    if (action === 'delete') {
      // Selbstlöschung: Konto samt Empfehlungs-Index vollständig entfernen
      try { if (rec.refCode) await s.delete('ref:' + rec.refCode); } catch (e) {}
      try { if (rec.qrToken) await s.delete('qr:' + rec.qrToken); } catch (e) {}
      try { if (rec.refCode) await vouchersStore().delete('c:' + rec.refCode); } catch (e) {}
      await s.delete(key);
      return json(200, { ok: true, deleted: true });
    }

    if (action === 'logout') {
      delete rec.tokens[input.token];
      await s.setJSON(key, rec);
      return json(200, { ok: true });
    }
  } catch (e) {
    return json(502, { error: 'account_failed', detail: String((e && e.message) || e) });
  }
  return json(400, { error: 'unknown_action' });
};
