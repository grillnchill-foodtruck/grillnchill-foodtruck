#!/usr/bin/env node
/**
 * werkzeug/app-leiste-test.js
 * Team-Leiste der App (app-leiste.js) je nach Rolle: Mitarbeiter (gnc_team_rolle = staff) sehen „Zeit“ statt
 * „Cockpit“, Admin und unbekannte Rolle behalten das Cockpit, nie mehr als fünf Tabs. Dazu: Die Rolle merkt
 * admin-anmeldung.js beim Anmelden. Läuft in einer VM mit nachgebautem localStorage und iOS-Brücke.
 *   node werkzeug/app-leiste-test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let n = 0, fehler = 0;
const ok = (name, b, info) => { n++; if (!b) fehler++; console.log((b ? '✅ ' : '❌ ') + name + (b || info === undefined ? '' : '   → ' + JSON.stringify(info))); };
const quelle = (datei) => fs.readFileSync(path.join(__dirname, '..', datei), 'utf8');
const speicher = (start) => { const m = new Map(Object.entries(start || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

function leiste(storage, o) {
  const nachrichten = [];
  const window = {
    webkit: { messageHandlers: { gncTabs: { postMessage: (m) => nachrichten.push(m) } } },
    matchMedia: () => ({ matches: false }),
    localStorage: storage,
  };
  const ctx = {
    window, localStorage: storage, location: { search: '?app=1', href: '' },
    document: { getElementById: () => null, documentElement: { classList: { toggle() {} } }, querySelector: () => null, body: {} },
    matchMedia: window.matchMedia, MutationObserver: function () { this.observe = () => {}; }, requestAnimationFrame: (f) => f(),
  };
  vm.createContext(ctx);
  vm.runInContext(quelle('app-leiste.js'), ctx);
  const l = window.GNCAppLeiste.start(Object.assign({ modus: 'team', selected: 'heute' }, o));
  return { nachrichten, window, ctx, l };
}
const tabIds = (r) => (r.nachrichten.find((m) => m.type === 'configure') || { tabs: [] }).tabs.map((t) => t.id).join();

/* ---- Leiste je Rolle ---- */
const staff = leiste(speicher({ gnc_team_rolle: 'staff' }));
ok('staff: heute, orders, zeit, fahrer, mehr', tabIds(staff) === 'heute,orders,zeit,fahrer,mehr', tabIds(staff));
const zeit = staff.nachrichten[0].tabs.find((t) => t.id === 'zeit');
ok('Tab Zeit hat Symbol clock und Beschriftung Zeit', zeit && zeit.symbol === 'clock' && zeit.label === 'Zeit', zeit);
ok('Höchstens fünf Tabs (staff)', staff.nachrichten[0].tabs.length === 5);

const admin = leiste(speicher({ gnc_team_rolle: 'admin' }));
ok('admin: heute, orders, cockpit, fahrer, mehr', tabIds(admin) === 'heute,orders,cockpit,fahrer,mehr', tabIds(admin));
const leer = leiste(speicher());
ok('Rolle unbekannt: Leiste mit Cockpit', tabIds(leer) === 'heute,orders,cockpit,fahrer,mehr', tabIds(leer));
const wirr = leiste(speicher({ gnc_team_rolle: 'irgendwas' }));
ok('Unbekannter Wert: Leiste mit Cockpit', tabIds(wirr) === 'heute,orders,cockpit,fahrer,mehr', tabIds(wirr));
const kaputt = leiste({ getItem() { throw new Error('gesperrt'); }, setItem() { throw new Error('gesperrt'); } });
ok('localStorage wirft: Leiste mit Cockpit, kein Absturz', tabIds(kaputt) === 'heute,orders,cockpit,fahrer,mehr', tabIds(kaputt));

