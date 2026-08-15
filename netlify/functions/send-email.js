/**
 * ============================================================
 *  GRILL'N CHILL – E-Mail-Versand via Brevo (Netlify Function)
 * ============================================================
 *
 *  Sendet 3 Arten von E-Mails:
 *  1. order_confirmation     → Kunde: "Vielen Dank für deine Bestellung"
 *  2. status_update          → Kunde: "Deine Bestellung wird zubereitet / ist unterwegs / wurde geliefert"
 *  3. owner_notification     → Pasquale: "Neue Bestellung eingegangen"
 *
 *
 *  SETUP IN 5 SCHRITTEN
 *  ====================
 *
 *  1. BREVO-ACCOUNT ERSTELLEN
 *     - Gehe zu https://www.brevo.com (kostenlos, ohne Kreditkarte)
 *     - Mit Outlook-Adresse registrieren
 *     - E-Mail bestätigen
 *
 *  2. ABSENDER VERIFIZIEREN
 *     Du hast bereits eine eigene Geschäfts-E-Mail mit Domain
 *     (z.B. bestellungen@grillnchill-foodtruck.de oder info@...).
 *     Diese als Absender einrichten – am besten gleich die ganze Domain:
 *       - Brevo → Settings → Senders & IPs → Domains → "Add a domain"
 *       - grillnchill-foodtruck.de eintragen
 *       - Die angezeigten DNS-Einträge (SPF, DKIM, DMARC) bei deinem
 *         Domain-Anbieter (wo grillnchill-foodtruck.de registriert ist) eintragen
 *       - Nach Verifizierung: bestellungen@grillnchill-foodtruck.de als Absender nutzen
 *
 *     Schneller Zwischenschritt (ohne DNS): einzelne Adresse verifizieren
 *       - Brevo → Settings → Senders & IPs → "Add a Sender"
 *       - bestellungen@grillnchill-foodtruck.de eintragen
 *       - Bestätigungs-Mail bestätigen (musst Zugriff auf das Postfach haben)
 *     Hinweis: Domain-Verifizierung (SPF/DKIM) sorgt dafür, dass E-Mails
 *     NICHT im Spam landen – daher dringend empfohlen!
 *
 *  3. API-KEY GENERIEREN
 *     - Brevo → Settings → SMTP & API
 *     - Tab "API Keys" → "Generate a new API key"
 *     - Name: "Grillnchill Website"
 *     - API-Key kopieren (beginnt mit xkeysib-...)
 *
 *  4. ENVIRONMENT VARIABLES IN NETLIFY EINTRAGEN
 *     BREVO_API_KEY        = xkeysib-... (dein API-Key)
 *     BREVO_SENDER_EMAIL   = kubig38@outlook.de (oder eigene Domain-Adresse)
 *     BREVO_SENDER_NAME    = Grilln Chill
 *     OWNER_EMAIL          = kubig38@outlook.de (wo du Benachrichtigungen bekommst)
 *     STATUS_UPDATE_SECRET = irgendein-zufaelliger-string-1234 (sichert die Status-URLs)
 *
 *  5. NEU DEPLOYEN
 *     - Drag-and-Drop der ZIP nach Netlify
 *     - Status-Seite checken: /send-email/status
 *
 * ============================================================
 */

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

// --- Retargeting/Gutschein (Netlify Blobs, best effort – stört den Mailfluss nie) ---
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { buildInvoicePdf, buildInvoiceXml } = require('./lib/invoice');

/* Fortlaufende Rechnungsnummer. § 14 Abs. 4 Nr. 4 UStG verlangt eine
   einmalig vergebene, fortlaufende Nummer. Wir zaehlen je Jahr hoch:
   GNC-2026-0001. Der Zaehler liegt im Blob-Store, damit er auch ueber
   Neustarts hinweg eindeutig bleibt. */
function deDate(d) {
  return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin',
    day: '2-digit', month: '2-digit', year: 'numeric' }).format(d || new Date());
}

async function nextInvoiceNo() {
  const s = blobStore('invoices');
  const jahr = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric' })
    .format(new Date());
  const key = 'counter:' + jahr;
  const cur = (await s.get(key, { type: 'json' })) || { n: 0 };
  cur.n += 1;
  await s.setJSON(key, cur);
  return `GNC-${jahr}-${String(cur.n).padStart(4, '0')}`;
}

/* Rechnungsblock fuer Firmenkunden. Erscheint nur, wenn eine Firma
   angegeben wurde – Privatkunden bekommen die Bestaetigung wie bisher.

   Eine Rechnung muss die Positionen und jeden Abzug ZEIGEN, auch wenn am
   Ende 0,00 EUR stehen (z. B. bei einem Gutschein ueber den vollen Betrag).
   Vorher wurden nur die Steuerzeilen ausgegeben – bei voller Ermaessigung
   blieb die Rechnung dadurch leer. */
function zahlungsText(order) {
  if (order.payment !== 'sumup') {
    // Bar oder Karte am Truck entscheidet sich vor Ort; die Website erfaehrt
    // es nur, wenn es jemand nachtraegt.
    return order.paidWith ? esc(order.paidWith) : 'Vor Ort (bar oder Karte)';
  }
  const c = order.card || {};
  const marke = c.type ? String(c.type).charAt(0) + String(c.type).slice(1).toLowerCase() : null;
  if (marke && c.last4) return `Online mit ${esc(marke)} \u2022\u2022\u2022\u2022&nbsp;${esc(c.last4)}`;
  if (marke) return `Online mit ${esc(marke)}`;
  return 'Online bezahlt (SumUp)';
}

function buildInvoiceBlock(order) {
  if (!order.company || !order.invoiceNo) return '';
  const a = order.invoiceAddress || {};
  const z = (n) => Number(n) || 0;

  // --- Positionen -------------------------------------------------------
  const posZeilen = (order.items || []).map(i => `
    <tr>
      <td style="padding:7px 14px;border-bottom:1px solid #eee;color:#333;font-size:13px;">
        ${esc(i.name)}<br><span style="color:#999;font-size:12px;">${i.qty} &times; ${formatPrice(z(i.price) || z(i.total) / Math.max(1, i.qty))}</span>
      </td>
      <td style="padding:7px 14px;border-bottom:1px solid #eee;text-align:right;color:#333;font-size:13px;white-space:nowrap;">
        ${formatPrice(z(i.total))}
      </td>
    </tr>`).join('');

  // --- Abzuege ----------------------------------------------------------
  const abzug = (label, betrag) => `
    <tr>
      <td style="padding:6px 14px;color:#3D6B34;font-size:13px;">${label}</td>
      <td style="padding:6px 14px;text-align:right;color:#3D6B34;font-size:13px;white-space:nowrap;">&minus;&nbsp;${formatPrice(betrag)}</td>
    </tr>`;
  let abzuege = '';
  if (z(order.discount) > 0) {
    const code = (order.promo && order.promo.code) || order.voucherCode;
    abzuege += abzug(code ? `Rabatt (Code ${esc(code)})` : 'Rabatt', z(order.discount));
  }
  if (z(order.loyaltyDiscount) > 0) abzuege += abzug('Treuebonus', z(order.loyaltyDiscount));
  if (z(order.deliveryFee) > 0) {
    abzuege += `
    <tr>
      <td style="padding:6px 14px;color:#555;font-size:13px;">Liefergeb\u00fchr</td>
      <td style="padding:6px 14px;text-align:right;color:#555;font-size:13px;white-space:nowrap;">${formatPrice(z(order.deliveryFee))}</td>
    </tr>`;
  }

  // --- Steueraufstellung ------------------------------------------------
  const vat = Array.isArray(order.vat) ? order.vat : [];
  const steuerZeilen = vat.map(v => `
    <tr>
      <td style="padding:5px 14px;color:#666;font-size:12px;">Netto ${String(v.satz).replace('.', ',')}&nbsp;%</td>
      <td style="padding:5px 14px;text-align:right;color:#666;font-size:12px;white-space:nowrap;">${formatPrice(z(v.netto))}</td>
    </tr>
    <tr>
      <td style="padding:5px 14px;color:#666;font-size:12px;">zzgl. ${String(v.satz).replace('.', ',')}&nbsp;% USt.</td>
      <td style="padding:5px 14px;text-align:right;color:#666;font-size:12px;white-space:nowrap;">${formatPrice(z(v.steuer))}</td>
    </tr>`).join('');

  // Trinkgeld ist freiwillig und kein Entgelt fuer eine Leistung – es wird
  // ausgewiesen, aber ohne Umsatzsteuer.
  const trinkgeld = z(order.tip) > 0 ? `
    <tr>
      <td style="padding:6px 14px;color:#555;font-size:13px;">Trinkgeld (freiwillig, 0&nbsp;% USt.)</td>
      <td style="padding:6px 14px;text-align:right;color:#555;font-size:13px;white-space:nowrap;">${formatPrice(z(order.tip))}</td>
    </tr>` : '';

  const gesamt = z(order.total);

  return `
  <tr><td style="padding:0 30px 26px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #ddd;border-radius:8px;">
      <tr><td style="padding:18px 20px 6px;">
        <div style="font-size:18px;font-weight:700;color:#1a1a1a;">Rechnung</div>
        <div style="font-size:12px;color:#888;margin-top:3px;line-height:1.6;">
          Rechnungsnummer ${esc(order.invoiceNo)}<br>
          Rechnungsdatum ${esc(order.invoiceDate || '')} &middot; Leistungsdatum ${esc(order.serviceDate || order.invoiceDate || '')}
        </div>
      </td></tr>

      <tr><td style="padding:12px 20px 4px;">
        <table width="100%" cellpadding="0" cellspacing="0"><tr>
          <td width="50%" valign="top" style="font-size:12.5px;line-height:1.6;color:#444;padding-right:10px;">
            <div style="color:#999;font-size:10px;letter-spacing:.08em;margin-bottom:3px;">RECHNUNGSEMPF&Auml;NGER</div>
            <strong>${esc(order.company)}</strong><br>
            ${a.street ? esc(a.street) + '<br>' : ''}${esc(a.zip || '')} ${esc(a.city || '')}
          </td>
          <td width="50%" valign="top" style="font-size:12.5px;line-height:1.6;color:#444;">
            <div style="color:#999;font-size:10px;letter-spacing:.08em;margin-bottom:3px;">LEISTENDER</div>
            Grill&rsquo;n Chill Yildiz und &Ouml;ztas GbR<br>
            Im Teich 9, 49152 Bad Essen<br>
            USt-IdNr. DE459954473
          </td>
        </tr></table>
      </td></tr>

      <tr><td style="padding:14px 6px 0;">
        <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee;">
          ${posZeilen}
          <tr>
            <td style="padding:8px 14px;color:#555;font-size:13px;">Zwischensumme</td>
            <td style="padding:8px 14px;text-align:right;color:#555;font-size:13px;white-space:nowrap;">${formatPrice(z(order.subtotal))}</td>
          </tr>
          ${abzuege}
          ${steuerZeilen ? `<tr><td colspan="2" style="padding:8px 14px 2px;color:#999;font-size:11px;letter-spacing:.06em;border-top:1px solid #eee;">UMSATZSTEUER</td></tr>` : ''}
          ${steuerZeilen}
          ${trinkgeld}
          <tr>
            <td style="padding:11px 14px;border-top:2px solid #ddd;color:#1a1a1a;font-weight:700;">Gesamtbetrag</td>
            <td style="padding:11px 14px;border-top:2px solid #ddd;text-align:right;color:#1a1a1a;font-weight:700;white-space:nowrap;">${formatPrice(gesamt)}</td>
          </tr>
        </table>
      </td></tr>

      <tr><td style="padding:12px 20px 18px;font-size:12px;color:#666;line-height:1.7;border-top:1px solid #eee;">
        <strong style="color:#444;">Zahlung:</strong> ${zahlungsText(order)}<br>
        <strong style="color:#444;">Bestellung:</strong> ${esc(order.reference || '')} &middot;
        ${order.mode === 'delivery' ? 'Lieferung' : 'Abholung'}
        ${gesamt <= 0 ? '<br><span style="color:#888;">Der Rechnungsbetrag ist durch die ausgewiesenen Abz&uuml;ge vollst&auml;ndig ausgeglichen.</span>' : ''}
      </td></tr>
    </table>
  </td></tr>`;
}

