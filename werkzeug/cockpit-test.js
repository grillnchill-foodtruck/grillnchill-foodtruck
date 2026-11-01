#!/usr/bin/env node
/**
 * werkzeug/cockpit-test.js
 * ----------------------------------------------------------------------------
 * Prüft Menü-Engineering und Wochenbericht gegen die echten Handler, mit
 * einem Blob-Speicher im Arbeitsspeicher:
 *
 *   node werkzeug/cockpit-test.js
 *
 * Abgedeckt: Nettopreis und Steuer-Spiegel (gegen splitVat aus index.html),
 * Menü-Zerlegung, Vier-Felder-Einordnung mit Beispielzahlen, fehlender
 * Wareneinsatz, Tageswerte mit Zwischenspeicher und Schlüssel-Zeitstempel,
 * Wochenbericht-Text mit und ohne Feedback/Catering/Firmen,
 * Vorwochenvergleich, Inhaber-Prüfung (cockpit-inhaber.js), geplanter Lauf
 * (wochenbericht.js). Telegram geht nirgends hin: fetch ist abgefangen.
 * ----------------------------------------------------------------------------
 */

const Module = require('module');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const W = path.join(__dirname, '..');
const F = path.join(W, 'netlify', 'functions');
const daten = new Map();
const lesen = [];
const store = (name) => ({
  async get(k, o) { lesen.push(name + '|' + k); const v = daten.get(name + '|' + k); return v === undefined ? null : (o && o.type === 'json' ? JSON.parse(v) : v); },
  async setJSON(k, v) { daten.set(name + '|' + k, JSON.stringify(v)); },
  async set(k, v) { daten.set(name + '|' + k, String(v)); },
  async delete(k) { daten.delete(name + '|' + k); },
  async list({ prefix } = {}) { return { blobs: [...daten.keys()].filter((k) => k.startsWith(name + '|' + (prefix || ''))).sort().map((k) => ({ key: k.slice(name.length + 1) })) }; },
});
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) { if (r === '@netlify/blobs') return '@netlify/blobs'; return orig.call(this, r, ...a); };
require.cache['@netlify/blobs'] = { id: '@netlify/blobs', exports: { getStore: (o) => store(typeof o === 'string' ? o : o.name) }, loaded: true };
process.env.ADMIN_PASSWORD = 'kubi-test-passwort';
delete process.env.ZWEI_FAKTOR;
process.env.TELEGRAM_BOT_TOKEN = 'test-nicht-echt';
process.env.TELEGRAM_CHAT_ID = '1';
const telegramPost = [];
global.fetch = async (url, o) => {
  if (String(url).startsWith('https://api.telegram.org/')) {
    telegramPost.push(JSON.parse(o.body));
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '' };
  }
  return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
};
console.warn = () => {};
console.error = () => {};

const SK = require(path.join(W, 'speisekarte.js'));
const tw = require(F + '/lib/tageswerte.js');
const ma = require(F + '/lib/menue-analyse.js');
const wb = require(F + '/lib/wochenbericht.js');
const zf = require(F + '/lib/zweifaktor.js');
const geraet = require(F + '/lib/team-device.js');
const team = require(F + '/team.js');
const inhaber = require(F + '/cockpit-inhaber.js');
const geplant = require(F + '/wochenbericht.js');

let fehler = 0, n = 0;
const ok = (name, b, info) => { n++; console.log((b ? '✅ ' : '❌ ') + name + (b || info === undefined ? '' : '\n   ' + info)); if (!b) fehler++; };
const nah = (a, b, eps) => Math.abs(a - b) < (eps || 0.005);
let ip = 1;
const call = async (h, body, eigeneIp) => {
  const r = await h.handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': eigeneIp || ('10.1.0.' + ip) }, body: JSON.stringify(body) });
  let d = {}; try { d = JSON.parse(r.body); } catch (e) {}
  return { s: r.statusCode, d };
};
const codeJetzt = (geheim, d = 0) => zf.hotp(zf.base32lesen(geheim), zf.schrittVon(Date.now()) + d);
const ohneSlop = (t) => !/[–—]/.test(t);

/* Bestellung anlegen: Schlüssel-Zeitstempel = Anlegen, completedAt = Abschluss */
function bestellung(ms, o) {
  const korb = o.korb || {};
  const total = o.total !== undefined ? o.total : Object.values(korb).reduce((s, e) => s + SK.einzelpreis(e) * e.qty, 0);
  daten.set('orders|o:GNC-' + ms, JSON.stringify({
    status: o.status || 'completed',
    kind: o.kind,
    createdAt: new Date(ms).toISOString(),
    completedAt: new Date(ms + 60000).toISOString(),
    order: { mode: o.mode || 'pickup', total, isTest: !!o.isTest, quelle: o.quelle, cartSnapshot: o.ohneKorb ? undefined : korb, items: o.items || [], name: 'Ayşe Yılmaz', email: 'ayse@example.com', deliveryAddress: { street: 'Gütersloher Str. 1' } },
  }));
}
const mittag = (d) => tw.berlinMitternacht(d) + 12 * 3600000;

