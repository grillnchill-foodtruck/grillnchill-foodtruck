/**
 * birthday-daily.js
 * ----------------------------------------------------------------------------
 * Täglicher Geburtstags-Bonus (geplant via netlify.toml, 07:00 UTC ≈ 09:00 DE).
 * Für jedes Kundenkonto mit heutigem Geburtstag (TT.MM., Europe/Berlin):
 *   – 1 Treuebonus (5 €) auf die Server-Stempelkarte
 *   – Glückwunsch-Mail über Brevo
 *   – Vermerk des Jahres, damit es pro Jahr genau einmal passiert
 * Idempotent auch bei Mehrfachlauf am selben Tag (Jahres-Guard je Konto).
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');

function store() {
  const opts = { name: 'customers', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

function berlinToday() {
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t).value;
  return { ddmm: get('day') + '.' + get('month') + '.', year: get('year') };
}

async function sendBirthdayMail(email, name) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || 'Grilln Chill';
  if (!apiKey || !senderEmail) return false;
  const hello = name ? name.split(' ')[0] : 'Burger-Fan';
  const siteUrl = (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;background:#0F0D0A;border-radius:14px;overflow:hidden;">
    <div style="background:#CC4715;padding:22px 26px;">
      <div style="font-size:20px;font-weight:800;color:#fff;">GRILL'N CHILL</div>
      <div style="font-size:12px;color:#FFD9C4;letter-spacing:1px;">ALLES GUTE ZUM GEBURTSTAG</div>
    </div>
    <div style="padding:26px;background:#fff;">
      <p style="margin:0 0 12px;color:#333;font-size:16px;"><b>Happy Birthday, ${hello}!</b></p>
      <p style="margin:0 0 16px;color:#555;">Zum Geburtstag haben wir dir <b>5&nbsp;€ Treuebonus</b> auf deine Stempelkarte gelegt.
      Einfach beim nächsten Online-Bestellen (ab 15&nbsp;€ Bestellwert) im Warenkorb einlösen – wir grillen, du feierst.</p>
      <div style="text-align:center;margin:22px 0;">
        <a href="${siteUrl}/#menu" style="display:inline-block;background:#CC4715;color:#fff;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:10px;">Jetzt Geburtstags-Burger sichern</a>
      </div>
      <p style="margin:0;color:#999;font-size:12px;">Dein Bonus liegt in deinem Konto bereit und verfällt nicht. Feier schön!</p>
    </div>
  </div>`;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender: { email: senderEmail, name: senderName },
      to: [{ email, name: name || undefined }],
      subject: `Happy Birthday, ${hello} – 5 € Geburtstagsbonus wartet auf dich`,
      htmlContent: html,
    }),
  });
  return res.ok;
}

exports.handler = async () => {
  const s = store();
  const { ddmm, year } = berlinToday();
  let checked = 0, gifted = 0, mails = 0, errors = 0;
  try {
    const { blobs } = await s.list({ prefix: 'c:' });
    for (const b of blobs) {
      try {
        const rec = await s.get(b.key, { type: 'json' });
        checked++;
        if (!rec || !rec.birthday || rec.birthday !== ddmm) continue;
        if (rec.lastBirthdayGiftYear === year) continue; // dieses Jahr schon beschenkt
        rec.rewards = (rec.rewards || 0) + 1;
        rec.lastBirthdayGiftYear = year;
        await s.setJSON(b.key, rec);
        gifted++;
        try { if (rec.email && (await sendBirthdayMail(rec.email, rec.name))) mails++; } catch (e) { errors++; }
      } catch (e) { errors++; }
    }
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e.message || e) }) };
  }
  return { statusCode: 200, body: JSON.stringify({ ok: true, today: ddmm, checked, gifted, mails, errors }) };
};