function statusPageUrl(ref) {
  const secret = process.env.STATUS_UPDATE_SECRET || '';
  const k = require('crypto').createHash('sha256').update(ref + '|' + secret).digest('hex').slice(0, 20);
  const siteUrl = (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');
  return siteUrl + '/s/' + ref + '?k=' + k;
}
function blobStore(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}
const RETARGET_DELAY_DAYS = 7;
const ORDER_RETENTION_DAYS = 90;

// Bestell-Alarm: Push an alle Team-Geräte (Kanal admin:, siehe push-subscribe.js)
async function sendOrderAlertPush(order) {
  try {
    const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
    if (!pub || !priv) return;
    const webpush = require('web-push');
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:info@grillnchill-foodtruck.de', pub, priv);
    const s = blobStore('push');
    const { blobs } = await s.list({ prefix: 'admin:' });
    if (!blobs.length) return;
    const mode = order.mode === 'delivery' ? 'Lieferung' : 'Abholung';
    const pre = (order.isPreorder || order.scheduledFor) ? ' · VORBESTELLUNG' : '';
    const total = typeof order.total === 'number' ? order.total.toFixed(2).replace('.', ',') + ' €' : '';
    const payload = JSON.stringify({
      title: 'Neue Bestellung ' + (total ? '· ' + total : ''),
      body: '#' + (order.reference || '') + ' · ' + (order.name || '') + ' · ' + mode + pre,
      url: '/admin.html?tab=orders',
    });
    await Promise.all(blobs.map(async (b) => {
      try {
        const sub = await s.get(b.key, { type: 'json' });
        if (!sub) return;
        await webpush.sendNotification(sub, payload, { TTL: 1800 });
      } catch (err) {
        if (err && (err.statusCode === 404 || err.statusCode === 410)) {
          try { await s.delete(b.key); } catch (e2) {}
        }
      }
    }));
  } catch (e) {}
}
async function afterOrderHooks(order, verified) {
  // verified === true  -> Aufruf ist an einen echten Zahlungseingang gebunden
  //   (SumUp-Webhook / Reconcile nach PAID) bzw. der interne Schutz ist nicht aktiv.
  //   Nur dann werden Treue-/Umsatz-/Referral-Gutschriften gebucht (Schutz gegen
  //   Farming über den offenen order_confirmation-Endpunkt, Befund S1/S4).
  // Bestell-Alarm an Team-Geräte (parallel, blockiert nichts)
  sendOrderAlertPush(order).catch(() => {});
  // 0) Bestell-Archiv: Bestellung als abgeschlossen sichern (90 Tage, Admin-Einsicht).
  //    Bei Online-Zahlung existiert bereits ein "pending"-Eintrag aus sumup-checkout,
  //    der hier auf "completed" gehoben wird (inkl. checkoutId).
  let alreadyAccrued = false; // S5: pro Bestellung nur EINMAL gutschreiben (gegen Doppelbuchung durch Webhook+Reconcile)
  try {
    if (order.reference) {
      const os = blobStore('orders');
      const key = 'o:' + String(order.reference).replace(/[^A-Za-z0-9-]/g, '').slice(0, 60);
      const existing = await os.get(key, { type: 'json' });
      alreadyAccrued = !!(existing && existing.accrued);
      const raw = JSON.stringify(order);
      await os.setJSON(key, {
        status: 'completed',
        // "accrued" wird sofort mitgesetzt (vor der eigentlichen Gutschrift weiter unten),
        // damit ein zweiter, gleichzeitiger Aufruf die Gutschrift überspringt.
        accrued: (existing && existing.accrued) || (!!verified && !!order.email),
        createdAt: (existing && existing.createdAt) || new Date().toISOString(),
        completedAt: new Date().toISOString(),
        checkoutId: (existing && existing.checkoutId) || null,
        order: raw.length < 60000 ? order : { reference: order.reference, name: order.name, total: order.total, note: 'Bestellung zu groß für Archiv-Detail' },
        fstate: 'confirmed',
        fstateAt: { confirmed: new Date().toISOString() },
      });
    }
  } catch (e) {}

  // 1) Retargeting-Warteschlange: fällig in 7 Tagen.
  //    Erneute Bestellung überschreibt den Eintrag → Fälligkeit verschiebt sich,
  //    es wird also nur an Kunden gesendet, die nicht von selbst zurückkamen.
  try {
    if (order.email && !order.isTest) {
      const hash = crypto.createHash('sha256').update(order.email.toLowerCase().trim()).digest('hex');
      await blobStore('retarget').setJSON('q:' + hash, {
        email: order.email.trim(),
        name: order.name || '',
        orderAt: new Date().toISOString(),
        dueAt: new Date(Date.now() + RETARGET_DELAY_DAYS * 86400000).toISOString(),
      });
    }
  } catch (e) {}
  // 2) Persönlichen Gutschein entwerten + Statistik
  try {
    // Kunden-Treue (Server-Stempelkarte): Umsatz gutschreiben, Einlösung abziehen.
    // Läuft NUR für verifizierte Bestellungen (echter Zahlungseingang) und pro
    // Bestellung nur einmal – sonst könnte der offene order_confirmation-Endpunkt
    // zum Farmen von Guthaben missbraucht werden (Befund S1). Idempotent über den
    // "accrued"-Marker (Befund S5).
    if (order.email && verified && !alreadyAccrued) {
      try {
        const crypto2 = require('crypto');
        const custS = blobStore('customers');
        const ckey2 = 'c:' + crypto2.createHash('sha256').update(String(order.email).trim().toLowerCase()).digest('hex');
        const cust = (await custS.get(ckey2, { type: 'json' })) || {
          email: String(order.email).trim().toLowerCase(),
          name: '', phone: '', addresses: [], spent: 0, rewards: 0,
          tokens: {}, createdAt: new Date().toISOString(),
        };
        const base = typeof order.subtotal === 'number' ? order.subtotal
                   : (typeof order.total === 'number' ? order.total : 0);
        const isFirstOrder = !cust.lastOrderAt;

        // Empfehlungsprogramm: Erstbestellung mit gültigem Empfehlungs-Code?
        // → Werber bekommt 5 € auf die Stempelkarte (max. 10 Prämien, kein Selbst-Werben).
        if (isFirstOrder && !cust.referredBy && order.voucherCode && /^GRILL[A-Z0-9]{5}$/.test(String(order.voucherCode))) {
          try {
            const refIdx = await custS.get('ref:' + order.voucherCode, { type: 'json' });
            if (refIdx && refIdx.key && refIdx.key !== ckey2) {
              const referrer = await custS.get(refIdx.key, { type: 'json' });
              if (referrer && (referrer.referrals || 0) < 10) {
                referrer.rewards = (referrer.rewards || 0) + 1;
                referrer.referrals = (referrer.referrals || 0) + 1;
                await custS.setJSON(refIdx.key, referrer);
                cust.referredBy = order.voucherCode;
              }
            }
          } catch (e) {}
        }

        cust.spent = Math.round(((cust.spent || 0) + Math.max(0, base)) * 100) / 100;
        if (typeof order.loyaltyDiscount === 'number' && order.loyaltyDiscount > 0) {
          cust.rewards = Math.max(0, (cust.rewards || 0) - 1);
        }
        let levelUpTo = 0;
        while (cust.spent >= 100) {
          cust.rewards = (cust.rewards || 0) + 1;
          cust.cards = (cust.cards || 0) + 1;
          if (cust.cards >= 5) cust.rewards += 1; // ab Level 6: Doppel-Bonus je voller Karte (10 €)
          levelUpTo = Math.min(10, 1 + cust.cards);
          cust.spent = Math.round((cust.spent - 100) * 100) / 100;
        }
        // Kubi-Alarm ab Level 6 (Krönung bei 10 will inszeniert sein)
        if (levelUpTo >= 6) {
          try {
            const LN = ['Grill Rookie', 'Bun Boss', 'Patty Pro', 'Sauce Sensei', 'Cheese Melter', 'Flame Rider', 'Ember Elite', 'Grill Guru', 'Street Legende', 'King of Chill'];
            const tgToken = process.env.TELEGRAM_BOT_TOKEN, tgChat = process.env.TELEGRAM_CHAT_ID;
            if (tgToken && tgChat) {
              const crown = levelUpTo >= 10 ? '\u{1F451} ' : '\u{1F3C6} ';
              await fetch('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: tgChat, text: crown + (cust.name || cust.email) + ' ist jetzt Level ' + levelUpTo + ' \u00b7 ' + LN[levelUpTo - 1] + '! Ab Level 6 gibt es 10 \u20ac je voller Karte.' + (levelUpTo >= 10 ? ' Zeit f\u00fcr die Kr\u00f6nung!' : '') }),
              });
            }
          } catch (e) {}
        }
        cust.lastOrderAt = new Date().toISOString();
        // Umsatz-Aggregat (nur hier für normale Bestellungen – Giftcards zählen an ihren Abschluss-Stellen)
        try {
          const total0 = typeof order.total === 'number' ? order.total : 0;
          const isDel = order.mode === 'delivery';
          await addRevenue(blobStore('orders'), {
            oCount: 1, oTotal: total0,
            pickupCount: isDel ? 0 : 1, pickupTotal: isDel ? 0 : total0,
            deliveryCount: isDel ? 1 : 0, deliveryTotal: isDel ? total0 : 0,
          });
        } catch (e) {}
        // Bestellhistorie fürs Konto (letzte 5, mit Warenkorb-Schnappschuss für "Nochmal bestellen")
        try {
          const entry = {
            ref: order.reference || '',
            at: new Date().toISOString(),
            total: typeof order.total === 'number' ? order.total : null,
            mode: order.mode || 'pickup',
            snap: (order.cartSnapshot && typeof order.cartSnapshot === 'object'
                   && JSON.stringify(order.cartSnapshot).length < 6000) ? order.cartSnapshot : null,
          };
          cust.orders = [entry, ...(cust.orders || [])].slice(0, 5);
        } catch (e) {}
        await custS.setJSON(ckey2, cust);
      } catch (e) {}
    }

    // Kampagnen-Gutschein (Admin, Prefix c:): Einlösung zählen, ggf. Kunde vermerken
    if (order.voucherCode) {
      try {
        const cs = blobStore('vouchers');
        const ckey = 'c:' + String(order.voucherCode).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
        const c = await cs.get(ckey, { type: 'json' });
        if (c) {
          // S3: Limits serverseitig DURCHSETZEN. voucher-check.js ist nur beratend und
          // per Direktaufruf umgehbar – hier ist die verbindliche Backstop-Prüfung.
          const h = order.email
            ? require('crypto').createHash('sha256').update(String(order.email).trim().toLowerCase()).digest('hex')
            : null;
          const overGlobal = c.maxUses > 0 && (c.uses || 0) >= c.maxUses;
          let overPerCust = false;
          if (h && (c.maxPerCustomer > 0 || c.oncePerCustomer)) {
            const prev = c.usedBy && c.usedBy[h];
            const usedCount = typeof prev === 'number' ? prev : (prev ? 1 : 0);
            const lim = c.oncePerCustomer ? 1 : c.maxPerCustomer;
            overPerCust = usedCount >= lim;
          }
          if (overGlobal) {
            // Code ist ausgeschöpft: nicht weiter zählen, deaktivieren, Inhaber alarmieren.
            c.active = false;
            c.abuseFlaggedAt = new Date().toISOString();
            c.lastAbuseRef = order.reference || null;
            await cs.setJSON(ckey, c);
            try {
              const tgToken = process.env.TELEGRAM_BOT_TOKEN, tgChat = process.env.TELEGRAM_CHAT_ID;
              if (tgToken && tgChat) {
                await fetch('https://api.telegram.org/bot' + tgToken + '/sendMessage', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ chat_id: tgChat, text: '⚠️ Gutschein-Übernutzung: Code ' + (c.code || ckey.slice(2)) + ' war bereits ausgeschöpft (Bestellung ' + (order.reference || '?') + '). Code deaktiviert – bitte prüfen.' }),
                });
              }
            } catch (e3) {}
          } else if (overPerCust) {
            // Dieser Kunde hat sein Limit überschritten: nicht erneut zählen, Code bleibt für andere aktiv.
            c.lastPerCustAbuseAt = new Date().toISOString();
            c.lastPerCustAbuseRef = order.reference || null;
            await cs.setJSON(ckey, c);
          } else {
            c.uses = (c.uses || 0) + 1;
            c.lastRedeemedAt = new Date().toISOString();
            c.redeemedVia = 'checkout';
            if ((c.maxPerCustomer > 0 || c.oncePerCustomer) && h) {
              c.usedBy = c.usedBy || {};
              if (c.usedBy[h] !== undefined || Object.keys(c.usedBy).length < 5000) {
                const prev = c.usedBy[h];
                const count = typeof prev === 'number' ? prev : (prev ? 1 : 0);
                c.usedBy[h] = count + 1;
              }
            }
            // Gesamtlimit jetzt erreicht -> deaktivieren, damit voucher-check ihn künftig sperrt.
            if (c.maxUses > 0 && c.uses >= c.maxUses) c.active = false;
            await cs.setJSON(ckey, c);
            try {
              const ts = blobStore('track');
              const dayKey = 'd:' + new Date().toISOString().slice(0, 10);
              const data = (await ts.get(dayKey, { type: 'json' })) || {};
              data.voucher_redeemed = (data.voucher_redeemed || 0) + 1;
              await ts.setJSON(dayKey, data);
            } catch (e2) {}
          }
        }
      } catch (e) {}
    }
    if (order.voucherCode && /^[A-Z2-9]{8}$/.test(String(order.voucherCode))) {
      const vs = blobStore('vouchers');
      const key = 'v:' + String(order.voucherCode).toUpperCase();
      const v = await vs.get(key, { type: 'json' });
      if (v && !v.used) {
        v.used = true;
        v.usedAt = new Date().toISOString();
        v.orderRef = order.reference || null;
        await vs.setJSON(key, v);
        try {
          const a = blobStore('analytics');
          const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
          const data = (await a.get('day:' + day, { type: 'json' })) || {};
          data.voucher_redeemed = (data.voucher_redeemed || 0) + 1;
          await a.setJSON('day:' + day, data);
        } catch (e2) {}
      }
    }
  } catch (e) {}
}

