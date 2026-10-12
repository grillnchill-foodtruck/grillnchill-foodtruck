/**
 * lib/wallet-push.js
 * ----------------------------------------------------------------------------
 * Sagt iOS Bescheid, dass sich eine Wallet-Karte geaendert hat.
 *
 * Ablauf der Live-Aktualisierung: Nach jeder Treue-Aenderung schicken wir an
 * alle registrierten Geraete des Kunden einen LEEREN Apple-Push (Thema =
 * Pass-Typ-ID). iOS holt sich daraufhin selbst den frischen Pass ueber
 * wallet-api.js. Der Push transportiert also keine Daten - er ist nur die
 * Klingel.
 *
 * Zugang: derselbe APNs-Schluessel (.p8), der auch fuer Firebase hinterlegt
 * wurde - als Netlify-Variablen APPLE_APNS_KEY_B64 + APPLE_APNS_KEY_ID.
 * Signatur und Versand liegen in lib/apns.js. Fehlt etwas davon: stiller
 * Ausstieg - die Karte aktualisiert sich dann eben erst beim naechsten
 * manuellen Hinzufuegen.
 *
 * Wallet-Karten laufen immer ueber den Produktions-Host. Der Sandbox-
 * Rueckfall aus lib/apns.js ist hier deshalb abgeschaltet.
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');
const apns = require('./apns');

/* Ein leerer Push an ein Geraet; loest Status als Zahl ein (0 = kein Kontakt). */
async function sendeWalletPush(pushToken, topic) {
  const r = await apns.sendeApns({
    token: pushToken,
    topic,
    pushType: 'background',
    payload: {},
    sandboxFallback: false,
  });
  return r.status;
}

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

/**
 * Alle Geraete anstupsen, die die Karte dieses Kunden im Wallet haben.
 * Wirft nie - eine kaputte Wallet-Klingel darf keine Bestellung stoppen.
 * @param emailHash sha256(email) hex
 */
async function stupseWalletAn(emailHash) {
  try {
    if (!apns.apnsKonfiguriert() || !(await apns.ladeApnsKey())) return { ok: false, grund: 'nicht_eingerichtet' };
    let applePass;
    try { applePass = require('./apple-pass'); } catch (e) { return { ok: false, grund: 'lib' }; }
    if (!applePass.konfiguriert()) return { ok: false, grund: 'nicht_eingerichtet' };

    const serial = applePass.serialFuer(emailHash);
    const s = store('wallet');
    const { blobs } = await s.list({ prefix: 'reg:' + serial + ':' });
    if (!blobs.length) return { ok: true, gesendet: 0 };

    let gesendet = 0;
    for (const b of blobs) {
      const reg = await s.get(b.key, { type: 'json' });
      if (!reg || !reg.pushToken) continue;
      const status = await sendeWalletPush(reg.pushToken, applePass.passTypeId());
      if (status === 200) gesendet++;
      // 410 = Token tot (Pass geloescht, Geraet weg) -> Registrierung aufraeumen
      if (status === 410 || status === 400) {
        try {
          await s.delete(b.key);
          const geraet = b.key.slice(('reg:' + serial + ':').length);
          await s.delete('devreg:' + geraet + ':' + serial);
        } catch (e) {}
      }
    }
    return { ok: true, gesendet };
  } catch (e) {
    console.error('wallet-push:', e.message);
    return { ok: false, grund: String(e.message).slice(0, 120) };
  }
}

module.exports = { stupseWalletAn };
