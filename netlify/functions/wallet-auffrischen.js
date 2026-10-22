/**
 * wallet-auffrischen.js
 * ----------------------------------------------------------------------------
 * Bringt alle schon gespeicherten Kundenkarten in Apple und Google Wallet
 * einmal auf den neuen Stand, wenn sich die Felder der Karte geändert haben.
 *
 * Warum: Eine Karte im Wallet holt sich neue Felder nur, wenn der Server sie
 * anstößt (lib/wallet-sync.js). Das passiert bei jeder Treue-Änderung des
 * Kunden. Wer seit einer Änderung der Karte nichts bestellt hat, sähe sonst
 * dauerhaft die alte Fassung (zum Beispiel „5-€-Boni“ statt „Menüs aufs Haus“).
 *
 * Ablauf: Zeitplan alle 10 Minuten (netlify.toml). Solange der gespeicherte
 * Stand nicht PASS_STAND entspricht, werden die Kunden der Reihe nach
 * aufgefrischt, je Lauf höchstens ARBEIT_MS lang; der nächste Lauf macht an
 * der gemerkten Stelle weiter. Danach ist jeder Lauf ein kurzer Blick auf
 * den Merker. Für die nächste Änderung der Karte PASS_STAND hochzählen.
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');
const { aktualisiereWallets } = require('./lib/wallet-sync');
const { serialFuer } = require('./lib/apple-pass');

const PASS_STAND = '2026-10-23-menue';   // Menüs aufs Haus statt 5-€-Boni, Hinweis auf der Rückseite
const ARBEIT_MS = 20000;
const MERKER = 'auffrischen';

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

exports.handler = async () => {
  const start = Date.now();
  const w = store('wallet');
  const c = store('customers');
  const alt = (await w.get(MERKER, { type: 'json' })) || {};
  if (alt.stand === PASS_STAND && alt.fertig) return { statusCode: 200, body: 'nichts zu tun' };

  const m = alt.stand === PASS_STAND ? alt : { stand: PASS_STAND, cursor: '', kunden: 0, apple: 0, google: 0 };
  const { blobs } = await c.list({ prefix: 'c:' });
  const schluessel = blobs.map((b) => b.key).sort().filter((k) => k > (m.cursor || ''));

  for (const key of schluessel) {
    if (Date.now() - start > ARBEIT_MS) {
      await w.setJSON(MERKER, { ...m, fertig: false });
      console.log('wallet-auffrischen: Zwischenstand', JSON.stringify(m));
      return { statusCode: 200, body: JSON.stringify({ weiter: true, ...m }) };
    }
    m.cursor = key;
    try {
      const rec = await c.get(key, { type: 'json' });
      if (!rec || !rec.qrToken) continue;          // ohne Kundenkarte keine Wallet-Karte
      const hash = key.slice(2);
      m.kunden++;
      // Apple holt den neuen Pass nur, wenn walletStand neuer ist als sein letzter Abruf.
      // Nur für Kunden mit registriertem Gerät setzen, frisch gelesen direkt vor dem Schreiben.
      const regs = await w.list({ prefix: 'reg:' + serialFuer(hash) + ':' });
      if (regs.blobs && regs.blobs.length) {
        const frisch = (await c.get(key, { type: 'json' })) || rec;
        frisch.walletStand = Date.now();
        await c.setJSON(key, frisch);
        const r = await aktualisiereWallets(hash, frisch);
        if (r.apple && r.apple.gesendet) m.apple += r.apple.gesendet;
        if (r.google && r.google.aktualisiert) m.google += r.google.aktualisiert;
      } else {
        const r = await aktualisiereWallets(hash, rec);   // nur Google (Apple: niemand registriert)
        if (r.google && r.google.aktualisiert) m.google += r.google.aktualisiert;
      }
    } catch (e) {
      console.error('wallet-auffrischen:', key.slice(0, 10), e.message);
    }
  }

  await w.setJSON(MERKER, { ...m, fertig: true, fertigAm: new Date().toISOString() });
  console.log('wallet-auffrischen: fertig', JSON.stringify(m));
  return { statusCode: 200, body: JSON.stringify({ fertig: true, ...m }) };
};
