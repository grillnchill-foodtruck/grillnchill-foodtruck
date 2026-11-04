/**
 * lib/geschenk-mail.js
 * ----------------------------------------------------------------------------
 * Mails zu Geschenkgutscheinen (lib/geschenk.js): an die Käuferin, an die
 * beschenkte Person und die kurze Info an Kubi per Telegram. Beide Mails
 * haben das PDF im Anhang und einen Link darauf.
 *
 * Versand über Brevo wie send-email.js (BREVO_API_KEY, BREVO_SENDER_EMAIL,
 * BREVO_SENDER_NAME). Fehlt der Schlüssel, gibt es false zurück und der
 * Aufrufer plant einen neuen Versuch.
 * ----------------------------------------------------------------------------
 */

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const euro = (n) => Number(n || 0).toFixed(2).replace('.', ',') + ' €';
const deDatum = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? iso.split('-').reverse().join('.') : '');
function deDatumLang(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || '')) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, d, 12)));
}
const seite = () => (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');

async function senden(an, betreff, html, anhaenge) {
  const apiKey = process.env.BREVO_API_KEY || '';
  const absender = process.env.BREVO_SENDER_EMAIL || '';
  if (!apiKey || !absender) return false;
  const r = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: { email: absender, name: process.env.BREVO_SENDER_NAME || 'Grilln Chill' },
      to: [{ email: an.email, name: an.name || '' }],
      subject: betreff,
      htmlContent: html,
      ...(anhaenge && anhaenge.length ? { attachment: anhaenge } : {}),
    }),
  });
  if (!r.ok) {
    const data = await r.json().catch(() => null);
    console.error('Brevo Gutschein:', r.status, (data && (data.code || data.message)) || '');
  }
  return r.ok;
}

async function pdfAnhang(d, mitBeleg) {
  const anhaenge = [];
  try {
    const pdf = await require('./geschenk-pdf').gutscheinPdf(d);
    anhaenge.push({ name: 'Gutschein-' + d.code + '.pdf', content: pdf.toString('base64') });
  } catch (e) { console.error('Gutschein-PDF:', e.message); }
  if (mitBeleg) {
    try {
      const b = require('./geschenk-beleg');
      const pdf = await b.belegPdf(b.belegDaten(d));
      anhaenge.push({ name: 'Kaufbeleg-' + d.reference + '.pdf', content: pdf.toString('base64') });
    } catch (e) { console.error('Gutschein-Beleg:', e.message); }
  }
  return anhaenge;
}

/* ---- Bausteine ------------------------------------------------------------ */
function rahmen(unterzeile, inhalt) {
  return `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;background:#0F0D0A;border-radius:14px;overflow:hidden;">
  <div style="background:#CC4715;padding:22px 28px;">
    <div style="font-size:20px;font-weight:800;color:#fff;">GRILL'N CHILL</div>
    <div style="font-size:12px;color:#FFD9C4;letter-spacing:1px;">${unterzeile}</div>
  </div>
  <div style="padding:28px;background:#fff;">${inhalt}</div>
  <div style="padding:14px 28px;background:#0F0D0A;color:#8F8471;font-size:11px;">
    Grill'n Chill Yildiz und Öztas GbR · Gütersloher Straße 122, 33649 Bielefeld
  </div>
</div>`;
}

function codeKasten(d) {
  const fuer = d.recipientName ? `<div style="margin-top:8px;color:#555;font-size:14px;">Für <strong>${esc(d.recipientName)}</strong>${d.buyerName ? ' · von <strong>' + esc(d.buyerName) + '</strong>' : ''}</div>` : '';
  return `
<div style="border:2px dashed #CC4715;border-radius:12px;padding:22px;text-align:center;margin:0 0 18px;background:#FFF8F4;">
  <div style="font-size:12px;color:#996;letter-spacing:1px;margin-bottom:6px;">GUTSCHEIN-CODE</div>
  <div style="font-size:30px;font-weight:800;letter-spacing:3px;color:#CC4715;font-family:Consolas,Menlo,monospace;">${esc(d.code)}</div>
  <div style="font-size:24px;font-weight:800;color:#222;margin-top:8px;">${euro(d.amount)}</div>
  ${fuer}
  <div style="margin-top:6px;color:#888;font-size:12px;">gültig bis ${deDatum(d.validUntil)}</div>
</div>`;
}

function nachrichtBlock(d) {
  if (!d.message) return '';
  const zeilen = esc(d.message).replace(/\n/g, '<br>');
  return `<div style="margin:0 0 18px;padding:14px 18px;border-left:3px solid #E85A24;background:#FBF6EC;color:#333;font-size:15px;line-height:1.6;font-style:italic;">${zeilen}${d.buyerName ? `<div style="margin-top:8px;font-style:normal;font-size:13px;color:#777;">${esc(d.buyerName)}</div>` : ''}</div>`;
}

