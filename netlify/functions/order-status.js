/**
 * order-status.js
 * ----------------------------------------------------------------------------
 * Live-Bestellstatus für Kunden + Status-Setzen durch das Team.
 *
 *   GET  ?ref=GNC-…&k=<key>        → öffentlicher Status (Key aus Mail/Erfolgsseite)
 *   GET  ?ref=GNC-…&ck=<checkoutId>→ wie oben, Nachweis über geheime SumUp-ID
 *   POST { action:'set', password|secret, reference, state }
 *        → Team setzt Status (alle Rollen); Push an den Kunden, falls abonniert
 *   POST { action:'subscribe', reference, k, subscription }
 *        → Kunde abonniert Push für genau diese Bestellung (am Datensatz gespeichert)
 *
 * Der Status-Key ist ableitbar (sha256(ref|STATUS_UPDATE_SECRET), 20 Zeichen) –
 * keine Speicheränderung nötig, nicht erratbar, gilt genau für eine Bestellung.
 * Zustände: confirmed → preparing → ready_for_pickup → picked_up   (Abholung)
 *           confirmed → preparing → on_the_way       → delivered   (Lieferung)
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const webpush = require('web-push');
const { getStore } = require('@netlify/blobs');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung } = require('./lib/admin-sitzung');

const STATES = ['confirmed', 'preparing', 'ready_for_pickup', 'on_the_way', 'picked_up', 'delivered'];
const PUSH_TEXT = {
  de: {
    preparing: { title: 'Auf dem Grill', body: 'Deine Bestellung liegt frisch auf dem Grill.' },
    ready_for_pickup: { title: 'Fertig zur Abholung', body: 'Dein Essen wartet am Truck auf dich – guten Appetit!' },
    on_the_way: { title: 'Unterwegs zu dir', body: 'Deine Lieferung ist losgefahren.' },
    picked_up: { title: 'Guten Appetit!', body: 'Danke für deine Bestellung bei Grill\'n Chill.' },
    delivered: { title: 'Zugestellt – guten Appetit!', body: 'Danke für deine Bestellung bei Grill\'n Chill.' },
  },
  en: {
    preparing: { title: 'On the grill', body: 'We\'re grilling your order fresh right now.' },
    ready_for_pickup: { title: 'Ready for pickup', body: 'Your food is waiting for you at the truck – enjoy!' },
    on_the_way: { title: 'On its way to you', body: 'Your delivery has just left.' },
    picked_up: { title: 'Enjoy your meal!', body: 'Thanks for ordering at Grill\'n Chill.' },
    delivered: { title: 'Delivered – enjoy!', body: 'Thanks for ordering at Grill\'n Chill.' },
  },
  tr: {
    preparing: { title: 'Izgarada', body: 'Siparişin şu anda ızgarada, taze hazırlıyoruz.' },
    ready_for_pickup: { title: 'Teslim almaya hazır', body: 'Yemeğin truckta seni bekliyor – afiyet olsun!' },
    on_the_way: { title: 'Sana geliyor', body: 'Siparişin yola çıktı.' },
    picked_up: { title: 'Afiyet olsun!', body: 'Grill\'n Chill\'i tercih ettiğin için teşekkürler.' },
    delivered: { title: 'Teslim edildi – afiyet olsun!', body: 'Grill\'n Chill\'i tercih ettiğin için teşekkürler.' },
  },
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

function statusKey(ref) {
  const secret = process.env.STATUS_UPDATE_SECRET || '';
  return crypto.createHash('sha256').update(ref + '|' + secret).digest('hex').slice(0, 20);
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

async function auditLog(who, area, text) {
  try {
    const a = store('audit');
    const key = 'a:' + new Date().toISOString() + '_' + Math.random().toString(36).slice(2, 7);
    // Feldnamen wie in den übrigen Functions – das Admin-Tool liest name/action/detail
    await a.setJSON(key, {
      at: new Date().toISOString(),
      name: (who && who.name) || '?',
      role: (who && who.role) || '?',
      action: area,
      detail: String(text || '').slice(0, 300),
    });
  } catch (e) {}
}

function publicStatus(rec, ref) {
  const o = rec.order || {};
  const items = Array.isArray(o.items)
    ? o.items.slice(0, 20).map(it => ({ name: String(it.name || '').slice(0, 60), qty: it.qty || 1, price: it.price }))
    : [];
  return {
    reference: ref,
    mode: o.mode === 'delivery' ? 'delivery' : 'pickup',
    state: rec.fstate || 'confirmed',
    times: rec.fstateAt || { confirmed: rec.completedAt || rec.createdAt || null },
    scheduledFor: o.scheduledFor || null,
    isPreorder: !!o.isPreorder,
    items,
    total: typeof o.total === 'number' ? o.total : rec.total || null,
    completed: rec.status === 'completed',
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const s = store('orders');

  if (event.httpMethod === 'GET') {
    const q = event.queryStringParameters || {};
    const ref = String(q.ref || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
    if (!/^GNC-/.test(ref)) return json(400, { error: 'bad_ref' });
    const rec = await s.get('o:' + ref, { type: 'json' });
    if (!rec || rec.kind === 'giftcard') return json(404, { error: 'not_found' });
    const okKey = q.k && q.k === statusKey(ref);
    const okCk = q.ck && rec.checkoutId && q.ck === rec.checkoutId;
    if (!okKey && !okCk) return json(403, { error: 'forbidden' });
    const out = publicStatus(rec, ref);
    if (okCk) out.statusUrl = '/s/' + ref + '?k=' + statusKey(ref); // Erfolgsseite darf den Link lernen
    return json(200, out);
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }
  const ref = String(input.reference || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 40);
  if (!/^GNC-/.test(ref)) return json(400, { error: 'bad_ref' });
  const key = 'o:' + ref;
  const rec = await s.get(key, { type: 'json' });
  if (!rec || rec.kind === 'giftcard') return json(404, { error: 'not_found' });

  if (input.action === 'subscribe') {
    if (input.k !== statusKey(ref)) return json(403, { error: 'forbidden' });
    if (!input.subscription || !input.subscription.endpoint) return json(400, { error: 'bad_subscription' });
    rec.pushSub = input.subscription;
    rec.pushLang = (input.lang === 'en' || input.lang === 'tr') ? input.lang : 'de';
    await s.setJSON(key, rec);
    return json(200, { ok: true });
  }

  if (input.action === 'set') {
    // Team (alle Rollen) – oder interner Aufruf über das Status-Secret (Mail-Links)
    let who = null;
    if (input.secret && input.secret === (process.env.STATUS_UPDATE_SECRET || '__none__')) {
      who = { role: 'system', name: 'Status-Mail-Link' };
    } else {
      // Bremse gegen Durchprobieren – nur hier, der Zweig oben laeuft ueber
      // das System-Secret der Status-Mails und darf nicht mitgezaehlt werden.
      const gesperrt = await pruefeSperre(event);
      if (gesperrt) return gesperrt;
      who = await authRole(await passwortAusSitzung(input.password));
      await meldeErgebnis(event, !!who);
    }
    if (!who) return json(401, { error: 'unauthorized' });
    const state = String(input.state || '');
    if (!STATES.includes(state)) return json(400, { error: 'bad_state' });
    rec.fstate = state;
    rec.fstateAt = rec.fstateAt || {};
    if (!rec.fstateAt.confirmed) rec.fstateAt.confirmed = rec.completedAt || rec.createdAt || new Date().toISOString();
    rec.fstateAt[state] = new Date().toISOString();
    await s.setJSON(key, rec);
    await auditLog(who, 'Bestellstatus', '#' + ref + ' → ' + state);

    // Push an den Kunden – nur wenn diese Bestellung abonniert wurde
    let pushed = false;
    const pl = PUSH_TEXT[rec.pushLang] || PUSH_TEXT.de;
    if (rec.pushSub && pl[state]) {
      try {
        const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
        if (pub && priv) {
          webpush.setVapidDetails('mailto:info@grillnchill-foodtruck.de', pub, priv);
          await webpush.sendNotification(rec.pushSub, JSON.stringify({
            title: pl[state].title,
            body: pl[state].body,
            url: '/s/' + ref + '?k=' + statusKey(ref),
          }), { TTL: 3600 });
          pushed = true;
        }
      } catch (e) {
        // Abo abgelaufen o. Ä. → aufräumen, nie den Statuswechsel blockieren
        if (e && (e.statusCode === 404 || e.statusCode === 410)) {
          try { delete rec.pushSub; await s.setJSON(key, rec); } catch (e2) {}
        }
      }
    }
    // Mail-Fallback: nur im entscheidenden Moment, nur ohne Push-Abo, nur 1x je Status.
    // (Kommt der Aufruf über den Mail-Link (role 'system'), hat status-update die Mail
    //  bereits verschickt – dann hier keine Doppelung.)
    let mailed = false;
    if (who.role !== 'system' && !rec.pushSub
        && (state === 'ready_for_pickup' || state === 'on_the_way')
        && rec.order && rec.order.email) {
      rec.mailedStates = rec.mailedStates || {};
      if (!rec.mailedStates[state]) {
        try {
          const siteUrl = (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');
          const mr = await fetch(siteUrl + '/.netlify/functions/send-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'status_update', status: state, order: rec.order }),
          });
          mailed = mr.ok;
          if (mailed) { rec.mailedStates[state] = true; await s.setJSON(key, rec); }
        } catch (e) {}
      }
    }
    return json(200, { ok: true, state, pushed, mailed });
  }

  return json(400, { error: 'unknown_action' });
};
