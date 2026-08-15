/**
 * loyalty-scan.js
 * ----------------------------------------------------------------------------
 * Kundenkarten-Scan am Truck (alle Team-Rollen).
 *
 *   POST { password, action:'lookup', token }           → Karte anzeigen
 *   POST { password, action:'credit', token, amount }   → Vor-Ort-Umsatz gutschreiben
 *   POST { password, action:'redeem', token }           → 1 Treuebonus (5 €) einlösen
 *
 * Punkte-Logik identisch zur Online-Stempelkarte (send-email-Accrual):
 * je volle 100 € Umsatz → 1 Bonus; 'spent' trägt den Rest weiter.
 * Jede Aktion landet namentlich im Audit-Log.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

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

async function authRole(pw) {
  if (!pw) return null;
  const admin = process.env.ADMIN_PASSWORD || '';
  if (admin && pw === admin) return { role: 'admin', name: 'Kubi' };
  try {
    const t = store('team');
    const { blobs } = await t.list({ prefix: 'u:' });
    const h = crypto.createHash('sha256').update(String(pw)).digest('hex');
    for (const b of blobs) {
      const u = await t.get(b.key, { type: 'json' });
      if (u && u.pwHash === h) return { role: u.role === 'admin' ? 'admin' : 'staff', name: u.name || b.key.slice(2) };
    }
  } catch (e) {}
  return null;
}

async function auditLog(who, text) {
  try {
    const a = store('audit');
    const key = 'a:' + new Date().toISOString() + '_' + Math.random().toString(36).slice(2, 7);
    // Feldnamen wie in den übrigen Functions – das Admin-Tool liest name/action/detail
    await a.setJSON(key, {
      at: new Date().toISOString(),
      name: (who && who.name) || '?',
      role: (who && who.role) || '?',
      action: 'Kundenkarte',
      detail: String(text || '').slice(0, 300),
    });
  } catch (e) {}
}

const LEVEL_NAMES = ['Grill Rookie', 'Bun Boss', 'Patty Pro', 'Sauce Sensei', 'Cheese Melter', 'Flame Rider', 'Ember Elite', 'Grill Guru', 'Street Legende', 'King of Chill'];
function custLevel(rec) {
  const lv = Math.min(10, 1 + (rec.cards || 0));
  return { level: lv, levelName: LEVEL_NAMES[lv - 1] };
}
function cardView(rec) {
  return {
    name: rec.name || '',
    emailMasked: (function (e) {
      if (!e) return '';
      const at = e.indexOf('@');
      if (at < 1) return '…';
      return e.slice(0, Math.min(2, at)) + '…' + e.slice(at);
    })(rec.email),
    spent: Math.round((rec.spent || 0) * 100) / 100,
    rewards: rec.rewards || 0,
    birthday: rec.birthday || '',   // damit das Team den aktuellen Tag sieht
    toNext: Math.max(0, Math.round((100 - (rec.spent || 0)) * 100) / 100),
    ...custLevel(rec),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }

  const who = await authRole(input.password);
  if (!who) return json(401, { error: 'unauthorized' });

  const token = String(input.token || '').replace(/[^a-f0-9]/g, '').slice(0, 40);
  if (token.length < 12) return json(400, { error: 'bad_token' });

  const s = store('customers');
  const idx = await s.get('qr:' + token, { type: 'json' });
  if (!idx || !idx.key) return json(404, { error: 'not_found' });
  const rec = await s.get(idx.key, { type: 'json' });
  if (!rec) return json(404, { error: 'not_found' });

  if (input.action === 'lookup') {
    return json(200, { ok: true, card: cardView(rec) });
  }

  if (input.action === 'credit') {
    const amount = Math.round(Number(input.amount) * 100) / 100;
    if (!isFinite(amount) || amount < 0.5 || amount > 500) {
      return json(400, { error: 'bad_amount', hint: 'Betrag zwischen 0,50 € und 500 €' });
    }
    rec.spent = Math.round(((rec.spent || 0) + amount) * 100) / 100;
    let earned = 0;
    let levelUpTo = 0;
    while (rec.spent >= 100) {
      rec.rewards = (rec.rewards || 0) + 1;
      rec.cards = (rec.cards || 0) + 1;
      if (rec.cards >= 5) { rec.rewards += 1; earned++; } // ab Level 6: Doppel-Bonus (10 €/Karte)
      levelUpTo = Math.min(10, 1 + rec.cards);
      rec.spent = Math.round((rec.spent - 100) * 100) / 100;
      earned++;
    }
    if (levelUpTo >= 6) {
      try {
        const tgToken = process.env.TELEGRAM_BOT_TOKEN, tgChat = process.env.TELEGRAM_CHAT_ID;
        if (tgToken && tgChat) {
          const crown = levelUpTo >= 10 ? '\u{1F451} ' : '\u{1F3C6} ';
          await fetch('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: tgChat, text: crown + (rec.name || rec.email) + ' ist jetzt Level ' + levelUpTo + ' \u00b7 ' + LEVEL_NAMES[levelUpTo - 1] + ' (vor Ort gescannt)!' + (levelUpTo >= 10 ? ' Zeit f\u00fcr die Kr\u00f6nung!' : '') }),
          });
        }
      } catch (e) {}
    }
    rec.lastOrderAt = rec.lastOrderAt || new Date().toISOString();
    await s.setJSON(idx.key, rec);
    await auditLog(who, 'Vor-Ort-Umsatz ' + amount.toFixed(2) + ' € für ' + (rec.email || '?') + (earned ? ' (+' + earned + ' Bonus)' : ''));
    return json(200, { ok: true, earned, card: cardView(rec) });
  }

  // Guthaben direkt korrigieren: Boni (je 5 €) und/oder Kartenstand setzen.
  // Nur für Admins – Personal soll Umsätze buchen, nicht Guthaben frei ändern.
  if (input.action === 'adjust') {
    if (who.role !== 'admin') return json(403, { error: 'forbidden', hint: 'Nur Admins dürfen Guthaben ändern' });
    const before = { rewards: rec.rewards || 0, spent: Math.round((rec.spent || 0) * 100) / 100 };
    const parts = [];

    if (input.rewards !== undefined && input.rewards !== null && input.rewards !== '') {
      const rw = Math.round(Number(input.rewards));
      if (!isFinite(rw) || rw < 0 || rw > 100) {
        return json(400, { error: 'bad_rewards', hint: 'Boni zwischen 0 und 100' });
      }
      rec.rewards = rw;
      if (rw !== before.rewards) parts.push('Boni ' + before.rewards + ' → ' + rw);
    }
    if (input.spent !== undefined && input.spent !== null && input.spent !== '') {
      const sp = Math.round(Number(input.spent) * 100) / 100;
      if (!isFinite(sp) || sp < 0 || sp > 99.99) {
        return json(400, { error: 'bad_spent', hint: 'Kartenstand zwischen 0 € und 99,99 €' });
      }
      rec.spent = sp;
      if (sp !== before.spent) parts.push('Kartenstand ' + before.spent.toFixed(2) + ' € → ' + sp.toFixed(2) + ' €');
    }
    // Geburtstag korrigieren. Kunden duerfen ihn nur einmal aendern, damit
    // sich niemand den Zeitpunkt des Bonus aussucht; das Team am Truck kann
    // einen Tippfehler jederzeit richtigstellen. Der Aenderungszaehler des
    // Kunden wird dabei zurueckgesetzt, damit er nicht doppelt bestraft wird.
    if (input.birthday !== undefined && input.birthday !== null) {
      const b = String(input.birthday).trim();
      if (b === '') {
        if (rec.birthday) parts.push('Geburtstag ' + rec.birthday + ' → entfernt');
        rec.birthday = '';
        rec.birthdayChanges = 0;
      } else {
        const m = b.match(/^(\d{1,2})\.(\d{1,2})\.?$/);
        if (!m) return json(400, { error: 'bad_birthday', hint: 'Format TT.MM.' });
        const dd = Math.min(31, Math.max(1, parseInt(m[1], 10)));
        const mm = Math.min(12, Math.max(1, parseInt(m[2], 10)));
        const neu = String(dd).padStart(2, '0') + '.' + String(mm).padStart(2, '0') + '.';
        if (neu !== rec.birthday) {
          parts.push('Geburtstag ' + (rec.birthday || '–') + ' → ' + neu);
          rec.birthday = neu;
          rec.birthdayChanges = 0;
        }
      }
    }

    if (!parts.length) return json(400, { error: 'no_change', hint: 'Nichts geändert' });

    await s.setJSON(idx.key, rec);
    await auditLog(who, 'Guthaben korrigiert für ' + (rec.email || '?') + ': ' + parts.join(', ')
      + (input.reason ? ' – Grund: ' + String(input.reason).slice(0, 80) : ''));
    return json(200, { ok: true, card: cardView(rec), changed: parts });
  }

  if (input.action === 'redeem') {
    if ((rec.rewards || 0) < 1) return json(409, { error: 'no_rewards', hint: 'Kein Bonus auf der Karte' });
    rec.rewards = rec.rewards - 1;
    await s.setJSON(idx.key, rec);
    await auditLog(who, '5-€-Bonus eingelöst für ' + (rec.email || '?') + ' (Rest: ' + rec.rewards + ')');
    return json(200, { ok: true, card: cardView(rec) });
  }

  return json(400, { error: 'unknown_action' });
};
