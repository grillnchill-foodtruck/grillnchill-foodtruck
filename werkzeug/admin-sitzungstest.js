/**
 * werkzeug/admin-sitzungstest.js
 * ----------------------------------------------------------------------------
 * Prueft "angemeldet bleiben" im Admin-Tool gegen die echten Handler.
 *
 * Hintergrund: Der Browser legte dafuer frueher das Admin-Passwort im Klartext
 * in den localStorage – dreissig Tage, lesbar fuer jeden mit Zugriff aufs
 * Geraet. Jetzt merkt er sich einen Sitzungs-Token; das Passwort bleibt auf
 * dem Server. Siehe netlify/functions/lib/admin-sitzung.js.
 *
 * Zwei Dinge muessen gleichzeitig stimmen: der Token muss ueberall dort
 * funktionieren, wo bisher das Passwort stand (sechzehn Functions), und das
 * Passwort selbst muss weiter funktionieren – sonst sperrt ein Fehler hier
 * den Inhaber aus.
 *
 * Aufruf:  node werkzeug/admin-sitzungstest.js
 * Ausgang: 0 = alles in Ordnung
 * ----------------------------------------------------------------------------
 */

const path = require('path');
const Module = require('module');
const FUNCS = path.join(__dirname, '..', 'netlify', 'functions');

const daten = new Map();
Module._resolveFilename = ((o) => function (r, ...a) {
  if (r === '@netlify/blobs') return '@netlify/blobs';
  return o.call(this, r, ...a);
})(Module._resolveFilename);
require.cache['@netlify/blobs'] = { id: '@netlify/blobs', loaded: true, exports: { getStore: (o) => ({
  async get(k) { const v = daten.get(o.name + '|' + k); return v === undefined ? null : JSON.parse(v); },
  async setJSON(k, v) { daten.set(o.name + '|' + k, JSON.stringify(v)); },
  async delete(k) { daten.delete(o.name + '|' + k); },
  async list({ prefix } = {}) {
    return { blobs: [...daten.keys()].filter(k => k.startsWith(o.name + '|'))
      .map(k => k.slice(o.name.length + 1))
      .filter(k => !prefix || k.startsWith(prefix)).map(key => ({ key })) };
  },
}) } };
global.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

const PASSWORT = 'ein-sehr-langes-admin-passwort-2026';
process.env.ADMIN_PASSWORD = PASSWORT;

const team = require(path.join(FUNCS, 'team.js'));
const ordersList = require(path.join(FUNCS, 'orders-list.js'));
const revenue = require(path.join(FUNCS, 'revenue-stats.js'));
const shop = require(path.join(FUNCS, 'shop-status.js'));
const sitzung = require(path.join(FUNCS, 'lib', 'admin-sitzung.js'));

const post = (h, body) => h.handler({ httpMethod: 'POST', body: JSON.stringify(body), headers: {} });
const get = (h, q) => h.handler({ httpMethod: 'GET', queryStringParameters: q, headers: {} });
const zeile = (t, ok, extra = '') => { console.log('  ' + (ok ? '✅' : '❌') + ' ' + t.padEnd(50) + extra); return ok; };

