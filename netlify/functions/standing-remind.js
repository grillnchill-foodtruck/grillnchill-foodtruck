/**
 * standing-remind.js
 * ----------------------------------------------------------------------------
 * Erinnerung am Vorabend für stehende Bestellungen.
 * Geplant über netlify.toml (17:00 UTC ≈ 19:00 deutsche Sommerzeit).
 *
 * Verschickt wird NUR, wenn
 *   – der Kunde die Erinnerung ausdrücklich eingeschaltet hat (remind === true),
 *   – die Reihe nicht pausiert ist,
 *   – der nächste Termin morgen liegt,
 *   – für genau diesen Termin noch nicht erinnert wurde (lastRemindedFor).
 *
 * Es wird nichts bestellt und nichts abgebucht. Die Mail enthält zwei Wege:
 * "Bestellung öffnen" (füllt den Warenkorb vor) und "Diese Woche aussetzen".
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

const esc = (x) => String(x == null ? '' : x)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const preis = (n) => (Number(n) || 0).toFixed(2).replace('.', ',') + ' €';

const TAGE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

/* Kurzlebiges Token für die Links in der Mail – ohne Anmeldung nutzbar,
   aber nur für genau diese Reihe und nur zusammen mit der Kennung. */
function linkToken(id, secret) {
  return crypto.createHmac('sha256', secret || 'gnc').update('so:' + id).digest('hex').slice(0, 16);
}

function berlinDatum(d) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(d);
}

async function sendeMail(apiKey, sender, senderName, an, betreff, html) {
  const res = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: sender, name: senderName },
      to: [{ email: an }],
      subject: betreff,
      htmlContent: html,
    }),
  });
  return res.ok;
}

function baueMail(rec, siteUrl, token) {
  const tag = TAGE[rec.weekday] || '';
  const summe = (rec.items || []).reduce((n, i) => n + (Number(i.total) || 0), 0);
  const zeilen = (rec.items || []).map(i =>
    `<tr><td style="padding:7px 14px;border-bottom:1px solid #eee;color:#333;">${esc(i.name)} <span style="color:#888;">× ${i.qty}</span></td>
         <td style="padding:7px 14px;border-bottom:1px solid #eee;text-align:right;color:#333;font-weight:600;">${preis(i.total)}</td></tr>`
  ).join('');
  const oeffnen = `${siteUrl}/?so=${encodeURIComponent(rec.id)}&t=${token}`;
  const aussetzen = `${siteUrl}/.netlify/functions/standing-skip?id=${encodeURIComponent(rec.id)}&t=${token}`;
  const aus = `${siteUrl}/.netlify/functions/standing-skip?id=${encodeURIComponent(rec.id)}&t=${token}&off=1`;

  return `<!DOCTYPE html><html><body style="margin:0;background:#F4F1EA;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F4F1EA;padding:24px 0;"><tr><td align="center">
  <table width="100%" style="max-width:560px;background:#fff;border-radius:12px;overflow:hidden;">
    <tr><td style="background:#1A1A1A;padding:22px 30px;">
      <div style="color:#F5E9D0;font-size:19px;font-weight:700;">Morgen ist wieder ${esc(tag)}</div>
    </td></tr>
    <tr><td style="padding:24px 30px 8px;color:#444;line-height:1.6;">
      <p style="margin:0 0 14px;">Deine stehende Bestellung für <strong>${esc(tag)}, ${esc(rec.time)} Uhr</strong>
      liegt bereit. Du entscheidest – wir bestellen nichts von allein.</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:8px;">
        ${zeilen}
        <tr><td style="padding:9px 14px;font-weight:700;color:#1a1a1a;">Summe</td>
            <td style="padding:9px 14px;text-align:right;font-weight:700;color:#1a1a1a;">${preis(summe)}</td></tr>
      </table>
      <p style="margin:16px 0 6px;color:#666;font-size:13px;">
        ${rec.mode === 'delivery' ? 'Lieferung' : 'Abholung am Truck'}${rec.note ? ' · ' + esc(rec.note) : ''}
      </p>
    </td></tr>
    <tr><td style="padding:8px 30px 26px;text-align:center;">
      <a href="${oeffnen}" style="display:inline-block;background:#E85A24;color:#fff;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:999px;">Bestellung öffnen</a>
      <div style="margin-top:14px;">
        <a href="${aussetzen}" style="color:#666;font-size:13px;">Diese Woche aussetzen</a>
      </div>
    </td></tr>
    <tr><td style="background:#F8F5EE;padding:16px 30px;text-align:center;color:#999;font-size:11px;line-height:1.6;">
      Du bekommst diese Erinnerung, weil du sie in deinem Kundenkonto eingeschaltet hast.<br>
      <a href="${aus}" style="color:#999;">Erinnerungen abschalten</a> ·
      <a href="${siteUrl}" style="color:#999;">grillnchill-foodtruck.de</a>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

exports.handler = async () => {
  const apiKey = process.env.BREVO_API_KEY || '';
  const sender = process.env.BREVO_SENDER_EMAIL || '';
  const senderName = process.env.BREVO_SENDER_NAME || "Grill'n Chill";
  const siteUrl = (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');
  const secret = process.env.STATUS_SECRET || process.env.ADMIN_PASSWORD || 'gnc';
  if (!apiKey || !sender) {
    console.error('standing-remind: Brevo nicht konfiguriert');
    return { statusCode: 200, body: 'skipped' };
  }

  const s = store('standing');
  const morgen = berlinDatum(new Date(Date.now() + 86400000));
  let geprueft = 0, gesendet = 0;

  try {
    const { blobs } = await s.list({ prefix: 'so:' });
    for (const b of blobs) {
      const rec = await s.get(b.key, { type: 'json' });
      if (!rec) continue;
      geprueft++;

      // Ohne ausdrückliche Zustimmung wird nichts verschickt.
      if (rec.remind !== true) continue;
      if (rec.paused) continue;
      if (!rec.nextRun) continue;
      if (berlinDatum(new Date(rec.nextRun)) !== morgen) continue;
      // Für genau diesen Termin schon erinnert? Dann nicht doppelt.
      if (rec.lastRemindedFor === rec.nextRun) continue;

      const token = linkToken(rec.id, secret);
      const html = baueMail(rec, siteUrl, token);
      const tag = TAGE[rec.weekday] || '';
      const ok = await sendeMail(apiKey, sender, senderName, rec.email,
        `Morgen ${tag}: deine Bestellung liegt bereit`, html);
      if (ok) {
        rec.lastRemindedFor = rec.nextRun;
        await s.setJSON(b.key, rec);
        gesendet++;
      }
    }
  } catch (e) {
    console.error('standing-remind:', e);
  }

  console.log(`standing-remind: ${geprueft} geprüft, ${gesendet} Erinnerungen verschickt`);
  return { statusCode: 200, body: JSON.stringify({ geprueft, gesendet }) };
};