// Helper: JSON response
const json = (statusCode, body, extraHeaders = {}) => ({
  statusCode,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extraHeaders,
  },
  body: JSON.stringify(body),
});

const html = (statusCode, htmlBody) => ({
  statusCode,
  headers: { 'Content-Type': 'text/html; charset=utf-8' },
  body: htmlBody,
});

// HTML-escape für E-Mail-Inhalte
function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPrice(num) {
  return Number(num).toFixed(2).replace('.', ',') + ' €';
}

// ============================================================
//  E-Mail-Templates
// ============================================================

function buildOrderConfirmationEmail(order) {
  const itemsHtml = (order.items || []).map(item => `
    <tr>
      <td style="padding:10px 14px;border-bottom:1px solid #eee;color:#333;">
        ${esc(item.name)} <span style="color:#888;font-size:13px;">×&nbsp;${item.qty}</span>
      </td>
      <td style="padding:10px 14px;border-bottom:1px solid #eee;text-align:right;color:#333;font-weight:600;">
        ${formatPrice(item.total)}
      </td>
    </tr>
  `).join('');

  const addressBlock = order.mode === 'delivery' && order.deliveryAddress
    ? `<p style="margin:8px 0;color:#555;">
         <strong>Lieferadresse:</strong><br>
         ${esc(order.deliveryAddress.street)}<br>
         ${esc(order.deliveryAddress.zip)} ${esc(order.deliveryAddress.city)}
       </p>`
    : `<p style="margin:8px 0;color:#555;">
         <strong>Abholung:</strong> Gütersloher Straße 122, 33649 Bielefeld
       </p>`;

  const subtotalRow = `
    <tr><td style="padding:8px 14px;color:#666;">Zwischensumme</td>
        <td style="padding:8px 14px;text-align:right;color:#666;">${formatPrice(order.subtotal)}</td></tr>`;
  const promoLabel = order.promo && order.promo.code
    ? `Rabatt (${order.promo.code}${order.promo.pct ? ' \u2212' + order.promo.pct + '%' : ''})`
    : 'Rabatt';
  const discountRow = order.discount > 0
    ? `<tr><td style="padding:8px 14px;color:#E85A24;">${promoLabel}</td>
           <td style="padding:8px 14px;text-align:right;color:#E85A24;">−${formatPrice(order.discount)}</td></tr>`
    : '';
  const loyaltyRow = order.loyaltyDiscount > 0
    ? `<tr><td style="padding:8px 14px;color:#E85A24;">Treuebonus</td>
           <td style="padding:8px 14px;text-align:right;color:#E85A24;">−${formatPrice(order.loyaltyDiscount)}</td></tr>`
    : '';
  const feeRow = order.deliveryFee > 0
    ? `<tr><td style="padding:8px 14px;color:#666;">Lieferung</td>
           <td style="padding:8px 14px;text-align:right;color:#666;">${formatPrice(order.deliveryFee)}</td></tr>`
    : '';
  const tipRow = order.tip > 0
    ? `<tr><td style="padding:8px 14px;color:#666;">Trinkgeld</td>
           <td style="padding:8px 14px;text-align:right;color:#666;">${formatPrice(order.tip)}</td></tr>`
    : '';
  const totalRow = `
    <tr><td style="padding:12px 14px;color:#000;font-weight:700;font-size:18px;border-top:2px solid #0A0A0A;">Gesamt</td>
        <td style="padding:12px 14px;text-align:right;color:#E85A24;font-weight:700;font-size:18px;border-top:2px solid #0A0A0A;">${formatPrice(order.total)}</td></tr>`;

  const statusBtn = order.reference ? `
    <tr><td colspan="2" style="padding:18px 14px 4px;text-align:center;">
      <a href="${statusPageUrl(order.reference)}" style="display:inline-block;background:#CC4715;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 26px;border-radius:10px;">Bestellstatus live verfolgen</a>
      <p style="margin:10px 0 0;font-size:11px;color:#8F8471;">Du siehst dort in Echtzeit, wann dein Essen fertig ist.</p>
    </td></tr>` : '';

  return {
    subject: `Deine Bestellung bei Grilln Chill (#${esc(order.reference)})`,
    html: `<!DOCTYPE html><html lang="de"><body style="margin:0;padding:0;background:#F5E9D0;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5E9D0;padding:30px 10px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
      <tr><td style="background:#0A0A0A;padding:30px 30px 20px;text-align:center;">
        <h1 style="color:#F5E9D0;margin:0;font-size:28px;letter-spacing:1px;">GRILL'N CHILL</h1>
        <p style="color:#E85A24;margin:6px 0 0;font-size:14px;letter-spacing:2px;">STREETFOOD MIT CHARAKTER</p>
      </td></tr>

      <tr><td style="padding:30px;">
        <h2 style="color:#0A0A0A;margin:0 0 8px;">Hi ${esc(order.name)}!</h2>
        <p style="color:#444;line-height:1.6;margin:0 0 20px;">
          ${order.scheduledFor
            ? 'Danke für deine Bestellung! Wir haben sie als Vorbestellung notiert und bereiten sie pünktlich frisch für dich zu.'
            : 'Danke für deine Bestellung! Wir haben sie erhalten und beginnen gleich mit der Zubereitung.'}
        </p>

        <div style="background:#FFF8E7;border-left:4px solid #6DBE45;padding:14px 18px;border-radius:6px;margin:20px 0;">
          <p style="margin:0;color:#444;font-size:14px;">
            <strong style="color:#6DBE45;">100 % Halal</strong> – Alle unsere Burger sind halal-zertifiziert.
          </p>
        </div>

        <h3 style="color:#0A0A0A;margin:24px 0 10px;border-bottom:2px solid #E85A24;padding-bottom:6px;">
          Deine Bestellung
        </h3>
        <p style="color:#888;font-size:13px;margin:0 0 10px;">
          Bestell-Nr.: <strong>#${esc(order.reference)}</strong>
        </p>

        <table width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;border:1px solid #eee;border-radius:8px;overflow:hidden;">
          ${itemsHtml}
          ${subtotalRow}
          ${discountRow}
          ${loyaltyRow}
          ${feeRow}
          ${tipRow}
          ${totalRow}${statusBtn}
        </table>

        ${addressBlock}

        ${order.note ? `<p style="margin:14px 0;padding:12px 16px;background:#F8F5EE;border-radius:6px;color:#555;font-size:14px;">
          <strong>Deine Nachricht:</strong> ${esc(order.note)}
        </p>` : ''}

        <p style="margin:22px 0 0;color:#888;font-size:13px;line-height:1.6;">
          Zufrieden mit Grilln Chill? Eine <a href="https://search.google.com/local/writereview?placeid=ChIJJ9h4Tk09ukcRAAFxrgGWsSc" style="color:#E85A24;font-weight:700;text-decoration:none;">Google-Bewertung</a> dauert 30 Sekunden und hilft uns riesig. Danke!
        </p>

        <p style="margin:14px 0;color:#555;">
          <strong>Zahlung:</strong> ${order.payment === 'sumup' ? 'Online bezahlt' : 'Vor Ort'}
        </p>

        ${order.scheduledFor
          ? `<div style="background:#0A0A0A;border-radius:8px;padding:18px;margin:24px 0;text-align:center;">
               <p style="color:#F5E9D0;margin:0;font-size:14px;">${order.mode === 'delivery' ? 'Lieferung' : 'Bereit zur Abholung'}</p>
               <p style="color:#E85A24;margin:6px 0 0;font-size:24px;font-weight:700;">${esc(order.scheduledFor)}</p>
             </div>`
          : (order.mode !== 'delivery' && order.pickupTime
            ? `<div style="background:#0A0A0A;border-radius:8px;padding:18px;margin:24px 0;text-align:center;">
                 <p style="color:#F5E9D0;margin:0;font-size:14px;">Abholung</p>
                 <p style="color:#E85A24;margin:6px 0 0;font-size:24px;font-weight:700;">${esc(order.pickupTime)}</p>
               </div>`
            : `<div style="background:#0A0A0A;border-radius:8px;padding:18px;margin:24px 0;text-align:center;">
                 <p style="color:#F5E9D0;margin:0;font-size:14px;">⏱ ${order.mode === 'delivery' ? 'Lieferzeit ca.' : 'Bereit zur Abholung in ca.'}</p>
                 <p style="color:#E85A24;margin:6px 0 0;font-size:24px;font-weight:700;">${order.mode === 'delivery' ? '30–45 Minuten' : '15–25 Minuten'}</p>
               </div>`)}

        <p style="color:#444;line-height:1.6;margin:18px 0;">
          Wir halten dich per E-Mail auf dem Laufenden, sobald sich der Status deiner Bestellung ändert.
        </p>

        <p style="color:#444;line-height:1.6;margin:18px 0;">
          Bei Fragen erreichst du uns unter
          <a href="tel:+4915118540604" style="color:#E85A24;text-decoration:none;font-weight:600;">+49&nbsp;151&nbsp;18&nbsp;54&nbsp;06&nbsp;04</a>
          oder per <a href="https://wa.me/4915118540604" style="color:#E85A24;text-decoration:none;font-weight:600;">WhatsApp</a>.
        </p>

        <p style="color:#444;line-height:1.6;margin:24px 0 0;">
          Bis gleich,<br>
          <strong>dein Grilln Chill Team</strong>
        </p>
      </td></tr>

      ${buildInvoiceBlock(order)}

      <tr><td style="background:#F8F5EE;padding:20px 30px;text-align:center;color:#888;font-size:12px;line-height:1.6;">
        Grilln Chill · Gütersloher Straße 122 · 33649 Bielefeld<br>
        <a href="https://grillnchill-foodtruck.de" style="color:#E85A24;text-decoration:none;">grillnchill-foodtruck.de</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`,
  };
}