(async () => {
  let alles = true;

  console.log('\n1) Anmelden und Sitzung anlegen\n');
  const r = JSON.parse((await post(team, { password: PASSWORT, action: 'sitzung' })).body);
  const token = r.token;
  alles &= zeile('Server gibt einen Token zurueck', !!token, String(token).slice(0, 18) + '…');
  alles &= zeile('Token ist NICHT das Passwort', token !== PASSWORT && !String(token).includes(PASSWORT));

  const abgelegt = JSON.stringify([...daten.entries()].filter(([k]) => k.startsWith('sitzungen|')));
  alles &= zeile('Passwort steht nirgends lesbar im Speicher', !abgelegt.includes(PASSWORT));
  alles &= zeile('Token selbst steht nicht im Speicher', !abgelegt.includes(token),
    'abgelegt ist nur sein Hash');

  console.log('\n2) Der Token oeffnet dieselben Tueren wie das Passwort\n');
  const mitToken = JSON.parse((await get(ordersList, { password: token, days: '30' })).body);
  alles &= zeile('orders-list (GET)', !mitToken.error, JSON.stringify(mitToken).slice(0, 40));
  // revenue-stats braucht einen Zeitraum und ist nur fuer den Inhaber –
  // ein 200 belegt damit gleich, dass der Token die volle Rolle traegt.
  const rev = await post(revenue, { password: token, from: '2026-08-01', to: '2026-08-16' });
  alles &= zeile('revenue-stats (POST, nur Inhaber)', rev.statusCode === 200, 'HTTP ' + rev.statusCode);
  const sh = await post(shop, { password: token, action: 'get' });
  alles &= zeile('shop-status (POST)', sh.statusCode !== 401, 'HTTP ' + sh.statusCode);
  const who = JSON.parse((await post(team, { password: token, action: 'whoami' })).body);
  alles &= zeile('team whoami erkennt die Rolle', who.role === 'superadmin', JSON.stringify(who));

  console.log('\n3) Das Passwort funktioniert unveraendert weiter\n');
  const pwOk = await get(ordersList, { password: PASSWORT, days: '30' });
  alles &= zeile('Anmeldung mit Passwort', pwOk.statusCode === 200, 'HTTP ' + pwOk.statusCode);
  const pwFalsch = await get(ordersList, { password: 'falsch', days: '30' });
  alles &= zeile('Falsches Passwort weiterhin abgewiesen', pwFalsch.statusCode === 401, 'HTTP ' + pwFalsch.statusCode);

  console.log('\n4) Erfundene und entwertete Tokens\n');
  const erfunden = 'gncs_' + 'a'.repeat(64);
  const e1 = await get(ordersList, { password: erfunden, days: '30' });
  alles &= zeile('Erfundener Token abgewiesen', e1.statusCode === 401, 'HTTP ' + e1.statusCode);

  await post(team, { password: token, action: 'abmelden' });
  const nachAbmelden = await get(ordersList, { password: token, days: '30' });
  alles &= zeile('Nach Abmelden ist der Token wertlos', nachAbmelden.statusCode === 401,
    'HTTP ' + nachAbmelden.statusCode);
  const pwDanach = await get(ordersList, { password: PASSWORT, days: '30' });
  alles &= zeile('Passwort danach weiterhin gueltig', pwDanach.statusCode === 200, 'HTTP ' + pwDanach.statusCode);

  console.log('\n5) Ausfallsicherheit – der Inhaber darf nie ausgesperrt werden\n');
  const t2 = JSON.parse((await post(team, { password: PASSWORT, action: 'sitzung' })).body).token;
  // Sitzung als abgelaufen markieren
  const crypto = require('crypto');
  const k = 'sitzungen|s:' + crypto.createHash('sha256').update(t2).digest('hex');
  const rec = JSON.parse(daten.get(k));
  rec.exp = new Date(Date.now() - 1000).toISOString();
  daten.set(k, JSON.stringify(rec));
  const abgelaufen = await get(ordersList, { password: t2, days: '30' });
  alles &= zeile('Abgelaufener Token abgewiesen', abgelaufen.statusCode === 401, 'HTTP ' + abgelaufen.statusCode);

  // Speicher komplett kaputt -> Passwortweg muss trotzdem gehen
  const echterGet = require('@netlify/blobs').getStore;
  require('@netlify/blobs').getStore = (o) => {
    if (o.name === 'sitzungen') return { async get() { throw new Error('Speicher weg'); },
      async setJSON() { throw new Error('Speicher weg'); }, async delete() {}, async list() { return { blobs: [] }; } };
    return echterGet(o);
  };
  const trotzdem = await get(ordersList, { password: PASSWORT, days: '30' });
  alles &= zeile('Sitzungsspeicher gestoert: Passwort geht weiter',
    trotzdem.statusCode === 200, 'HTTP ' + trotzdem.statusCode);
  require('@netlify/blobs').getStore = echterGet;

  console.log('\n6) Alle Anmeldestellen sind umgestellt\n');
  const fs = require('fs');
  const offen = fs.readdirSync(FUNCS).filter(f => f.endsWith('.js')).filter(f => {
    const s = fs.readFileSync(path.join(FUNCS, f), 'utf-8');
    return /await auth(Role|Admin)\(/.test(s) && /await auth(Role|Admin)\((?!await passwortAusSitzung)/.test(s);
  });
  alles &= zeile('Keine Anmeldestelle ohne Sitzungsaufloesung', offen.length === 0,
    offen.length ? offen.join(', ') : 'alle 16 Functions');

  console.log('\n' + '─'.repeat(70));
  console.log(alles ? 'ERGEBNIS: ✅ Token wirkt ueberall, Passwort bleibt der Notweg.'
                    : 'ERGEBNIS: ❌ siehe oben');
  process.exit(alles ? 0 : 1);
})();
