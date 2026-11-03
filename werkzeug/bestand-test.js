#!/usr/bin/env node
/**
 * werkzeug/bestand-test.js
 * ----------------------------------------------------------------------------
 * Prüft „Bestand zählt mit“ (lib/bestand.js) mit einem Blob-Speicher im
 * Arbeitsspeicher, der bedingtes Schreiben (ETag) nachbildet:
 *
 *   node werkzeug/bestand-test.js
 *
 * Verbrauch je Burger, Standard startet den Tag von selbst, jede Bestellung
 * zählt einmal (auch gleichzeitig), Ausverkauft-Regeln, Telegram-Warnungen,
 * Rest ändern, Nachschub, Storno, shop-status liefert soldOutAuto.
 * ----------------------------------------------------------------------------
 */
const Module = require('module');
const path = require('path');
const F = path.join(__dirname, '..', 'netlify', 'functions');

const daten = new Map();
const version = new Map();
const store = (name) => ({
  async get(k, o) { const v = daten.get(name + '|' + k); return v === undefined ? null : (o && o.type === 'json' ? JSON.parse(v) : v); },
  async getWithMetadata(k) {
    const v = daten.get(name + '|' + k), e = String(version.get(name + '|' + k) || 0);   // Daten und ETag zum selben Zeitpunkt
    await new Promise((r) => setTimeout(r, Math.random() * 3));   // echte Verzögerung: Läufe überholen sich
    return v === undefined ? null : { data: JSON.parse(v), etag: e };
  },
  async setJSON(k, v, o = {}) {
    const key = name + '|' + k;
    if (o.onlyIfNew && daten.has(key)) return { modified: false };
    if (o.onlyIfMatch && String(version.get(key) || 0) !== o.onlyIfMatch) return { modified: false };
    daten.set(key, JSON.stringify(v)); version.set(key, (version.get(key) || 0) + 1);
    return { modified: true };
  },
  async delete(k) { daten.delete(name + '|' + k); },
  async list({ prefix } = {}) { return { blobs: [...daten.keys()].filter((k) => k.startsWith(name + '|' + (prefix || ''))).map((k) => ({ key: k.slice(name.length + 1) })) }; },
});
const originalLoad = Module._load;
Module._load = function (anfrage, ...rest) {
  if (anfrage === '@netlify/blobs') return { getStore: (o) => store(typeof o === 'string' ? o : o.name) };
  return originalLoad.call(this, anfrage, ...rest);
};
const nachrichten = [];
global.fetch = async (url, o) => { if (String(url).includes('telegram')) nachrichten.push(JSON.parse(o.body).text); return { ok: true, json: async () => ({}) }; };
process.env.TELEGRAM_BOT_TOKEN = 'x'; process.env.TELEGRAM_CHAT_ID = '1';

const B = require(path.join(F, 'lib', 'bestand'));
let n = 0, fehler = 0;
const ok = (titel, b, info) => { n++; console.log((b ? '✅ ' : '❌ ') + titel + (b || info === undefined ? '' : '\n   ' + JSON.stringify(info))); if (!b) fehler++; };
const heute = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const korb = (x) => Object.fromEntries(x.map((e, i) => ['k' + i, e]));