/* ---- Auswahl und Ziel ---- */
const sel = leiste(speicher({ gnc_team_rolle: 'staff' }), { selected: 'zeit' });
ok('selected zeit wird gemeldet', sel.nachrichten[0].selected === 'zeit');
sel.window.gncNativeTabSelect('zeit');
ok('Tipp auf Zeit öffnet /zeit?app=1', sel.ctx.location.href === '/zeit?app=1', sel.ctx.location.href);
admin.window.gncNativeTabSelect('cockpit');
ok('Tipp auf Cockpit öffnet /cockpit.html?app=1', admin.ctx.location.href === '/cockpit.html?app=1', admin.ctx.location.href);

/* ---- Leiste neu bestimmen (direkt nach der Anmeldung) ---- */
{
  const sp = speicher();
  const l = leiste(sp);
  const vorher = l.nachrichten.length;
  l.window.GNCAppLeiste.neu();
  ok('neu() ohne geänderte Rolle meldet nichts', l.nachrichten.length === vorher);
  sp.setItem('gnc_team_rolle', 'staff');
  l.window.GNCAppLeiste.neu();
  const letzte = l.nachrichten[l.nachrichten.length - 1];
  ok('neu() nach Rolle staff meldet Leiste mit Zeit', l.nachrichten.length === vorher + 1 && letzte.tabs.map((t) => t.id).join() === 'heute,orders,zeit,fahrer,mehr', letzte.tabs.map((t) => t.id).join());
  sp.setItem('gnc_team_rolle', 'admin');
  l.l.neu();
  ok('Rückgabe-Objekt neu(): admin wieder mit Cockpit', l.nachrichten[l.nachrichten.length - 1].tabs.map((t) => t.id).join() === 'heute,orders,cockpit,fahrer,mehr');
}

/* ---- Kunden-Leiste bleibt unberührt ---- */
const kunde = leiste(speicher({ gnc_team_rolle: 'staff' }), { modus: undefined });
ok('Kunden-Leiste ohne Team-Tabs', !/zeit|cockpit/.test(tabIds(kunde)), tabIds(kunde));

/* ---- Rolle merken: admin-anmeldung.js ---- */
function anmeldung(antwort) {
  const storage = speicher();
  const window = { localStorage: storage };
  const ctx = {
    window, localStorage: storage, sessionStorage: speicher(), document: { createElement: () => ({}), body: {}, addEventListener() {} },
    fetch: async () => ({ status: 200, json: async () => antwort }),
    location: { search: '' }, setTimeout, clearTimeout, console,
  };
  vm.createContext(ctx);
  vm.runInContext(quelle('admin-anmeldung.js'), ctx);
  return { storage, window, api: window.GNCAnmeldung };
}
(async () => {
  // Weg über das Cockpit: GNCAnmeldung.rolleMerken (cockpit.html ruft sie mit d.role auf) und Leiste neu
  for (const [rolle, erwartet] of [['staff', 'staff'], ['admin', 'admin'], ['superadmin', 'admin'], ['team', null], ['', null], [undefined, null]]) {
    const a = anmeldung({});
    let neu = 0;
    a.window.GNCAppLeiste = { neu: () => neu++ };
    a.api.rolleMerken(rolle);
    ok('rolleMerken(' + JSON.stringify(rolle) + ') merkt ' + (erwartet || '(nichts)') + (erwartet ? ' und meldet die Leiste neu' : ''), a.storage.getItem('gnc_team_rolle') === erwartet && neu === (erwartet ? 1 : 0), { gemerkt: a.storage.getItem('gnc_team_rolle'), neu });
  }
  for (const [rolle, erwartet] of [['staff', 'staff'], ['admin', 'admin'], ['superadmin', 'admin'], ['team', null]]) {
    const a = anmeldung({ ok: true, token: 'x'.repeat(64), exp: 1, role: rolle, name: 'N' });
    let r;
    try { r = await a.api.anmelden('pw', { merken: false }); } catch (e) { r = { ok: false, fehler: String(e) }; }
    ok('Anmelden als ' + rolle + ' merkt Rolle ' + (erwartet || '(nichts)'), a.storage.getItem('gnc_team_rolle') === erwartet, { r: r && r.ok, gemerkt: a.storage.getItem('gnc_team_rolle') });
  }
  console.log('\n' + (n - fehler) + '/' + n + ' bestanden');
  process.exit(fehler ? 1 : 0);
})();