(async () => {
  /* ---- 1. Nettopreis und Steuer-Spiegel --------------------------------- */
  ok('Nettopreis Burger 8,00 € mit 7 % = 7,48 €', nah(ma.netto(8, 7), 7.4766));
  ok('Nettopreis Fritz Kola 2,50 € mit 19 % = 2,10 €', nah(ma.netto(2.5, 19), 2.1008));

  const html = fs.readFileSync(path.join(W, 'index.html'), 'utf8');
  const vatFood = Number((/const VAT_FOOD = (\d+);/.exec(html) || [])[1]);
  const vatDrink = Number((/const VAT_DRINK = (\d+);/.exec(html) || [])[1]);
  ok('Steuer-Spiegel passt zu index.html (VAT_FOOD/VAT_DRINK)', vatFood === ma.SATZ_SPEISE && vatDrink === ma.SATZ_GETRAENK, vatFood + '/' + vatDrink);
  const start = html.indexOf('function splitVat(');
  const ende = html.indexOf('\n}\n', start) + 2;
  const ctx = { MENU: SK.MENU, VAT_FOOD: vatFood, VAT_DRINK: vatDrink };
  vm.runInNewContext(html.slice(start, ende), ctx);
  const splitVat = ctx.splitVat;
  ok('splitVat aus index.html gefunden', typeof splitVat === 'function');
  ok('Satz je Artikel wie splitVat (Getränke 19 %, sonst 7 %)', SK.MENU.every((m) => {
    const t = splitVat({ menuId: m.id, qty: 1 }, m.price);
    return (t[19] > 0 ? 19 : 7) === ma.satzFuer(m.cat) || m.price === 0;
  }));

  /* ---- 2. Menü zerlegen -------------------------------------------------- */
  const menue = { menuId: 'classic', qty: 2, isMenu: true, side: 'pommes', drink: 'fritz-kola', dip: 'dip-mayo' };
  const z = tw.zerlegeZeile(menue, SK);
  const teil = (id) => (z.teile.find((t) => t.id === id) || {}).brutto;
  ok('Menü: Summe der Teile = Zeilenpreis (2 x 13,00 €)', nah(z.teile.reduce((s, t) => s + t.brutto, 0), 26));
  ok('Menü: Getränk zum Einzelpreis, Rest nach Einzelpreisen', nah(teil('fritz-kola'), 5) && nah(teil('classic'), 13.44) && nah(teil('pommes'), 6.72) && nah(teil('dip-mayo'), 0.84));
  const sv = splitVat(menue, SK.einzelpreis(menue) * 2);
  ok('Menü: Aufteilung deckt sich mit splitVat (19 % = Getränk)', nah(sv[19], teil('fritz-kola')) && nah(sv[7], 26 - teil('fritz-kola')));
  const dbl = tw.zerlegeZeile({ menuId: 'cheese', qty: 1, double: true }, SK);
  ok('Double Patty wird eigener Bestandteil', dbl.teile.some((t) => t.id === 'extra-double') && nah(dbl.teile.reduce((s, t) => s + t.brutto, 0), 11));
  const kubis = tw.zerlegeZeile({ menuId: 'kubis', qty: 1, double: true }, SK);
  ok('Kubis Special: kein extra Double Patty (schon doppelt)', !kubis.teile.some((t) => t.id === 'extra-double'));
  const nug = tw.zerlegeZeile({ menuId: 'nug9', qty: 1, dip: 'dip-ket' }, SK);
  ok('Nuggets mit Inklusiv-Dip: Dip bekommt seinen Anteil, Summe 5,00 €', nug.teile.length === 2 && nah(nug.teile.reduce((s, t) => s + t.brutto, 0), 5));
  ok('Unbekannter Artikel wird nicht gezählt', tw.zerlegeZeile({ menuId: 'gibtsnicht', qty: 1 }, SK) === null);

  /* ---- 3. Vier-Felder-Tafel mit Beispielzahlen --------------------------- */
  const bsp = [
    { id: 'A', qty: 100, db: 4.0, satz: 7 },
    { id: 'B', qty: 60, db: 2.0, satz: 7 },
    { id: 'C', qty: 20, db: 5.0, satz: 7 },
    { id: 'D', qty: 20, db: 1.0, satz: 7 },
  ];
  let t4 = ma.vierFelder(bsp);
  ok('Schwelle Beliebtheit = 70 % von 1/4 = 17,5 %', nah(t4.schwelleAnteil, 0.175) && nah(t4.schwelleStueck, 35));
  ok('Schnitt-DB mengengewichtet = 3,20 €', nah(t4.schnittDb, 3.2));
  ok('A Renner, B Zugpferd, C Rätsel, D Ladenhüter',
    t4.punkte.A.feld === 'renner' && t4.punkte.B.feld === 'zugpferd' && t4.punkte.C.feld === 'raetsel' && t4.punkte.D.feld === 'ladenhueter',
    JSON.stringify(Object.fromEntries(Object.entries(t4.punkte).map(([k, v]) => [k, v.feld]))));
  ok('Zugpferd-Hinweis nennt den nötigen Aufpreis (1,30 €)', /1,30 €/.test(t4.punkte.B.hinweis) && /Preis prüfen/.test(t4.punkte.B.hinweis), t4.punkte.B.hinweis);
  ok('Hinweise: Rätsel besser platzieren, Ladenhüter von der Karte nehmen?',
    /platzieren/.test(t4.punkte.C.hinweis) && /Von der Karte nehmen\?/.test(t4.punkte.D.hinweis));
  ok('Tafel "Alle" (Dip neben Burger): Zugpferd ohne Preis-Betrag', !/€/.test(ma.vierFelder(bsp, { gemischt: true }).punkte.B.hinweis));
  ok('Gleichstand zählt als beliebt bzw. hohe Marge', ma.vierFelder([{ id: 'x', qty: 35, db: 3, satz: 7 }, { id: 'y', qty: 165, db: 3, satz: 7 }, { id: 'z', qty: 0, db: 3, satz: 7 }, { id: 'w', qty: 0, db: 3, satz: 7 }]).punkte.x.feld === 'renner');

  /* ---- 4. Fehlender Wareneinsatz ----------------------------------------- */
  t4 = ma.vierFelder(bsp.concat([{ id: 'E', qty: 30, db: null, satz: 7 }]));
  ok('Ohne Wareneinsatz: kein Feld, Hinweis "Wareneinsatz fehlt."', t4.punkte.E.feld === null && t4.punkte.E.hinweis === 'Wareneinsatz fehlt.');
  ok('Ohne Wareneinsatz: zählt nicht in den Schnitt-DB', nah(t4.schnittDb, 3.2));
  ok('Ohne Wareneinsatz: zählt aber in die Beliebtheit (N = 5)', nah(t4.schwelleAnteil, 0.14) && t4.punkte.E.beliebt === false);
  ok('Keine Verkäufe: Tafel leer, keine Einordnung', ma.vierFelder([{ id: 'a', qty: 0, db: 2, satz: 7 }]).leer === true);

  const summeBsp = { artikel: { classic: [10, 70], cheese: [5, 42.5] }, haupt: { classic: 10, cheese: 5 } };
  const aw = ma.auswerten(SK, summeBsp, { classic: { cost: 2.5, updatedAt: 'x' }, unbekannt: { cost: 1 } });
  const cl = aw.artikel.find((a) => a.id === 'classic');
  const ch = aw.artikel.find((a) => a.id === 'cheese');
  ok('Auswertung: Nettopreis aus tatsächlichem Umsatz (7,00 € brutto -> 6,54 €)', nah(cl.nettoSchnitt, 6.54) && nah(cl.db, 4.04) && nah(cl.quote, 0.382, 0.001));
  ok('Auswertung: ohne Wareneinsatz cost/db/quote = null', ch.cost === null && ch.db === null && ch.quote === null && aw.tafeln.burger.punkte.cheese.hinweis === 'Wareneinsatz fehlt.');
  ok('Auswertung: Extras stehen in der Liste, nicht in der Tafel', aw.artikel.some((a) => a.id === 'extra-double') && !aw.tafeln.alle.punkte['extra-double']);
  ok('Beliebt ohne Wareneinsatz (für den Wochenbericht)', ma.beliebtOhneKosten(aw).map((a) => a.id).join() === 'cheese');

  /* ---- 5. Tageswerte ----------------------------------------------------- */
  const tag = '2026-10-20';
  const m0 = mittag(tag);
  const recs = [
    { status: 'completed', createdAt: new Date(m0).toISOString(), order: { mode: 'pickup', total: 13, cartSnapshot: { a: menue } } },
    { status: 'completed', createdAt: new Date(m0).toISOString(), order: { mode: 'delivery', total: 20, quelle: 'telefon', cartSnapshot: { a: { menuId: 'cheese', qty: 2 } } } },
    { status: 'completed', createdAt: new Date(m0).toISOString(), order: { mode: 'pickup', total: 9, quelle: 'truck', items: [{ name: 'Sucuk Burger', qty: 1 }] } },
    { status: 'pending', createdAt: new Date(m0).toISOString(), order: { mode: 'pickup', total: 99 } },
    { status: 'completed', createdAt: new Date(m0).toISOString(), order: { mode: 'pickup', total: 1, isTest: true } },
    { status: 'completed', kind: 'giftcard', createdAt: new Date(m0).toISOString(), order: { total: 50 } },
  ];
  const agg = tw.tagAggregat(tag, recs, SK);
  ok('Tageswert: nur abgeschlossene, ohne Test und Gutschein (3 Bestellungen, 42 €)', agg.orders === 3 && nah(agg.revenue, 42));
  ok('Tageswert: Telefon und Truck zählen mit, Abholung 2 / Lieferung 1', agg.pickup === 2 && agg.delivery === 1);
  ok('Tageswert: Hauptartikel und Bestandteile', agg.haupt.classic === 2 && agg.haupt.cheese === 2 && agg.artikel['fritz-kola'][0] === 2 && agg.artikel.pommes[0] === 2);
  ok('Tageswert: Zeile ohne Warenkorb-Daten zählt als "ohne"', agg.ohne === 1);

  /* ---- 6. Wochenbericht-Text --------------------------------------------- */
  const basis = {
    von: '2026-10-26', bis: '2026-11-01', kw: 44,
    woche: { umsatz: 2345.6, bestellungen: 187, abholung: 142, lieferung: 45 },
    vorwoche: { umsatz: 2094.3, bestellungen: 170 },
    top: [{ name: 'Classic Burger', qty: 96 }, { name: 'Cheeseburger', qty: 80 }, { name: 'Pommes', qty: 70 }, { name: 'Crispy Chicken Burger', qty: 40 }, { name: 'Sucuk Burger', qty: 33 }, { name: 'Sechster', qty: 2 }],
    fehlenderWareneinsatz: [],
  };
  let text = wb.baueWochenbericht(basis);
  ok('Bericht: Kopf mit KW und Zeitraum', /<b>Wochenbericht KW 44<\/b>/.test(text) && /Montag 26\.10\. bis Sonntag 01\.11\.2026/.test(text));
  ok('Bericht: Umsatz, Bestellungen, Durchschnittsbon', /2\.345,60 €/.test(text) && /187 Bestellungen, Durchschnittsbon 12,54 €/.test(text), text);
  ok('Bericht: Vorwoche +12 %', /\+12 % zur Vorwoche \(2\.094,30 €\)/.test(text));
  ok('Bericht: Abholung gegen Lieferung', /Abholung 142 \(76 %\), Lieferung 45 \(24 %\)/.test(text));
  ok('Bericht: Top 5, nicht mehr', /1\. Classic Burger: 96 Stück/.test(text) && /5\. Sucuk Burger/.test(text) && !/Sechster/.test(text));
  ok('Bericht ohne Feedback, Catering, Firmen: keine leeren Abschnitte', !/Feedback|Catering|Firmen|Hinweis/.test(text));
  ok('Bericht: keine Ausrufezeichen, keine Gedankenstriche', !/!/.test(text) && ohneSlop(text));
  ok('Vorwoche weniger: -8 %', /-8 % zur Vorwoche/.test(wb.baueWochenbericht({ ...basis, woche: { ...basis.woche, umsatz: 1926.76 } })));
  ok('Vorwoche gleich', /Wie in der Vorwoche/.test(wb.baueWochenbericht({ ...basis, vorwoche: { umsatz: 2345.6, bestellungen: 1 } })));
  ok('Vorwoche ohne Umsatz', /Vorwoche ohne Umsatz\./.test(wb.baueWochenbericht({ ...basis, vorwoche: { umsatz: 0, bestellungen: 0 } })));
  text = wb.baueWochenbericht({ ...basis, woche: { umsatz: 0, bestellungen: 0, abholung: 0, lieferung: 0 }, top: [] });
  ok('Woche ohne Bestellungen: klarer Satz, kein Durchschnittsbon', /Keine Bestellungen in dieser Woche\./.test(text) && !/Durchschnittsbon|NaN|Infinity/.test(text));

  text = wb.baueWochenbericht({
    ...basis,
    feedback: { anzahl: 23, schnitt: 4.6, schwaechste: { stars: 2, text: 'Pommes waren kalt <b>wirklich</b>. Ruft mich an: 0171 2345678 oder ayse@example.com, ich wohne in der Gütersloher Straße und das ist ein sehr langer Text der gekürzt werden muss damit er passt.' } },
    catering: { ohneAngebot: 2, offeneAngebote: 3, entwuerfe: 1 },
    firmen: { offen: 1, neu: 1 },
    fehlenderWareneinsatz: ['Classic Burger', 'Pommes'],
  });
  ok('Bericht mit Feedback: Schnitt und Anzahl', /Schnitt 4,6 von 5 Sternen aus 23 Bewertungen\./.test(text), text);
  ok('Feedback: schwächste gekürzt, HTML entschärft, ohne Telefon und Mail', /Schwächste: 2 Sterne\. „Pommes waren kalt &lt;b&gt;/.test(text) && !/0171|ayse@|<b>wirklich/.test(text) && / …“/.test(text));
  ok('Bericht mit Catering: Anfragen ohne Angebot, offene Angebote', /2 Anfragen ohne Angebot\./.test(text) && /3 Angebote sind offen, davon 1 Entwurf\./.test(text));
  ok('Bericht mit Firmen: 1 Antrag wartet', /1 Antrag wartet auf Prüfung, 1 davon neu in dieser Woche\./.test(text));
  ok('Bericht: Hinweis, wenn Wareneinsatz für beliebte Artikel fehlt', /Wareneinsatz fehlt für beliebte Artikel: Classic Burger, Pommes\./.test(text));
  ok('Bericht mit allem: keine Gedankenstriche, Ausrufezeichen nur im Zitat', ohneSlop(text.replace(/„[^“]*“/g, '')) && !/!/.test(text.replace(/„[^“]*“/g, '')));
  ok('Bericht passt in eine Telegram-Nachricht', text.length < 4000);
  ok('Woche berechnen: Sonntag 01.11.2026 -> 19.10. bis 25.10. (KW 43)', (() => { const w = wb.letzteWoche(Date.parse('2026-11-01T20:00:00Z')); return w.von === '2026-10-19' && w.bis === '2026-10-25' && w.kw === 43; })());
  ok('Woche berechnen: Montag 02.11.2026 08:00 -> 26.10. bis 01.11. (KW 44)', (() => { const w = wb.letzteWoche(Date.parse('2026-11-02T07:00:00Z')); return w.von === '2026-10-26' && w.bis === '2026-11-01' && w.kw === 44; })());

  /* ---- 7. Inhaber-Prüfung ------------------------------------------------ */
  let r = await call(team, { action: 'anmelden', password: 'kubi-test-passwort' });
  r = await call(team, { action: 'anmelden', password: 'kubi-test-passwort', einrichtung: r.d.einrichtung, code: codeJetzt(r.d.geheim) });
  const tokenKubi = r.d.token;
  ok('Kubi angemeldet (Passwort + Code)', /^gncs_/.test(tokenKubi || ''));
  await call(team, { action: 'add', password: tokenKubi, name: 'Admin Test', staffPassword: 'admin-glut-sesam-77', role: 'admin' });
  ip++;
  r = await call(team, { action: 'anmelden', password: 'admin-glut-sesam-77' });
  r = await call(team, { action: 'anmelden', password: 'admin-glut-sesam-77', einrichtung: r.d.einrichtung, code: codeJetzt(r.d.geheim) });
  const tokenAdmin = r.d.token;
  ok('Team-Admin angemeldet', /^gncs_/.test(tokenAdmin || ''));

  ip++;
  ok('Ohne Anmeldung -> 401', (await call(inhaber, { action: 'speisekarte' })).s === 401);
  ok('Reines Hauptpasswort ohne Code -> 401', (await call(inhaber, { action: 'speisekarte', password: 'kubi-test-passwort' })).s === 401);
  r = await call(inhaber, { action: 'speisekarte', password: tokenAdmin });
  ok('Team-Admin (nicht Inhaber) -> 403', r.s === 403 && r.d.error === 'forbidden');
  ok('Team-Admin darf Wareneinsatz nicht speichern -> 403', (await call(inhaber, { action: 'kosten_speichern', password: tokenAdmin, kosten: { classic: 2 } })).s === 403);
  ok('Team-Admin darf keinen Bericht senden -> 403', (await call(inhaber, { action: 'bericht_senden', password: tokenAdmin })).s === 403 && telegramPost.length === 0);
  const codeStaff = await geraet.erstelleCode({ role: 'admin', name: 'Truck-iPad' });
  const devStaff = await geraet.loeseEin(codeStaff.code, 'iPad');
  ok('Team-Gerät ohne Inhaber-Kopplung -> 403', (await call(inhaber, { action: 'speisekarte', teamToken: devStaff.token })).s === 403);
  const codeOwner = await geraet.erstelleCode({ role: 'admin', name: 'Kubi', owner: true });
  const devOwner = await geraet.loeseEin(codeOwner.code, 'iPhone');
  ok('Team-Gerät mit Inhaber-Kopplung -> 200', (await call(inhaber, { action: 'speisekarte', teamToken: devOwner.token })).s === 200);

  /* ---- 8. Speisekarte über 30 Tage, mit Zwischenspeicher ----------------- */
  tw._leereZwischenspeicher();
  for (const k of [...daten.keys()]) if (k.startsWith('cockpit|')) daten.delete(k);
  const heute = tw.berlinDate(Date.now());
  const gestern = tw.plusTage(heute, -1);
  bestellung(mittag(gestern), { korb: { a: menue, b: { menuId: 'cheese', qty: 1 } } });                       // 2 Menüs + 1 Cheese
  bestellung(mittag(tw.plusTage(heute, -5)), { korb: { a: { menuId: 'classic', qty: 3 } }, mode: 'delivery', quelle: 'telefon' });
  bestellung(mittag(tw.plusTage(heute, -30)), { korb: { a: { menuId: 'crispy', qty: 1 } }, quelle: 'truck' });   // noch im Fenster
  bestellung(mittag(tw.plusTage(heute, -31)), { korb: { a: { menuId: 'sucuk', qty: 4 } } });                     // knapp davor
  bestellung(mittag(tw.plusTage(heute, -60)), { korb: { a: { menuId: 'sucuk', qty: 9 } } });                     // alt
  bestellung(mittag(heute) - 6 * 3600000, { korb: { a: { menuId: 'kubis', qty: 5 } } });                      // heute zählt noch nicht
  lesen.length = 0;
  r = await call(inhaber, { action: 'speisekarte', password: tokenKubi });
  const art = (id) => (r.d.artikel || []).find((a) => a.id === id) || {};
  ok('Speisekarte: 200 mit Zeitraum 30 Tage bis gestern', r.s === 200 && r.d.zeitraum.bis === gestern && r.d.zeitraum.tage === 30);
  ok('Speisekarte: zählt Classic 5, Cheese 1, Crispy 1, Pommes 2 (aus Menüs)', art('classic').qty === 5 && art('cheese').qty === 1 && art('crispy').qty === 1 && art('pommes').qty === 2,
    JSON.stringify((r.d.artikel || []).filter((a) => a.qty).map((a) => [a.id, a.qty])));
  ok('Speisekarte: Tag 31, Tag 60 und heute zählen nicht', !art('sucuk').qty && !art('kubis').qty);
  ok('Speisekarte: 60 Tage alte Bestellung wird gar nicht gelesen', !lesen.some((x) => x === 'orders|o:GNC-' + mittag(tw.plusTage(heute, -60))));
  ok('Speisekarte: alle Artikel ohne Wareneinsatz grau (Hinweis)', r.d.tafeln.burger.punkte.classic.feld === null && r.d.tafeln.burger.punkte.classic.hinweis === 'Wareneinsatz fehlt.');
  ok('Tageswerte im Store cockpit zwischengespeichert', daten.has('cockpit|tag:v1:' + gestern) && JSON.parse(daten.get('cockpit|tag:v1:' + gestern)).final === true);
  tw._leereZwischenspeicher();
  lesen.length = 0;
  r = await call(inhaber, { action: 'speisekarte', password: tokenKubi });
  ok('Zweiter Aufruf (kalte Function): liest keine einzige Bestellung', r.s === 200 && !lesen.some((x) => x.startsWith('orders|o:')) && art('classic').qty === 5);

  /* ---- 9. Wareneinsatz speichern ----------------------------------------- */
  ok('Wareneinsatz: Text statt Zahl -> 400', (await call(inhaber, { action: 'kosten_speichern', password: tokenKubi, kosten: { classic: 'abc' } })).s === 400);
  ok('Wareneinsatz: negativ -> 400', (await call(inhaber, { action: 'kosten_speichern', password: tokenKubi, kosten: { classic: -1 } })).s === 400);
  ok('Wareneinsatz: über 50 € -> 400', (await call(inhaber, { action: 'kosten_speichern', password: tokenKubi, kosten: { classic: 80 } })).s === 400);
  ok('Wareneinsatz: unbekannter Artikel -> 400', (await call(inhaber, { action: 'kosten_speichern', password: tokenKubi, kosten: { '__proto__x': 1 } })).s === 400);
  r = await call(inhaber, { action: 'kosten_speichern', password: tokenKubi, kosten: { classic: '2,40', cheese: 2.9, pommes: 0.8, 'fritz-kola': 0.9, 'dip-mayo': 0.1, 'extra-double': 1.1 } });
  const k1 = JSON.parse(daten.get('kosten|artikel') || '{}');
  ok('Wareneinsatz gespeichert wie im Datenvertrag { id: { cost, updatedAt } }', r.s === 200 && k1.classic.cost === 2.4 && typeof k1.classic.updatedAt === 'string' && Object.keys(k1).length === 6);
  // Classic: 3 einzeln zu 8,00 €, 2 im Menü zu je 6,72 € Anteil -> Netto 7,00 €, DB 4,60 €;
  // Cheese: Netto 7,94 €, DB 5,04 €; Schnitt (5 x 4,60 + 1 x 5,04) / 6 = 4,67 €
  const cl2 = r.d.artikel.find((a) => a.id === 'classic');
  ok('Antwort enthält gleich die neue Auswertung (Classic Zugpferd, Cheese Renner)', cl2.cost === 2.4 && nah(cl2.db, 4.6, 0.011)
    && r.d.tafeln.burger.punkte.classic.feld === 'zugpferd' && r.d.tafeln.burger.punkte.cheese.feld === 'renner' && nah(r.d.tafeln.burger.schnittDb, 4.67, 0.011),
    JSON.stringify([cl2.db, r.d.tafeln.burger.schnittDb, r.d.tafeln.burger.punkte.classic.feld]));
  r = await call(inhaber, { action: 'kosten_speichern', password: tokenKubi, kosten: { pommes: null } });
  const k2 = JSON.parse(daten.get('kosten|artikel'));
  ok('Wareneinsatz: leer löscht den Wert, Rest bleibt mit altem Zeitstempel', !k2.pommes && k2.classic.updatedAt === k1.classic.updatedAt);

  /* ---- 10. Wochenbericht: Vorschau, Senden, geplanter Lauf --------------- */
  const woche = wb.letzteWoche(Date.now());
  tw._leereZwischenspeicher();
  for (const k of [...daten.keys()]) if (k.startsWith('cockpit|') || k.startsWith('orders|')) daten.delete(k);
  // Diese Woche: 3 Bestellungen, 60 €; Vorwoche: 2 Bestellungen, 50 €
  bestellung(mittag(woche.von), { korb: { a: { menuId: 'classic', qty: 2 } }, total: 20 });
  bestellung(mittag(tw.plusTage(woche.von, 2)), { korb: { a: { menuId: 'cheese', qty: 1 }, b: { menuId: 'pommes', qty: 1 } }, total: 25, mode: 'delivery', quelle: 'telefon' });
  bestellung(mittag(woche.bis), { korb: { a: { menuId: 'classic', qty: 1 } }, total: 15, quelle: 'truck' });
  bestellung(mittag(tw.plusTage(woche.von, -3)), { korb: { a: { menuId: 'classic', qty: 1 } }, total: 30 });
  bestellung(mittag(tw.plusTage(woche.von, -6)), { korb: { a: { menuId: 'classic', qty: 1 } }, total: 20 });
  telegramPost.length = 0;
  ip++;
  r = await call(inhaber, { action: 'bericht_vorschau', password: tokenKubi });
  ok('Vorschau: Text ohne Senden', r.s === 200 && /Wochenbericht KW/.test(r.d.text) && telegramPost.length === 0);
  ok('Vorschau: Umsatz 60 €, +20 % zur Vorwoche, 3 Bestellungen', /60,00 €\. \+20 % zur Vorwoche \(50,00 €\)\./.test(r.d.text) && /3 Bestellungen, Durchschnittsbon 20,00 €/.test(r.d.text), r.d.text);
  ok('Vorschau ohne Feedback/Catering/Firmen (Stores fehlen): Abschnitte fehlen', !/Feedback|Catering|Firmenkunden/.test(r.d.text));
  ok('Vorschau: Hinweis auf fehlenden Wareneinsatz (Pommes wurde gelöscht)', /Wareneinsatz fehlt für beliebte Artikel: Pommes/.test(r.d.text), r.d.text);

  // Fremde Bausteine nachbauen: Feedback, Catering mit Angeboten, Firmenanträge
  const vonMs = tw.berlinMitternacht(woche.von);
  daten.set('feedback|f:GNC-' + (vonMs + 3600000), JSON.stringify({ ref: 'GNC-1', stars: 5, text: 'Super', at: new Date(vonMs + 7200000).toISOString(), lang: 'de', art: 'pickup' }));
  const refMitName = 'GNC-' + mittag(tw.plusTage(woche.von, 2));   // Bestellung von Ayşe Yılmaz
  daten.set('feedback|f:' + refMitName, JSON.stringify({ ref: refMitName, stars: 2, text: 'Kalt. Ich bin AYŞE und war enttäuscht. Viele Grüße Ayşe Yılmaz, Tel 0171 2345678', at: new Date(vonMs + 2 * 864e5 + 3600000).toISOString(), lang: 'de', art: 'delivery' }));
  daten.set('feedback|f:GNC-' + (vonMs - 10 * 864e5), JSON.stringify({ ref: 'GNC-3', stars: 1, text: 'alt', at: new Date(vonMs - 10 * 864e5).toISOString() }));
  const jetztMs = Date.now();
  const zukunft = tw.plusTage(heute, 20);
  daten.set('catering|c:' + (jetztMs - 864e5) + '-aaaaaa', JSON.stringify({ name: 'Ayşe Yılmaz', email: 'ayse@example.com', date: zukunft, guests: '50', done: false }));
  daten.set('catering|c:' + (jetztMs - 2 * 864e5) + '-bbbbbb', JSON.stringify({ name: 'Max Muster', date: zukunft, done: false }));
  daten.set('catering|c:' + (jetztMs - 3 * 864e5) + '-cccccc', JSON.stringify({ name: 'Erledigt', date: zukunft, done: true }));
  daten.set('catering|c:' + (jetztMs - 4 * 864e5) + '-dddddd', JSON.stringify({ name: 'Vorbei', date: '2020-01-01', done: false }));
  daten.set('catering|angebot:1', JSON.stringify({ anfrage: 'c:' + (jetztMs - 2 * 864e5) + '-bbbbbb', status: 'gesendet', kunde: 'Max Muster' }));
  daten.set('catering|angebot:2', JSON.stringify({ status: 'angenommen' }));
  daten.set('firmen|antrag:abc', JSON.stringify({ firma: 'Muster GmbH', ansprechpartner: 'Erika Muster', status: 'neu', createdAt: new Date(vonMs + 864e5).toISOString() }));
  daten.set('firmen|antrag:def', JSON.stringify({ firma: 'Alt AG', status: 'freigegeben' }));

  ip++;
  r = await call(inhaber, { action: 'bericht_senden', password: tokenKubi });
  const gesendet = telegramPost[0] || {};
  ok('Bericht jetzt senden: genau eine Telegram-Nachricht als HTML', r.s === 200 && r.d.gesendet === true && telegramPost.length === 1 && gesendet.parse_mode === 'HTML');
  ok('Gesendet: Feedback 3,5 aus 2, schwächste 2 Sterne ohne Telefonnummer', /Schnitt 3,5 von 5 Sternen aus 2 Bewertungen\./.test(gesendet.text) && /Schwächste: 2 Sterne/.test(gesendet.text) && !/0171/.test(gesendet.text), gesendet.text);
  ok('Gesendet: 1 Anfrage ohne Angebot, 1 Angebot offen', /1 Anfrage ohne Angebot\./.test(gesendet.text) && /1 Angebot ist offen\./.test(gesendet.text));
  ok('Gesendet: 1 Firmenantrag wartet, neu in dieser Woche', /1 Antrag wartet auf Prüfung, 1 davon neu in dieser Woche\./.test(gesendet.text));
  ok('Gesendet: keine Kundennamen, Firmen oder Adressen (auch nicht im Zitat)', !/Ayşe|AYŞE|Yılmaz|Max Muster|Muster GmbH|Erika|ayse@|Gütersloher/i.test(gesendet.text), gesendet.text);
  ok('Gesendet: keine Gedankenstriche, Ausrufezeichen nur im Zitat', ohneSlop(gesendet.text.replace(/„[^“]*“/g, '')) && !/!/.test(gesendet.text.replace(/„[^“]*“/g, '')));

  for (let i = 0; i < 6; i++) await call(inhaber, { action: 'bericht_senden', password: tokenKubi }, '10.77.0.1');
  ok('Bericht jetzt senden: nach 6 Mal in 10 Minuten gebremst (429)', (await call(inhaber, { action: 'bericht_senden', password: tokenKubi }, '10.77.0.1')).s === 429);

  telegramPost.length = 0;
  let g = await geplant.handler({ body: JSON.stringify({ next_run: 'x' }) });
  ok('Geplanter Lauf: sendet den Bericht der Vorwoche', g.statusCode === 200 && telegramPost.length === 1 && telegramPost[0].text.includes('Wochenbericht KW ' + woche.kw));
  g = await geplant.handler({});
  ok('Geplanter Lauf: zweiter Lauf derselben Woche schickt nichts doppelt', g.statusCode === 200 && telegramPost.length === 1 && JSON.parse(g.body).schon === true);
  daten.delete('cockpit|wochenbericht:' + woche.von);
  delete process.env.TELEGRAM_BOT_TOKEN;
  g = await geplant.handler({});
  ok('Ohne Telegram-Zugang: kein Absturz, kein Merker', g.statusCode === 200 && !daten.has('cockpit|wochenbericht:' + woche.von));

  console.log('\n' + (n - fehler) + ' von ' + n + ' grün');
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.log('❌ Abbruch: ' + (e && e.stack)); process.exit(1); });
