/**
 * orders-reconcile.js
 * ----------------------------------------------------------------------------
 * Sicherheitsnetz für Online-Zahlungen (läuft alle 15 Minuten, siehe netlify.toml).
 *
 * Problem: Nach der SumUp-Zahlung muss der Kunde zur Website zurückkehren,
 * damit Bestellbestätigung, Inhaber-Mail und Telegram ausgelöst werden.
 * Schließt er stattdessen den Tab, ist die Zahlung da – aber niemand erfährt
 * von der Bestellung.
 *
 * Lösung: Alle "pending"-Bestellungen im Archiv (Store: orders) werden gegen
 * die SumUp-API geprüft:
 *   PAID            → Benachrichtigungen nachträglich auslösen (send-email),
 *                     der dortige Hook setzt den Eintrag auf "completed".
 *   FAILED/EXPIRED  → Eintrag als "abandoned" markieren (Zahlungsabbruch).
 *   noch PENDING    → beim nächsten Lauf erneut prüfen (bis 48 h).
 *
 * Zusätzlich: Aufräumen des Archivs (completed > 90 Tage, abandoned > 14 Tage).
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');

const SUMUP_API_BASE = 'https://api.sumup.com/v0.1';
const MIN_AGE_MIN = 3;          // Webhook/Kunden-Rückkehr haben Vorrang; Doppelversand verhindert der Idempotenz-Guard in send-email
const MAX_PENDING_HOURS = 48;   // danach gilt der Vorgang als abgebrochen
const RETENTION_COMPLETED_DAYS = 90;
const RETENTION_ABANDONED_DAYS = 14;
const MAX_CHECKS_PER_RUN = 40;

function store() {
  const opts = { name: 'orders', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

exports.handler = async () => {
  const apiKey = process.env.SUMUP_API_KEY;
  const siteUrl = (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');
  const s = store();
  const now = Date.now();
  let reconciled = 0, abandoned = 0, stillPending = 0, cleaned = 0, errors = 0, checked = 0;

  try {
    const { blobs } = await s.list({ prefix: 'o:' });
    for (const b of blobs) {
      const rec = await s.get(b.key, { type: 'json' });
      if (!rec) continue;

      // ---------- Aufräumen ----------
      try {
        if (rec.status === 'completed' && rec.completedAt &&
            now - new Date(rec.completedAt).getTime() > RETENTION_COMPLETED_DAYS * 86400000) {
          await s.delete(b.key); cleaned++; continue;
        }
        if (rec.status === 'cancelled' && rec.cancelledAt &&
            now - new Date(rec.cancelledAt).getTime() > RETENTION_ABANDONED_DAYS * 86400000) {
          try { await s.delete(b.key); cleaned++; } catch (e) { errors++; }
          continue;
        }
        if (rec.status === 'abandoned' && rec.abandonedAt &&
            now - new Date(rec.abandonedAt).getTime() > RETENTION_ABANDONED_DAYS * 86400000) {
          await s.delete(b.key); cleaned++; continue;
        }
        if (rec.status === 'refunded' &&
            now - new Date(rec.refundedAt || rec.completedAt || rec.createdAt || 0).getTime() > RETENTION_COMPLETED_DAYS * 86400000) {
          await s.delete(b.key); cleaned++; continue;
        }
      } catch (e) {}

      if (rec.status !== 'pending') continue;
      const ageMs = now - new Date(rec.createdAt || 0).getTime();
      if (ageMs < MIN_AGE_MIN * 60000) { stillPending++; continue; }
      if (checked >= MAX_CHECKS_PER_RUN) { stillPending++; continue; }
      checked++;

      // ---------- Zahlungsstatus bei SumUp prüfen ----------
      let payStatus = null;
      if (rec.checkoutId && apiKey) {
        try {
          const res = await fetch(`${SUMUP_API_BASE}/checkouts/${encodeURIComponent(rec.checkoutId)}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          const data = await res.json().catch(() => null);
          if (res.ok && data && data.status) payStatus = String(data.status).toUpperCase();
        } catch (e) {}
      }

      if (payStatus === 'PAID') {
        // Geschenkgutscheine: komplette Erfüllung liegt im Webhook (Code + Mail) – dort anstoßen
        if (rec.kind === 'giftcard') {
          try {
            const res = await fetch(siteUrl + '/.netlify/functions/sumup-webhook', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: rec.checkoutId }),
            });
            if (res.ok) reconciled++; else errors++;
          } catch (e) { errors++; }
          continue;
        }
        // Benachrichtigungen nachholen – send-email setzt den Eintrag auf "completed"
        try {
          const res = await fetch(siteUrl + '/.netlify/functions/send-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // internalSecret: nur PAID-verifizierte Bestellungen landen hier -> Gutschrift erlaubt (S1/S4).
            body: JSON.stringify({ type: 'order_confirmation', order: rec.order, internalSecret: process.env.INTERNAL_HOOK_SECRET || undefined }),
          });
          if (res.ok) { reconciled++; }
          else { errors++; }
        } catch (e) { errors++; }
      } else if (payStatus === 'FAILED' || payStatus === 'EXPIRED' ||
                 (payStatus !== 'PAID' && ageMs > MAX_PENDING_HOURS * 3600000)) {
        rec.status = 'abandoned';
        rec.abandonedAt = new Date().toISOString();
        rec.payStatus = payStatus || 'UNKNOWN';
        try { await s.setJSON(b.key, rec); abandoned++; } catch (e) { errors++; }
      } else {
        stillPending++;
      }
    }
    // Abgelaufene Gruppenbestellungen entsorgen (48h TTL)
    try {
      const gsOpts = { name: 'groups', consistency: 'strong' };
      if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
        gsOpts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
        gsOpts.token = process.env.NETLIFY_BLOBS_TOKEN;
      }
      const gs = getStore(gsOpts);
      const gl = await gs.list({ prefix: 'g:' });
      for (const b of gl.blobs) {
        const g = await gs.get(b.key, { type: 'json' });
        if (g && Date.now() - new Date(g.createdAt).getTime() > 48 * 3600000) {
          await gs.delete(b.key); cleaned++;
        }
      }
    } catch (e) {}

    return { statusCode: 200, body: JSON.stringify({ ok: true, reconciled, abandoned, stillPending, cleaned, errors }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String((e && e.message) || e) }) };
  }
};