function einloesen(d) {
  const link = seite() + '/?gutschein=' + encodeURIComponent(d.code) + '#menu';
  return `
<p style="margin:0 0 8px;color:#333;font-weight:700;">So löst du ihn ein</p>
<ol style="margin:0 0 18px;padding-left:20px;color:#555;font-size:14px;line-height:1.7;">
  <li>Auf <a href="${seite()}" style="color:#CC4715;">grillnchill-foodtruck.de</a> oder in der App bestellen</li>
  <li>Im Warenkorb den Code <strong>${esc(d.code)}</strong> eintippen</li>
  <li>Abholen am Truck oder liefern lassen</li>
</ol>
<p style="margin:0 0 18px;"><a href="${link}" style="display:inline-block;background:#CC4715;color:#fff;text-decoration:none;font-weight:800;padding:13px 22px;border-radius:10px;">Jetzt Burger bestellen</a></p>`;
}

function kleingedruckt(d) {
  return `<p style="margin:0;color:#888;font-size:12px;line-height:1.6;">
  Einlösbar online ab einem Bestellwert von ${euro(d.amount)} · einmalig gültig · keine Barauszahlung · gültig bis ${deDatum(d.validUntil)}
  · <a href="${seite()}/gutscheine?code=${encodeURIComponent(d.code)}#pruefen" style="color:#888;">Gutschein prüfen</a>
</p>`;
}

function pdfKnopf(d) {
  const { pdfLink } = require('./geschenk');
  return `<p style="margin:0 0 18px;"><a href="${pdfLink(d, false)}" style="display:inline-block;border:1.5px solid #CC4715;color:#CC4715;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:10px;">Gutschein als PDF</a></p>`;
}

/* ---- Mails ---------------------------------------------------------------- */
async function kaeuferMail(d) {
  const hallo = d.buyerName ? esc(d.buyerName) : 'Burger-Fan';
  let weg;
  if (d.delivery === 'mail' && d.sendOn) {
    weg = `Wir schicken ihn am <strong>${esc(deDatumLang(d.sendOn))}</strong> um 8 Uhr an ${esc(d.recipientName)} (${esc(d.recipientEmail)}). Den Code hast du hier schon, du kannst ihn also auch früher weitergeben.`;
  } else if (d.delivery === 'mail') {
    weg = `Wir haben ihn gerade an ${esc(d.recipientName)} (${esc(d.recipientEmail)}) geschickt. Das PDF hängt hier zusätzlich an, falls du ihn selbst überreichen willst.`;
  } else if (d.delivery === 'print') {
    weg = 'Das PDF zum Ausdrucken hängt an dieser Mail. Darauf ist eine Karte zum Ausschneiden.';
  } else {
    weg = 'Gib den Code weiter oder bestell selbst damit.';
  }
  const inhalt = `
<p style="margin:0 0 14px;color:#333;">Hallo ${hallo}, danke für deinen Kauf. Hier ist dein Gutschein:</p>
${codeKasten(d)}
<p style="margin:0 0 18px;color:#333;font-size:14px;line-height:1.6;">${weg}</p>
${pdfKnopf(d)}
${einloesen(d)}
${kleingedruckt(d)}
<p style="margin:10px 0 0;color:#aaa;font-size:11px;">Dein Kaufbeleg ${esc(d.reference)} hängt als PDF an. <a href="${require('./geschenk').pdfLink(d, true, 'beleg')}" style="color:#aaa;">Kaufbeleg herunterladen</a></p>`;
  return senden({ email: d.buyerEmail, name: d.buyerName }, `Dein Grill'n Chill Gutschein über ${euro(d.amount)}`,
    rahmen('DEIN GESCHENKGUTSCHEIN', inhalt), await pdfAnhang(d, true));
}

async function empfaengerMail(d) {
  const von = d.buyerName || 'Jemand';
  const inhalt = `
<p style="margin:0 0 14px;color:#333;font-size:16px;">Hallo ${esc(d.recipientName)}, ${esc(von)} schenkt dir einen Gutschein von Grill'n Chill.</p>
${nachrichtBlock(d)}
${codeKasten(d)}
${einloesen(d)}
${pdfKnopf(d)}
${kleingedruckt(d)}`;
  return senden({ email: d.recipientEmail, name: d.recipientName }, `${von} schenkt dir ${euro(d.amount)} bei Grill'n Chill`,
    rahmen('EIN GUTSCHEIN FÜR DICH', inhalt), await pdfAnhang(d));
}

async function betreiberInfo(d) {
  const { telegram, esc: tEsc } = require('./telegram');
  const weg = d.delivery === 'mail'
    ? (d.sendOn ? 'per Mail am ' + deDatum(d.sendOn) : 'per Mail sofort') + ' an ' + tEsc(d.recipientName)
    : d.delivery === 'print' ? 'zum Ausdrucken' : 'an den Käufer';
  await telegram('🎁 <b>GUTSCHEIN VERKAUFT</b>\n' + euro(d.amount) + ' · Code ' + tEsc(d.code)
    + '\nKäufer: ' + (tEsc(d.buyerName) || '-') + ' (' + tEsc(d.buyerEmail) + ')'
    + (d.recipientName ? '\nFür: ' + tEsc(d.recipientName) : '') + '\nZustellung: ' + weg, { html: true });
}

module.exports = { kaeuferMail, empfaengerMail, betreiberInfo, deDatumLang };
