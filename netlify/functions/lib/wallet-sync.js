/**
 * lib/wallet-sync.js
 * ----------------------------------------------------------------------------
 * Ein Aufruf nach jeder Treue-Aenderung: bringt die Kundenkarte in BEIDEN
 * Handy-Wallets auf den neuen Stand.
 *   Apple:  leerer Push an registrierte Geraete -> iOS holt den frischen Pass
 *   Google: direktes PATCH am gespeicherten Karten-Objekt
 * Wirft nie und ist ohne eingerichtete Wallets ein stiller Durchlauf.
 * Der Aufrufer setzt vor dem Speichern rec.walletStand = Date.now() –
 * daran erkennt Apples Abgleich, dass es etwas Neues gibt.
 * ----------------------------------------------------------------------------
 */

const { stupseWalletAn } = require('./wallet-push');
const { aktualisiereGoogleKarte } = require('./wallet-google');

async function aktualisiereWallets(emailHash, rec) {
  try {
    const [apple, google] = await Promise.all([
      stupseWalletAn(emailHash),
      aktualisiereGoogleKarte(rec, String(emailHash).slice(0, 16)),
    ]);
    return { apple, google };
  } catch (e) {
    console.error('wallet-sync:', e.message);
    return { apple: { ok: false }, google: { ok: false } };
  }
}

module.exports = { aktualisiereWallets };