function buildStatusUpdateEmail(order, status) {
  const statusInfo = {
    preparing: {
      emoji: '👨‍🍳',
      title: 'Wir bereiten deine Bestellung zu',
      message: 'Wir sind dran – deine Burger liegen frisch auf dem Grill.',
      eta: '15–20 Minuten',
      color: '#FFC93C',
    },
    on_the_way: {
      emoji: '🛵',
      title: 'Deine Bestellung ist unterwegs',
      message: 'Unser Bote ist mit deiner Bestellung losgefahren. In wenigen Minuten klingelt es bei dir!',
      eta: '5–15 Minuten',
      color: '#E85A24',
    },
    ready_for_pickup: {
      emoji: '✅',
      title: 'Deine Bestellung ist abholbereit',
      message: 'Komm vorbei und hol dir deine Burger – sie warten frisch und warm auf dich!',
      eta: 'Jetzt',
      color: '#6DBE45',
    },
    delivered: {
      emoji: '🎉',
      title: 'Guten Appetit!',
      message: 'Deine Bestellung ist angekommen – lass es dir schmecken! Eine Google-Bewertung dauert 30 Sekunden und hilft uns riesig.',
      eta: null,
      color: '#6DBE45',
    },
  };

  const info = statusInfo[status] || statusInfo.preparing;

  return {
    subject: `${info.title} (#${esc(order.reference)})`,
    html: `<!DOCTYPE html><html lang="de"><body style="margin:0;padding:0;background:#F5E9D0;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5E9D0;padding:30px 10px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
      <tr><td style="background:#0A0A0A;padding:24px;text-align:center;">
        <h1 style="color:#F5E9D0;margin:0;font-size:22px;letter-spacing:1px;">GRILL'N CHILL</h1>
      </td></tr>

      <tr><td style="padding:40px 30px;text-align:center;">
        <h2 style="color:#0A0A0A;margin:0 0 14px;font-size:26px;">${info.title}</h2>
        <p style="color:#444;line-height:1.6;font-size:16px;margin:0 0 24px;">
          ${info.message}
        </p>

        ${info.eta ? `
        <div style="background:${info.color};border-radius:10px;padding:20px;margin:20px 0;color:#0A0A0A;">
          <p style="margin:0;font-size:14px;">${status === 'ready_for_pickup' ? 'Bereit ab' : 'Voraussichtlich noch'}</p>
          <p style="margin:6px 0 0;font-size:22px;font-weight:700;">${info.eta}</p>
        </div>
        ` : ''}

        ${(status === 'delivered' || status === 'ready_for_pickup') ? `
        ${status === 'ready_for_pickup' ? `<p style="color:#666;font-size:14px;margin:24px 0 4px;">Wenn es dir geschmeckt hat: Eine Google-Bewertung dauert 30 Sekunden und hilft uns riesig.</p>` : ''}
        <a href="https://search.google.com/local/writereview?placeid=ChIJJ9h4Tk09ukcRAAFxrgGWsSc" style="display:inline-block;background:#E85A24;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;margin:12px 0 20px;">
          Bei Google bewerten
        </a>
        ` : ''}

        <p style="color:#888;font-size:13px;margin:30px 0 0;">
          Bestell-Nr.: <strong>#${esc(order.reference)}</strong><br>
          ${esc(order.name)} · ${formatPrice(order.total)}
        </p>
      </td></tr>

      <tr><td style="background:#F8F5EE;padding:20px 30px;text-align:center;color:#888;font-size:12px;line-height:1.6;">
        Bei Fragen: <a href="tel:+4915118540604" style="color:#E85A24;text-decoration:none;">+49&nbsp;151&nbsp;18&nbsp;54&nbsp;06&nbsp;04</a><br>
        Grilln Chill · Gütersloher Straße 122 · 33649 Bielefeld
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`,
  };
}

