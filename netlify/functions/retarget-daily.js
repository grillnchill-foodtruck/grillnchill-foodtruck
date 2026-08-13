/**
 * retarget-daily.js
 * ----------------------------------------------------------------------------
 * Täglicher Cron-Job (siehe netlify.toml: schedule = "0 9 * * *" UTC
 * = 11:00 deutscher Sommerzeit / 10:00 Winterzeit).
 *
 * Ablauf je fälligem Eintrag (7 Tage nach der letzten Bestellung):
 *   1. Abgemeldet (Opt-out)?             → überspringen, Eintrag löschen
 *   2. Gutschein in den letzten 30 Tagen? → überspringen, Eintrag löschen
 *   3. Zufälligen 3-€-Code erzeugen (3 Tage gültig, Mindestbestellwert 15 €)
 *   4. Retargeting-Mail via Brevo senden (inkl. Abmelde-Link)
 *   5. Statistik-Zähler voucher_sent erhöhen
 *
 * Wichtig: Bestellt der Kunde innerhalb der 7 Tage erneut, überschreibt der
 * Order-Hook in send-email.js den Queue-Eintrag mit neuem Fälligkeitsdatum –
 * es wird also nur an Kunden gesendet, die NICHT von selbst zurückkamen.
 *
 * Environment (alle bereits vorhanden): BREVO_API_KEY, BREVO_SENDER_EMAIL,
 * BREVO_SENDER_NAME, ADMIN_PASSWORD, NETLIFY_BLOBS_SITE_ID/TOKEN, SITE_URL.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const VOUCHER_VALUE = 3;
const VOUCHER_MIN_ORDER = 15;
const VOUCHER_VALID_DAYS = 3;
const COOLDOWN_DAYS = 30;
const MAX_SENDS_PER_RUN = 50;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne 0/O/1/I

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

function randomCode() {
  let c = '';
  const buf = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) c += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return c;
}

function unsubToken(email) {
  return crypto.createHash('sha256')
    .update('optout:' + email.toLowerCase() + ':' + (process.env.ADMIN_PASSWORD || ''))
    .digest('hex').slice(0, 24);
}

function fmtDateDE(d) {
  return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildVoucherEmail(name, code, expiresAt, siteUrl, unsubUrl) {
  const until = fmtDateDE(new Date(expiresAt));
  const subject = '3 \u20AC Gutschein f\u00FCr deine n\u00E4chste Bestellung \u2013 3 Tage g\u00FCltig';
  const html = `<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F5F1E8;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
    <div style="background:#0F0D0B;border-radius:14px 14px 0 0;padding:26px 28px;">
      <div style="font-size:22px;font-weight:800;color:#F5E9D0;letter-spacing:0.5px;">GRILL'N CHILL</div>
      <div style="color:#FF7A3D;font-size:12px;font-weight:700;letter-spacing:1px;margin-top:2px;">HALAL BURGER \u00B7 BIELEFELD</div>
    </div>
    <div style="background:#ffffff;padding:30px 28px;border-radius:0 0 14px 14px;">
      <h1 style="margin:0 0 10px;font-size:20px;color:#1a1a1a;">Hi ${esc(name)}, wir haben was f\u00FCr dich</h1>
      <p style="margin:0 0 22px;color:#555;font-size:14px;line-height:1.6;">
        Als kleines Dankesch\u00F6n f\u00FCr deine letzte Bestellung schenken wir dir
        <strong>3&nbsp;\u20AC Rabatt</strong> auf deine n\u00E4chste Online-Bestellung
        (ab ${VOUCHER_MIN_ORDER}&nbsp;\u20AC Bestellwert). Einfach im Warenkorb unter
        \u201EGutschein-Code\u201C eingeben:
      </p>
      <div style="border:2px dashed #E85A24;border-radius:10px;padding:18px;text-align:center;margin:0 0 8px;background:#FFF8F3;">
        <div style="font-size:26px;font-weight:800;letter-spacing:4px;color:#CC4715;font-family:Consolas,Menlo,monospace;">${code}</div>
      </div>
      <p style="margin:0 0 24px;text-align:center;color:#888;font-size:12px;">
        G\u00FCltig bis <strong>${until}</strong> \u00B7 einmalig einl\u00F6sbar \u00B7 nicht mit anderen Aktionen kombinierbar
      </p>
      <div style="text-align:center;margin:0 0 26px;">
        <a href="${siteUrl}/#menu" style="display:inline-block;background:#CC4715;color:#ffffff;padding:14px 30px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;">
          Jetzt bestellen
        </a>
      </div>
      <p style="margin:0;color:#999;font-size:12px;line-height:1.6;">
        Frisch gegrillt am Truck, Abholung oder Lieferung \u2013 wie du magst.<br>
        Bis bald, dein Grilln Chill Team
      </p>
    </div>
    <p style="text-align:center;color:#9a9a9a;font-size:11px;line-height:1.7;margin:16px 8px 0;">
      Grill'n Chill Yildiz und \u00D6ztas GbR \u00B7 G\u00FCtersloher Stra\u00DFe 122, 33649 Bielefeld<br>
      Du erh\u00E4ltst diese E-Mail, weil du bei uns bestellt hast.
      <a href="${unsubUrl}" style="color:#9a9a9a;">Keine Angebots-Mails mehr erhalten</a>
    </p>
  </div>
</body></html>`;
  return { subject, html };
}

async function sendViaBrevo(recipientEmail, recipientName, subject, html) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: { email: process.env.BREVO_SENDER_EMAIL, name: process.env.BREVO_SENDER_NAME || 'Grilln Chill' },
      to: [{ email: recipientEmail, name: recipientName || '' }],
      subject,
      htmlContent: html,
    }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => null);
    throw new Error('Brevo ' + res.status + ': ' + ((d && d.message) || 'unknown'));
  }
}

// Anonymer Tages-Zähler (gleiche Struktur wie track.js)
async function bumpStat(name) {
  try {
    const s = store('analytics');
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
    const key = 'day:' + day;
    const data = (await s.get(key, { type: 'json' })) || {};
    data[name] = (data[name] || 0) + 1;
    await s.setJSON(key, data);
  } catch (e) {}
}

exports.handler = async () => {
  if (!process.env.BREVO_API_KEY || !process.env.BREVO_SENDER_EMAIL) {
    return { statusCode: 200, body: JSON.stringify({ ok: false, error: 'brevo_not_configured' }) };
  }
  const siteUrl = (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');
  const rt = store('retarget');
  const vs = store('vouchers');
  const now = Date.now();
  let sent = 0, skippedOptout = 0, skippedCooldown = 0, pending = 0, errors = 0;

  try {
    const { blobs } = await rt.list({ prefix: 'q:' });
    for (const b of blobs) {
      if (sent >= MAX_SENDS_PER_RUN) break;
      const entry = await rt.get(b.key, { type: 'json' });
      if (!entry || !entry.email) { await rt.delete(b.key); continue; }
      if (new Date(entry.dueAt).getTime() > now) { pending++; continue; }

      const hash = b.key.slice(2);

      // 1) Abgemeldet?
      if (await rt.get('opt:' + hash, { type: 'json' })) {
        await rt.delete(b.key); skippedOptout++; continue;
      }
      // 2) Cooldown: schon in den letzten 30 Tagen einen Gutschein bekommen?
      const cd = await rt.get('cd:' + hash, { type: 'json' });
      if (cd && now - new Date(cd.sentAt).getTime() < COOLDOWN_DAYS * 86400000) {
        await rt.delete(b.key); skippedCooldown++; continue;
      }

      try {
        // 3) Einmaligen Code erzeugen
        let code = randomCode();
        for (let i = 0; i < 4 && await vs.get('v:' + code, { type: 'json' }); i++) code = randomCode();
        const expiresAt = new Date(now + VOUCHER_VALID_DAYS * 86400000).toISOString();
        await vs.setJSON('v:' + code, {
          value: VOUCHER_VALUE,
          minOrder: VOUCHER_MIN_ORDER,
          expiresAt,
          emailHash: hash,
          used: false,
          createdAt: new Date(now).toISOString(),
        });

        // 4) Mail senden
        const unsubUrl = siteUrl + '/retarget-optout?e=' +
          Buffer.from(entry.email.toLowerCase()).toString('base64url') +
          '&t=' + unsubToken(entry.email);
        const mail = buildVoucherEmail(entry.name || '', code, expiresAt, siteUrl, unsubUrl);
        await sendViaBrevo(entry.email, entry.name, mail.subject, mail.html);

        // 5) Aufräumen + zählen
        await rt.setJSON('cd:' + hash, { sentAt: new Date(now).toISOString() });
        await rt.delete(b.key);
        await bumpStat('voucher_sent');
        sent++;
      } catch (e) {
        errors++; // Eintrag bleibt stehen → nächster Lauf versucht es erneut
      }
    }
    return { statusCode: 200, body: JSON.stringify({ ok: true, sent, pending, skippedOptout, skippedCooldown, errors }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String((e && e.message) || e) }) };
  }
};