(async () => {
  /* ---- Verbrauch ---- */
  const v = B.verbrauch(korb([{ menuId: 'classic', qty: 2 }, { menuId: 'kubis', qty: 1 }, { menuId: 'crispy', qty: 1 }, { menuId: 'cheese', qty: 1, double: true, isMenu: true }, { menuId: 'cheese-veg', qty: 1 }, { menuId: 'pommes', qty: 3 }, { menuId: 'fritz-kola', qty: 2 }]));
  ok('Buns: jeder Burger eins (2+1+1+1+1)', v.buns === 6, v);
  ok('Patties: Classic 2, Kubis 2, Double 2, Hähnchen und Veggie 0', v.patties === 6, v);

  /* ---- Ohne Einrichtung zählt nichts ---- */
  let st = await B.stand();
  ok('Ohne Standard: nicht gezählt, nichts ausverkauft', !st.gezaehlt && st.rest.buns === null && st.ausverkauft.length === 0, st);
  await B.abziehen('GNC-0', korb([{ menuId: 'classic', qty: 1 }]));
  st = await B.stand();
  ok('Bestellung ohne Zählung sperrt nichts', st.rest.buns === null && st.ausverkauft.length === 0, st);
  daten.clear(); version.clear();

  /* ---- Einmal einrichten: Standard und heute ---- */
  st = await B.setzen({ standard: { buns: 30, patties: 25, auto: true }, start: { buns: 30, patties: 25 } });
  ok('Einrichten startet heute mit 30 Buns und 25 Patties', st.gezaehlt && st.rest.buns === 30 && st.rest.patties === 25, st);

  /* ---- Abziehen, einmal je Bestellung ---- */
  await B.abziehen('GNC-1', korb([{ menuId: 'classic', qty: 2 }]));
  await B.abziehen('GNC-1', korb([{ menuId: 'classic', qty: 2 }]));   // Webhook und Rückkehr
  st = await B.stand();
  ok('Gleiche Bestellnummer zieht nur einmal ab', st.rest.buns === 28 && st.rest.patties === 23, st.rest);
  await Promise.all(Array.from({ length: 8 }, (_, i) => B.abziehen('GNC-P' + i, korb([{ menuId: 'cheese', qty: 1 }]))));
  st = await B.stand();
  ok('8 gleichzeitige Bestellungen: nichts geht verloren', st.rest.buns === 20 && st.rest.patties === 15, st.rest);

  /* ---- Warnungen ---- */
  nachrichten.length = 0;
  await B.abziehen('GNC-W1', korb([{ menuId: 'classic', qty: 6 }]));   // Patties 15 → 9
  ok('Telegram bei 10 oder weniger: „Nur noch 9 Patties übrig“', nachrichten.some((t) => /Nur noch 9 Patties/.test(t)), nachrichten);
  await B.abziehen('GNC-W2', korb([{ menuId: 'classic', qty: 1 }]));   // 8
  ok('Warnung kommt nur einmal', nachrichten.filter((t) => /Patties übrig/.test(t)).length === 1, nachrichten);

  /* ---- Ausverkauft ---- */
  await B.abziehen('GNC-W3', korb([{ menuId: 'classic', qty: 7 }]));   // Patties 1, Buns 6
  st = await B.stand();
  ok('Ein Patty übrig: Kubis Special (braucht zwei) ausverkauft, Classic noch nicht', st.ausverkauft.includes('kubis') && !st.ausverkauft.includes('classic'), st);
  await B.abziehen('GNC-W4', korb([{ menuId: 'whitebbq', qty: 1 }]));  // Patties 0
  st = await B.stand();
  ok('Patties alle: Rind-Burger ausverkauft, Hähnchen und Veggie nicht', ['classic', 'cheese', 'sucuk', 'kubis'].every((id) => st.ausverkauft.includes(id)) && !st.ausverkauft.includes('crispy') && !st.ausverkauft.includes('classic-veg'), st.ausverkauft);
  ok('Telegram: „Patties sind alle“', nachrichten.some((t) => /Patties sind alle/.test(t)), nachrichten);
  ok('Rest geht nie unter null', st.rest.patties === 0, st.rest);

  /* ---- Nachschub und Korrektur ---- */
  st = await B.setzen({ rest: { patties: 10 } });
  ok('+10 Nachschub: wieder 10, Rind-Burger wieder da', st.rest.patties === 10 && !st.ausverkauft.includes('classic'), st);
  st = await B.setzen({ rest: { buns: 3 } });
  ok('Rest ändern auf 3 Buns (am Truck bar verkauft)', st.rest.buns === 3, st.rest);
  await B.abziehen('GNC-W5', korb([{ menuId: 'crispy', qty: 3 }]));
  st = await B.stand();
  ok('Buns alle: alle Burger ausverkauft, auch Hähnchen', st.rest.buns === 0 && st.ausverkauft.includes('crispy') && st.ausverkauft.includes('classic-veg'), st);
  await B.zurueckbuchen('GNC-W5', korb([{ menuId: 'crispy', qty: 3 }]));
  st = await B.stand();
  ok('Storno einer Eingabe gibt die Buns zurück', st.rest.buns === 3 && !st.ausverkauft.includes('crispy'), st.rest);

  /* ---- Nächster Tag startet von selbst ---- */
  const morgen = new Date(Date.parse(heute + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
  const m = await B.stand(morgen);
  ok('Morgen startet von selbst mit dem Standard (30/25)', m.gezaehlt && m.rest.buns === 30 && m.rest.patties === 25, m);
  await B.setzen({ standard: { buns: 30, patties: 25, auto: false } });
  ok('Ohne „jeden Morgen“ zählt der nächste Tag nicht', !(await B.stand(morgen)).gezaehlt);

  /* ---- shop-status GET liefert soldOutAuto ---- */
  await B.setzen({ standard: { buns: 30, patties: 25, auto: true } });
  await B.setzen({ rest: { buns: 0 } });
  const shop = require(path.join(F, 'shop-status')).handler;
  const r = await shop({ httpMethod: 'GET', headers: { 'x-nf-client-connection-ip': '203.0.113.9' }, queryStringParameters: {} });
  const d = JSON.parse(r.body);
  ok('shop-status: soldOutAuto mit allen Burgern, soldOut (Hand) unberührt', Array.isArray(d.soldOutAuto) && d.soldOutAuto.includes('classic') && Array.isArray(d.soldOut) && !d.soldOut.includes('classic'), { soldOut: d.soldOut, auto: d.soldOutAuto });

  console.log('\n' + (n - fehler) + ' von ' + n + (fehler ? ' – ' + fehler + ' FEHLER' : ' grün'));
  process.exit(fehler ? 1 : 0);
})();