function buildOwnerNotificationEmail(order, statusUpdateBaseUrl, statusToken) {
  const itemsHtml = (order.items || []).map(item =>
    `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee;">${esc(item.name)} × ${item.qty}</td>
         <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;">${formatPrice(item.total)}</td></tr>`
  ).join('');

  const ref = encodeURIComponent(order.reference);
  const tok = encodeURIComponent(statusToken);
  const orderJson = encodeURIComponent(JSON.stringify({
    reference: order.reference,
    name: order.name,
    email: order.email,
    total: order.total,
  }));

  const statusLink = (status) =>
    `${statusUpdateBaseUrl}/status-update?ref=${ref}&status=${status}&token=${tok}&order=${orderJson}`;

  const buttons = order.mode === 'delivery'
    ? `
      <a href="${statusLink('preparing')}" style="display:inline-block;background:#FFC93C;color:#0A0A0A;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:700;margin:6px 4px;">👨‍🍳 Zubereitung</a>
      <a href="${statusLink('on_the_way')}" style="display:inline-block;background:#E85A24;color:#fff;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:700;margin:6px 4px;">🛵 Unterwegs</a>
      <a href="${statusLink('delivered')}" style="display:inline-block;background:#6DBE45;color:#fff;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:700;margin:6px 4px;">✅ Geliefert</a>
    `
    : `
      <a href="${statusLink('preparing')}" style="display:inline-block;background:#FFC93C;color:#0A0A0A;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:700;margin:6px 4px;">👨‍🍳 Zubereitung</a>
      <a href="${statusLink('ready_for_pickup')}" style="display:inline-block;background:#6DBE45;color:#fff;padding:14px 22px;border-radius:8px;text-decoration:none;font-weight:700;margin:6px 4px;">✅ Abholbereit</a>
    `;

  return {
    subject: `${order.isTest ? '🔧 [TEST] ' : '🔔 '}NEUE BESTELLUNG${order.paymentPending ? ' (Online)' : ''} #${esc(order.reference)} – ${formatPrice(order.total)}`,
    html: `<!DOCTYPE html><html lang="de"><body style="margin:0;padding:20px;background:#0A0A0A;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;color:#F5E9D0;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:700px;margin:0 auto;background:#141414;border-radius:12px;overflow:hidden;">
  ${order.isTest ? `<tr><td style="background:#FFC93C;padding:12px 24px;text-align:center;"><strong style="color:#0A0A0A;font-size:15px;">🔧 TESTBESTELLUNG – kein echter Auftrag (Gesamtbetrag auf Test-Wert reduziert)</strong></td></tr>` : ''}
  ${order.paymentPending ? `<tr><td style="background:#FFC93C;padding:12px 24px;text-align:center;"><strong style="color:#0A0A0A;font-size:14px;line-height:1.5;display:block;">🟠 Online-Zahlung wird gerade abgeschlossen.<br>Warte auf die ✅-Bestätigungsmail (oder schau in deine SumUp-App), bevor du zubereitest.</strong></td></tr>` : ''}
  <tr><td style="background:linear-gradient(135deg,#E85A24,#FF7A3D);padding:20px 24px;">
    <h1 style="margin:0;font-size:22px;color:#fff;">${order.isTest ? '🔧 Test-Bestellung' : '🔔 Neue Bestellung'}</h1>
    <p style="margin:4px 0 0;color:#fff;opacity:0.9;font-size:14px;">${new Date().toLocaleString('de-DE',{timeZone:'Europe/Berlin'})}</p>
  </td></tr>

  <tr><td style="padding:24px;">
    <h2 style="margin:0 0 6px;color:#E85A24;">#${esc(order.reference)}</h2>
    <p style="margin:0 0 4px;font-size:18px;font-weight:700;color:#F5E9D0;">${esc(order.name)}</p>
    <p style="margin:0 0 16px;color:#aaa;font-size:14px;">
      ${order.phone ? `📞 <a href="tel:${esc(order.phone)}" style="color:#FFC93C;text-decoration:none;">${esc(order.phone)}</a> · ` : ''}
      ✉️ <a href="mailto:${esc(order.email)}" style="color:#FFC93C;text-decoration:none;">${esc(order.email)}</a>
    </p>
    ${order.customerOrderNo ? `<p style="margin:0 0 16px;"><span style="display:inline-block;background:#0A0A0A;border:1px solid #2A2520;border-radius:6px;padding:6px 12px;color:#FFC93C;font-size:13px;font-weight:700;">Stammkunden-Zähler: ${order.customerOrderNo}. Bestellung <span style="color:#888;font-weight:400;">(geräte-lokal gezählt)</span></span></p>` : ''}
    ${order.loyaltyProgress ? `<p style="margin:0 0 16px;"><span style="display:inline-block;background:#0A0A0A;border:1px solid #2A2520;border-radius:6px;padding:6px 12px;color:#6DBE45;font-size:13px;font-weight:700;">Treuekarte: ${formatPrice(order.loyaltyProgress.spent)} / ${formatPrice(order.loyaltyProgress.goal)}${order.loyaltyProgress.earned > 0 ? ' &middot; <span style="color:#FFC93C;">★ Treuebonus erreicht!</span>' : ''}${order.loyaltyProgress.applied && order.loyaltyDiscount ? ` &middot; <span style="color:#FFC93C;">Bonus eingelöst (−${formatPrice(order.loyaltyDiscount)})</span>` : ''} <span style="color:#888;font-weight:400;">(geräte-lokal)</span></span></p>` : ''}

    <div style="background:#0A0A0A;padding:14px 16px;border-radius:8px;margin:16px 0;border-left:4px solid ${order.mode === 'delivery' ? '#E85A24' : '#6DBE45'};">
      <strong style="color:#F5E9D0;">${order.mode === 'delivery' ? '🛵 LIEFERUNG' : '🚶 ABHOLUNG'}</strong>
      ${order.mode === 'delivery' && order.deliveryAddress ? `
        <p style="margin:6px 0 0;color:#ccc;">
          ${esc(order.deliveryAddress.street)}<br>
          ${esc(order.deliveryAddress.zip)} ${esc(order.deliveryAddress.city)}
        </p>
      ` : ''}
    </div>

    ${order.scheduledFor
      ? `<div style="background:#FFC93C;color:#0A0A0A;padding:12px 16px;border-radius:8px;margin:12px 0;font-weight:700;">🕒 VORBESTELLUNG – bereitstellen für: ${esc(order.scheduledFor)}</div>`
      : (order.pickupTime ? `<p style="margin:8px 0;color:#ccc;font-size:14px;"><strong>🕒 Abholzeit:</strong> ${esc(order.pickupTime)}</p>` : '')}

    <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;background:#0A0A0A;border-radius:8px;color:#ccc;">
      ${itemsHtml.replace(/border-bottom:1px solid #eee/g, 'border-bottom:1px solid #2A2520')}
      ${order.loyaltyDiscount > 0 ? `<tr><td style="padding:8px 12px;color:#6DBE45;">Treuebonus</td>
          <td style="padding:8px 12px;text-align:right;color:#6DBE45;">−${formatPrice(order.loyaltyDiscount)}</td></tr>` : ''}
      ${order.tip > 0 ? `<tr><td style="padding:8px 12px;color:#FFC93C;">Trinkgeld</td>
          <td style="padding:8px 12px;text-align:right;color:#FFC93C;">${formatPrice(order.tip)}</td></tr>` : ''}
      <tr><td style="padding:12px;font-weight:700;color:#F5E9D0;border-top:2px solid #E85A24;">GESAMT</td>
          <td style="padding:12px;text-align:right;font-weight:700;color:#E85A24;border-top:2px solid #E85A24;font-size:18px;">${formatPrice(order.total)}</td></tr>
    </table>

    <p style="margin:8px 0;color:#ccc;font-size:14px;">
      <strong>Zahlung:</strong> ${order.paymentPending ? '🟠 Online (SumUp) – Zahlung wird gerade abgeschlossen' : (order.payment === 'sumup' ? '✅ Online bezahlt (SumUp)' : '💶 Bei Lieferung/Abholung')}
    </p>

    ${order.note ? `<div style="background:#FFC93C;color:#0A0A0A;padding:10px 14px;border-radius:6px;margin:12px 0;">
      <strong>📝 Notiz vom Kunden:</strong> ${esc(order.note)}
    </div>` : ''}

    <div style="margin:24px 0 8px;text-align:center;">
      <p style="color:#888;font-size:13px;margin:0 0 14px;">Kunde benachrichtigen mit einem Klick:</p>
      ${buttons}
    </div>

    <p style="margin:20px 0 0;text-align:center;color:#666;font-size:12px;">
      Diese Buttons senden automatisch eine Status-E-Mail an den Kunden.
    </p>
  </td></tr>
  ${order.company ? `<tr><td style="padding:0 0 8px;">
    <p style="margin:0 0 6px;color:#888;font-size:12px;text-align:center;">
      Firmenkunde &ndash; diese Rechnung ging identisch an den Kunden:
    </p></td></tr>` : ''}
  ${buildInvoiceBlock(order)}
</table>
</body></html>`,
  };
}

// ============================================================
//  Catering-E-Mail-Templates
// ============================================================

function buildCateringEmail(c) {
  return {
    subject: `🚛 NEUE CATERING-ANFRAGE – ${esc(c.name)} (${esc(c.guests)} Gäste)`,
    html: `<!DOCTYPE html><html lang="de"><body style="margin:0;padding:20px;background:#0A0A0A;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;color:#F5E9D0;">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#141414;border-radius:12px;overflow:hidden;">
  <tr><td style="background:linear-gradient(135deg,#E85A24,#FF7A3D);padding:20px 24px;">
    <h1 style="margin:0;font-size:22px;color:#fff;">🚛 Neue Catering-Anfrage</h1>
    <p style="margin:4px 0 0;color:#fff;opacity:0.9;font-size:14px;">${new Date().toLocaleString('de-DE',{timeZone:'Europe/Berlin'})}</p>
  </td></tr>
  <tr><td style="padding:24px;">
    <p style="margin:0 0 4px;font-size:18px;font-weight:700;color:#F5E9D0;">${esc(c.name)}</p>
    <p style="margin:0 0 16px;color:#aaa;font-size:14px;">
      ✉️ <a href="mailto:${esc(c.email)}" style="color:#FFC93C;text-decoration:none;">${esc(c.email)}</a>
      ${c.phone ? ` · 📞 <a href="tel:${esc(c.phone)}" style="color:#FFC93C;text-decoration:none;">${esc(c.phone)}</a>` : ''}
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#0A0A0A;border-radius:8px;color:#ccc;">
      <tr><td style="padding:10px 14px;border-bottom:1px solid #2A2520;"><strong style="color:#F5E9D0;">📅 Datum</strong></td>
          <td style="padding:10px 14px;border-bottom:1px solid #2A2520;text-align:right;">${esc(c.date)}</td></tr>
      <tr><td style="padding:10px 14px;border-bottom:1px solid #2A2520;"><strong style="color:#F5E9D0;">👥 Gäste</strong></td>
          <td style="padding:10px 14px;border-bottom:1px solid #2A2520;text-align:right;">${esc(c.guests)}</td></tr>
        ${c.package ? `<tr><td style="padding:10px 14px;border-bottom:1px solid #2A2520;color:#9A8E7A;">Wunsch-Paket</td>
          <td style="padding:10px 14px;border-bottom:1px solid #2A2520;text-align:right;">${esc(c.package)}</td></tr>` : ''}
        ${c.contactPref ? `<tr><td style="padding:10px 14px;border-bottom:1px solid #2A2520;"><strong style="color:#F5E9D0;">📲 Bevorzugter Kontakt</strong></td>
          <td style="padding:10px 14px;border-bottom:1px solid #2A2520;text-align:right;">${esc(c.contactPref)}</td></tr>` : ''}
      <tr><td style="padding:10px 14px;"><strong style="color:#F5E9D0;">📍 Ort</strong></td>
          <td style="padding:10px 14px;text-align:right;">${esc(c.location)}</td></tr>
    </table>
    ${c.msg ? `<div style="background:#FFC93C;color:#0A0A0A;padding:12px 16px;border-radius:6px;margin:16px 0;">
      <strong>📝 Nachricht:</strong><br>${esc(c.msg)}
    </div>` : ''}
    <p style="margin:20px 0 0;text-align:center;">
      <a href="mailto:${esc(c.email)}?subject=Dein%20Catering-Angebot%20von%20Grilln%20Chill" style="display:inline-block;background:#6DBE45;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;">✉️ Direkt antworten</a>
    </p>
  </td></tr>
</table>
</body></html>`,
  };
}

function buildCateringConfirmationEmail(c) {
  return {
    subject: `Deine Catering-Anfrage bei Grilln Chill`,
    html: `<!DOCTYPE html><html lang="de"><body style="margin:0;padding:0;background:#F5E9D0;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5E9D0;padding:30px 10px;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
      <tr><td style="background:#0A0A0A;padding:30px;text-align:center;">
        <h1 style="color:#F5E9D0;margin:0;font-size:26px;letter-spacing:1px;">GRILL'N CHILL</h1>
        <p style="color:#E85A24;margin:6px 0 0;font-size:13px;letter-spacing:2px;">FOODTRUCK CATERING</p>
      </td></tr>
      <tr><td style="padding:30px;">
        <h2 style="color:#0A0A0A;margin:0 0 8px;">Hi ${esc(c.name.split(' ')[0])} 👋</h2>
        <p style="color:#444;line-height:1.6;margin:0 0 20px;">
          Vielen Dank für deine Catering-Anfrage! Wir haben sie erhalten und melden uns
          innerhalb von 24 Stunden mit einem unverbindlichen Angebot bei dir.
        </p>
        <h3 style="color:#0A0A0A;margin:24px 0 10px;border-bottom:2px solid #E85A24;padding-bottom:6px;">Deine Anfrage im Überblick</h3>
        <table width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;border:1px solid #eee;border-radius:8px;overflow:hidden;">
          <tr><td style="padding:10px 14px;border-bottom:1px solid #eee;color:#888;">Datum</td>
              <td style="padding:10px 14px;border-bottom:1px solid #eee;text-align:right;color:#333;font-weight:600;">${esc(c.date)}</td></tr>
          <tr><td style="padding:10px 14px;border-bottom:1px solid #eee;color:#888;">Gäste</td>
              <td style="padding:10px 14px;border-bottom:1px solid #eee;text-align:right;color:#333;font-weight:600;">${esc(c.guests)}</td></tr>
            ${c.package ? `<tr><td style="padding:10px 14px;border-bottom:1px solid #eee;color:#888;">Wunsch-Paket</td>
              <td style="padding:10px 14px;border-bottom:1px solid #eee;text-align:right;color:#333;font-weight:600;">${esc(c.package)}</td></tr>` : ''}
          <tr><td style="padding:10px 14px;color:#888;">Ort</td>
              <td style="padding:10px 14px;text-align:right;color:#333;font-weight:600;">${esc(c.location)}</td></tr>
        </table>
        <p style="color:#444;line-height:1.6;margin:18px 0;">
          Bei dringenden Fragen erreichst du uns unter
          <a href="tel:+4915118540604" style="color:#E85A24;text-decoration:none;font-weight:600;">+49&nbsp;151&nbsp;18&nbsp;54&nbsp;06&nbsp;04</a>.
        </p>
        <p style="color:#444;line-height:1.6;margin:24px 0 0;">
          Bis bald,<br><strong>dein Grilln Chill Team</strong> 🍔
        </p>
      </td></tr>
      <tr><td style="background:#F8F5EE;padding:20px 30px;text-align:center;color:#888;font-size:12px;line-height:1.6;">
        Grilln Chill · Gütersloher Straße 122 · 33649 Bielefeld<br>
        <a href="https://grillnchill-foodtruck.de" style="color:#E85A24;text-decoration:none;">grillnchill-foodtruck.de</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`,
  };
}

// Generiert signierte Status-Links für eine Bestellung (für WhatsApp)
function buildStatusLinks(order, siteUrl, statusSecret) {  const ref = encodeURIComponent(order.reference);
  const tok = encodeURIComponent(statusSecret);
  const orderJson = encodeURIComponent(JSON.stringify({
    reference: order.reference,
    name: order.name,
    email: order.email,
    total: order.total,
  }));
  const link = (status) =>
    `${siteUrl}/status-update?ref=${ref}&status=${status}&token=${tok}&order=${orderJson}`;

  // Je nach Modus unterschiedliche Status
  if (order.mode === 'delivery') {
    return {
      preparing:  link('preparing'),
      on_the_way: link('on_the_way'),
      delivered:  link('delivered'),
    };
  }
  return {
    preparing:        link('preparing'),
    ready_for_pickup: link('ready_for_pickup'),
    delivered:        link('delivered'),
  };
}

// ============================================================
//  Brevo API-Aufruf
// ============================================================

async function sendViaBreve(apiKey, senderEmail, senderName, recipient, subject, htmlBody, attachments) {
  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'accept': 'application/json',
      'api-key': apiKey,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sender: { email: senderEmail, name: senderName },
      to: [{ email: recipient.email, name: recipient.name || '' }],
      subject,
      htmlContent: htmlBody,
      // Anhaenge (Rechnung als PDF + XRechnung). Brevo erwartet Base64.
      ...(attachments && attachments.length ? { attachment: attachments } : {}),
    }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Brevo error ${response.status}: ${data?.message || data?.code || 'Unknown'}`);
  }
  return data;
}

// ============================================================
//  Handler
// ============================================================

// --- Telegram-Bestellalarm (optional, via Env-Variablen TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID) ---
async function sendTelegram(order) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return; // nicht konfiguriert → still überspringen
  const e = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const L = [];
  L.push(`<b>NEUE BESTELLUNG</b>  #${e(order.reference)}`);
  if (order.paymentPending) L.push('[Online-Zahlung wird noch abgeschlossen]');
  L.push('');
  L.push(`<b>${e(order.name)}</b>`);
  if (order.phone) L.push(`Tel: ${e(order.phone)}`);
  if (order.mode === 'delivery') {
    L.push('Lieferung');
    if (order.deliveryAddress) L.push(`${e(order.deliveryAddress.street)}, ${e(order.deliveryAddress.zip)} ${e(order.deliveryAddress.city)}`);
  } else {
    L.push('Abholung');
  }
  if (order.scheduledFor) L.push(`Vorbestellung: ${e(order.scheduledFor)}`);
  else if (order.pickupTime) L.push(`Zeit: ${e(order.pickupTime)}`);
  L.push('');
  (order.items || []).forEach(it => L.push(`• ${it.qty}× ${e(it.name)}`));
  L.push('');
  if (order.discount > 0) {
    const pl = order.promo && order.promo.code ? ` (${order.promo.code}${order.promo.pct ? ' −' + order.promo.pct + '%' : ''})` : '';
    L.push(`Rabatt${pl}: -${formatPrice(order.discount)}`);
  }
  if (order.loyaltyDiscount > 0) L.push(`Treuebonus: -${formatPrice(order.loyaltyDiscount)}`);
  if (order.tip > 0) L.push(`Trinkgeld: ${formatPrice(order.tip)}`);
  L.push(`<b>Gesamt: ${formatPrice(order.total)}</b>`);
  L.push(`Zahlung: ${order.payment === 'sumup' ? (order.paymentPending ? 'Online (ausstehend)' : 'Online bezahlt') : 'Bar/EC vor Ort'}`);
  if (order.note) L.push(`Notiz: ${e(order.note)}`);
  if (order.customerOrderNo) L.push(`Stammkunden-Zähler: ${order.customerOrderNo}. Bestellung`);
  if (order.loyaltyProgress) {
    let lp = `Treuekarte: ${formatPrice(order.loyaltyProgress.spent)} / ${formatPrice(order.loyaltyProgress.goal)}`;
    if (order.loyaltyProgress.earned > 0) lp += ' · Treuebonus erreicht!';
    if (order.loyaltyProgress.applied && order.loyaltyDiscount) lp += ` · Bonus eingelöst (−${formatPrice(order.loyaltyDiscount)})`;
    L.push(lp);
  }
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: L.join('\n'), parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch (err) {
    // Telegram darf eine Bestellung niemals blockieren
  }
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
  const apiKey      = process.env.BREVO_API_KEY || '';
  const senderEmail = process.env.BREVO_SENDER_EMAIL || '';
  const senderName  = process.env.BREVO_SENDER_NAME || 'Grilln Chill';
  const ownerEmail  = process.env.OWNER_EMAIL || '';
  const statusSecret = process.env.STATUS_UPDATE_SECRET || '';
  const siteUrl     = process.env.URL || 'https://grillnchill-foodtruck.de';

  // CORS Preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }, body: '' };
  }

  // GET: Status-Seite
  if (event.httpMethod === 'GET') {
    const apiKeySet    = apiKey.length > 10;
    const senderSet    = senderEmail.includes('@');
    const ownerSet     = ownerEmail.includes('@');
    const secretSet    = statusSecret.length >= 10;
    const tgToken      = process.env.TELEGRAM_BOT_TOKEN || '';
    const tgChat       = process.env.TELEGRAM_CHAT_ID || '';
    const telegramSet  = tgToken.length > 20 && tgChat.length > 0;
    const allOk        = apiKeySet && senderSet && ownerSet && secretSet;

    return html(200, `<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8"><title>E-Mail Backend Status</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0A0A0A;color:#F5E9D0;margin:0;padding:2rem;line-height:1.6}
  .box{max-width:600px;margin:2rem auto;background:#141414;border:1px solid #2A2520;border-radius:14px;padding:2rem}
  h1{color:#F5E9D0;margin:0 0 1.5rem}
  .row{display:flex;justify-content:space-between;padding:0.7rem 0;border-bottom:1px solid #2A2520}
  .ok{color:#6DBE45;font-weight:700}
  .fail{color:#E04848;font-weight:700}
  .summary{margin-top:1.5rem;padding:1rem;border-radius:8px;font-weight:700;text-align:center}
  .summary.ok{background:rgba(109,190,69,0.12);color:#6DBE45;border:1px solid #6DBE45}
  .summary.fail{background:rgba(224,72,72,0.12);color:#E04848;border:1px solid #E04848}
  small{color:#9A8E7A}
  code{background:#252220;padding:2px 6px;border-radius:4px;font-size:0.85em}
</style></head><body><div class="box">
<h1>✉️ E-Mail Backend Status (Brevo)</h1>
<div class="row"><span>BREVO_API_KEY gesetzt</span><span class="${apiKeySet?'ok':'fail'}">${apiKeySet?'✓ JA':'✗ NEIN'}</span></div>
<div class="row"><span>BREVO_SENDER_EMAIL</span><span class="${senderSet?'ok':'fail'}">${senderSet?esc(senderEmail):'✗ NEIN'}</span></div>
<div class="row"><span>BREVO_SENDER_NAME</span><span class="ok">${esc(senderName)}</span></div>
<div class="row"><span>OWNER_EMAIL</span><span class="${ownerSet?'ok':'fail'}">${ownerSet?esc(ownerEmail):'✗ NEIN'}</span></div>
<div class="row"><span>STATUS_UPDATE_SECRET gesetzt</span><span class="${secretSet?'ok':'fail'}">${secretSet?'✓ JA':'✗ NEIN (mind. 10 Zeichen)'}</span></div>
<div class="row"><span>Telegram-Alarm <small>(optional)</small></span><span class="${telegramSet?'ok':'fail'}">${telegramSet?'✓ aktiv':'– nicht konfiguriert'}</span></div>
<div class="summary ${allOk?'ok':'fail'}">${allOk
    ? '✓ Alles bereit. E-Mails werden bei Bestellungen versendet.'
    : '✗ Konfiguration unvollständig. Bitte in Netlify alle Environment Variables setzen.'}</div>
<p style="margin-top:1.5rem;color:#9A8E7A;font-size:0.85rem">
  Endpunkt-URL: <code>/.netlify/functions/send-email</code><br>
  Status-Update-URL (intern): <code>${siteUrl}/status-update?...</code>
</p>
</div></body></html>`);
  }

  // POST: E-Mail versenden
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  if (!apiKey || !senderEmail || !ownerEmail || !statusSecret) {
    return json(500, {
      error: 'E-Mail-Backend nicht konfiguriert',
      hint: 'Bitte BREVO_API_KEY, BREVO_SENDER_EMAIL, OWNER_EMAIL und STATUS_UPDATE_SECRET in Netlify setzen.',
    });
  }

  let input;
  try {
    input = JSON.parse(event.body || '{}');
  } catch (e) {
    return json(400, { error: 'Invalid JSON' });
  }

  const { type } = input;
  if (!type) {
    return json(400, { error: 'Missing type' });
  }

  // Catering-Anfrage hat andere Struktur als Bestellungen
  if (type === 'catering_request') {
    const c = input.catering;
    if (!c || !c.email || !c.name) {
      return json(400, { error: 'Missing catering fields', hint: 'catering.name und catering.email sind Pflicht' });
    }

    // Cloudflare Turnstile serverseitig verifizieren (nur wenn TURNSTILE_SECRET gesetzt)
    const turnstileSecret = process.env.TURNSTILE_SECRET || '';
    if (turnstileSecret) {
      const token = input.turnstileToken || '';
      if (!token) {
        return json(400, { error: 'Bot-Verifizierung fehlt', hint: 'Turnstile-Token nicht übermittelt' });
      }
      try {
        const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret: turnstileSecret, response: token }),
        });
        const verifyData = await verifyRes.json().catch(() => null);
        if (!verifyData || !verifyData.success) {
          return json(403, { error: 'Bot-Verifizierung fehlgeschlagen', hint: 'Turnstile-Check nicht bestanden' });
        }
      } catch (err) {
        return json(502, { error: 'Turnstile-Verifizierung fehlgeschlagen', detail: err.message });
      }
    }

    // Sicherheitsnetz: Anfrage IMMER zuerst in Netlify Blobs ablegen (Store "catering"),
    // damit sie auch bei E-Mail-Problemen im Admin-Panel (Tab "Catering") auffindbar bleibt.
    let cateringKey = null;
    try {
      const cs = blobStore('catering');
      cateringKey = 'c:' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
      await cs.setJSON(cateringKey, {
        name: c.name, email: c.email, phone: c.phone || '', date: c.date || '',
        guests: c.guests || '', location: c.location || '', package: c.package || '',
        contactPref: c.contactPref || '', msg: c.msg || '',
        receivedAt: new Date().toISOString(), emailSent: false, done: false,
      });
    } catch (e) { cateringKey = null; /* Blob-Fehler blockiert die Anfrage nicht */ }

    let mailError = null;
    try {
      const ownerMail = buildCateringEmail(c);
      const customerMail = buildCateringConfirmationEmail(c);
      await Promise.all([
        sendViaBreve(apiKey, senderEmail, senderName,
          { email: ownerEmail, name: 'Grilln Chill' }, ownerMail.subject, ownerMail.html),
        sendViaBreve(apiKey, senderEmail, senderName,
          { email: c.email, name: c.name }, customerMail.subject, customerMail.html),
      ]);
    } catch (err) { mailError = err; }

    if (!mailError && cateringKey) {
      try {
        const cs = blobStore('catering');
        const rec = await cs.get(cateringKey, { type: 'json' });
        if (rec) { rec.emailSent = true; await cs.setJSON(cateringKey, rec); }
      } catch (e) { /* Statusflag ist nice-to-have */ }
    }

    if (!mailError) return json(200, { sent: 2, type, stored: !!cateringKey });
    // Mail fehlgeschlagen, aber gespeichert → Anfrage ist angekommen, Besucher bekommt Erfolg
    if (cateringKey) return json(200, { sent: 0, type, stored: true });
    return json(502, { error: 'Catering-Mail fehlgeschlagen', detail: mailError.message });
  }

    // Type: Geschenkgutschein nach Online-Kauf – Code an den Käufer + Telegram an den Betreiber
    if (type === 'giftcard') {
    try {
      const gift = input.gift || {};
      if (!gift.email || !gift.code) return json(400, { error: 'missing_gift_data' });
      const amountStr = formatPrice(gift.amount || 0);
      const validStr = gift.validUntil ? gift.validUntil.split('-').reverse().join('.') : '';
      const hello = gift.buyerName ? esc(gift.buyerName) : 'Burger-Fan';
      const forLine = gift.recipientName
        ? `<p style="margin:0 0 6px;color:#555;">Für: <strong>${esc(gift.recipientName)}</strong></p>`
        : '';
      const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;background:#0F0D0A;border-radius:14px;overflow:hidden;">
    <div style="background:#CC4715;padding:22px 28px;">
      <div style="font-size:20px;font-weight:800;color:#fff;">GRILL'N CHILL</div>
      <div style="font-size:12px;color:#FFD9C4;letter-spacing:1px;">DEIN GESCHENKGUTSCHEIN</div>
    </div>
    <div style="padding:28px;background:#fff;">
      <p style="margin:0 0 14px;color:#333;">Hey ${hello}, danke für deinen Kauf! Hier ist dein Gutschein:</p>
      <div style="border:2px dashed #CC4715;border-radius:12px;padding:22px;text-align:center;margin:0 0 16px;background:#FFF8F4;">
        <div style="font-size:13px;color:#996;letter-spacing:1px;margin-bottom:6px;">GUTSCHEIN-CODE</div>
        <div style="font-size:30px;font-weight:800;letter-spacing:3px;color:#CC4715;font-family:Consolas,Menlo,monospace;">${esc(gift.code)}</div>
        <div style="font-size:22px;font-weight:800;color:#333;margin-top:8px;">${amountStr}</div>
        ${forLine}
      </div>
      <p style="margin:0 0 8px;color:#333;font-weight:700;">So wird er eingelöst:</p>
      <ol style="margin:0 0 16px;padding-left:20px;color:#555;font-size:14px;line-height:1.7;">
        <li>Auf <a href="${siteUrl}" style="color:#CC4715;">grillnchill-foodtruck.de</a> Lieblingsburger in den Warenkorb legen</li>
        <li>Im Warenkorb den Code <strong>${esc(gift.code)}</strong> ins Gutschein-Feld eintippen</li>
        <li>Abholen oder liefern lassen – fertig!</li>
      </ol>
      <p style="margin:0;color:#888;font-size:12px;line-height:1.6;">
        Einlösbar online ab einem Bestellwert von ${amountStr} · einmalig gültig · keine Barauszahlung
        ${validStr ? `· gültig bis ${validStr}` : ''} · Kauf-Referenz: ${esc(gift.reference || '')}
      </p>
    </div>
    <div style="padding:14px 28px;background:#0F0D0A;color:#8F8471;font-size:11px;">
      Grill'n Chill Yildiz und Öztas GbR · Gütersloher Straße 122, 33649 Bielefeld
    </div>
  </div>`;
      await sendViaBreve(apiKey, senderEmail, senderName,
        { email: gift.email, name: gift.buyerName || '' },
        `Dein Grill'n Chill Geschenkgutschein über ${amountStr}`,
        html);
      // Betreiber-Info via Telegram (best effort)
      try {
        const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
        if (token && chatId) {
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, parse_mode: 'HTML',
              text: `\u{1F381} <b>GUTSCHEIN VERKAUFT</b>\n${amountStr} \u00b7 Code ${gift.code}\nK\u00e4ufer: ${String(gift.buyerName || '').replace(/[<>]/g,'') || '-'} (${gift.email})${gift.recipientName ? '\nF\u00fcr: ' + String(gift.recipientName).replace(/[<>]/g,'') : ''}` }),
          });
        }
      } catch (e) {}
      return json(200, { sent: 1, type });
    } catch (err) {
      return json(502, { error: 'Gutschein-Mail fehlgeschlagen', detail: err.message });
    }
  }

  const order = input.order;
  if (!order || !order.email || !order.reference) {
    return json(400, { error: 'Missing required fields', hint: 'order.email und order.reference sind Pflicht' });
  }

  try {
    // Type 1: Bestellbestätigung an Kunde + Notification an Pasquale
    if (type === 'order_confirmation') {
      // Idempotenz: Webhook, Kunden-Rückkehr und 5-Min-Abgleich können sich
      // überlappen – benachrichtigt wird pro Bestellung genau EINMAL.
      try {
        if (order.reference) {
          const k = 'o:' + String(order.reference).replace(/[^A-Za-z0-9-]/g, '').slice(0, 60);
          const existing = await blobStore('orders').get(k, { type: 'json' });
          if (existing && existing.status === 'completed') {
            const statusLinks = buildStatusLinks(order, siteUrl, statusSecret);
            return json(200, { sent: 0, duplicate: true, type, statusLinks });
          }
        }
      } catch (e) {}

      // Firmenkunden bekommen eine Rechnung. Die Nummer wird hier vergeben –
      // nach der Doppelt-Prüfung oben, also genau einmal je Bestellung.
      if (order.company) {
        try {
          order.invoiceNo = await nextInvoiceNo();
          order.invoiceDate = deDate();
          order.serviceDate = deDate();
          // Ablegen fürs Admin-Tool. Rechnungen sind aufbewahrungspflichtig
          // (§ 147 AO, 8 Jahre) – deshalb kein automatisches Löschen wie bei
          // den Bestelldaten nach 90 Tagen.
          try {
            await blobStore('invoices').setJSON('inv:' + order.invoiceNo, {
              invoiceNo: order.invoiceNo,
              invoiceDate: order.invoiceDate,
              serviceDate: order.serviceDate,
              reference: order.reference || null,
              company: order.company,
              invoiceAddress: order.invoiceAddress || null,
              name: order.name || null,
              email: order.email || null,
              items: order.items || [],
              vat: order.vat || [],
              // Fuer das spaetere Neuerzeugen des PDFs (ZIP-Export) muss der
              // Datensatz ALLES enthalten, was die Rechnung zeigt – sonst
              // fehlen Zwischensumme, Rabatt und Gutscheincode.
              subtotal: order.subtotal ?? null,
              discount: order.discount || 0,
              loyaltyDiscount: order.loyaltyDiscount || 0,
              deliveryFee: order.deliveryFee || 0,
              promo: order.promo || null,
              voucherCode: order.voucherCode || null,
              card: order.card || null,
              total: order.total,
              tip: order.tip || 0,
              payment: order.payment || null,
              mode: order.mode || null,
              createdAt: new Date().toISOString(),
            });
          } catch (e) { console.error('Rechnung ablegen fehlgeschlagen:', e); }
        } catch (e) {
          // Ohne Nummer keine Rechnung – die Bestätigung geht trotzdem raus,
          // damit eine Störung im Zähler nie die Bestellung blockiert.
          order.invoiceNo = null;
          console.error('Rechnungsnummer fehlgeschlagen:', e);
        }
      }

      // Firmenkunden bekommen die Rechnung zusaetzlich als Datei: das PDF zum
      // Ablegen, die XRechnung fuer die Buchhaltung.
      let anhaenge = [];
      if (order.company && order.invoiceNo) {
        try {
          const pdf = await buildInvoicePdf(order);
          anhaenge.push({ name: `Rechnung-${order.invoiceNo}.pdf`, content: pdf.toString('base64') });
          const xml = buildInvoiceXml(order);
          anhaenge.push({ name: `Rechnung-${order.invoiceNo}.xml`,
                          content: Buffer.from(xml, 'utf8').toString('base64') });
        } catch (e) {
          // Ohne Anhang geht die Bestaetigung trotzdem raus – die Rechnung
          // steht ja auch im Mailtext.
          console.error('Rechnungsanhang fehlgeschlagen:', e);
          anhaenge = [];
        }
      }

      const customerMail = buildOrderConfirmationEmail(order);
      const ownerMail = buildOwnerNotificationEmail(order, siteUrl, statusSecret);

      await Promise.all([
        // Kunde und Inhaber bekommen dieselben Rechnungsdateien
        sendViaBreve(apiKey, senderEmail, senderName,
          { email: order.email, name: order.name }, customerMail.subject, customerMail.html, anhaenge),
        sendViaBreve(apiKey, senderEmail, senderName,
          { email: ownerEmail, name: 'Grilln Chill' }, ownerMail.subject, ownerMail.html, anhaenge),
        sendTelegram(order),
      ]);

      // Status-Links für WhatsApp generieren (signiert mit Secret, das nur hier bekannt ist)
      const statusLinks = buildStatusLinks(order, siteUrl, statusSecret);

      // S1/S4: Treue-/Umsatz-/Referral-Gutschrift nur für verifizierte Bestellungen.
      //  - INTERNAL_HOOK_SECRET NICHT gesetzt  -> Schutz inaktiv, altes Verhalten (nichts bricht beim Deploy).
      //  - INTERNAL_HOOK_SECRET gesetzt        -> Gutschrift nur, wenn der Aufrufer (SumUp-Webhook /
      //    orders-reconcile, beide nach echtem PAID) dasselbe Secret mitschickt.
      //  - LOYALTY_TRUST_CASH=true (optional)  -> auch Bar/EC-Bestellungen (payment!=='sumup') gutschreiben
      //    (bewusst weniger streng; nur setzen, wenn Bar-Treue ohne Truck-Scan gewünscht ist).
      const INTERNAL_SECRET = process.env.INTERNAL_HOOK_SECRET || '';
      const enforceHook = INTERNAL_SECRET.length > 0;
      const trustCash = String(process.env.LOYALTY_TRUST_CASH || '').toLowerCase() === 'true';
      const verified = !enforceHook
        || (typeof input.internalSecret === 'string' && input.internalSecret === INTERNAL_SECRET)
        || (trustCash && order && order.payment && order.payment !== 'sumup');

      await afterOrderHooks(order, verified);

      return json(200, { sent: 2, type, statusLinks, statusUrl: order.reference ? statusPageUrl(order.reference) : null });
    }

    // Type 1b: Nur Owner-Benachrichtigung (z. B. sofort bei Online-Zahlung, vor SumUp)
    if (type === 'owner_notification') {
      const ownerMail = buildOwnerNotificationEmail(order, siteUrl, statusSecret);
      await sendViaBreve(apiKey, senderEmail, senderName,
        { email: ownerEmail, name: 'Grilln Chill' }, ownerMail.subject, ownerMail.html);
      const statusLinks = buildStatusLinks(order, siteUrl, statusSecret);
      return json(200, { sent: 1, type, statusLinks, statusUrl: order.reference ? statusPageUrl(order.reference) : null });
    }

    // Type 2: Status-Update an Kunde
    if (type === 'status_update') {
      const { status } = input;
      if (!status) return json(400, { error: 'Missing status' });

      const mail = buildStatusUpdateEmail(order, status);
      await sendViaBreve(apiKey, senderEmail, senderName,
        { email: order.email, name: order.name }, mail.subject, mail.html);

      return json(200, { sent: 1, type, status });
    }

    return json(400, { error: 'Unknown type', hint: 'type must be order_confirmation or status_update' });
  } catch (err) {
    return json(502, { error: 'E-Mail-Versand fehlgeschlagen', detail: err.message });
  }
};
