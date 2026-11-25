#!/usr/bin/env node
/**
 * werkzeug/office-ticket-test.js
 * Prüft die Ticket-Ausgabe fürs GNC Office: gleiches Format wie das Office
 * (Prüfvektor), nur Admins mit Zwei-Faktor-Sitzung, nie mit rohem Passwort.
 *   node werkzeug/office-ticket-test.js
 */
const path = require('path');
const Module = require('module');
const DATEN = new Map();
const store = (name) => ({
  async get(k, o) { const v = DATEN.get(name + '|' + k); return v === undefined ? null : (o && o.type === 'json' ? JSON.parse(v) : v); },
  async setJSON(k, v) { DATEN.set(name + '|' + k, JSON.stringify(v)); return { modified: true }; },
  async delete(k) { DATEN.delete(name + '|' + k); },
  async list({ prefix } = {}) { return { blobs: [...DATEN.keys()].filter((k) => k.startsWith(name + '|' + (prefix || ''))).map((k) => ({ key: k.slice(name.length + 1) })) }; },
});
const orig = Module._load;
Module._load = function (r, ...a) { if (r === '@netlify/blobs') return { getStore: (o) => store(typeof o === 'string' ? o : o.name) }; return orig.call(this, r, ...a); };
Object.assign(process.env, { ADMIN_PASSWORD: 'admin-test', OFFICE_TICKET_SECRET: 'testgeheimnis', OFFICE_URL: 'https://office.test' });
delete process.env.ZWEI_FAKTOR;

const F = path.join(__dirname, '..', 'netlify', 'functions');
const T = require(F + '/lib/office-ticket.js');
const sitzung = require(F + '/lib/admin-sitzung.js');
const { hashen } = require(F + '/lib/team-passwort.js');
const handler = require(F + '/office-ticket.js').handler;

let n = 0, fehler = 0;
const ok = (name, b, info) => { n++; if (!b) fehler++; console.log((b ? '✅ ' : '❌ ') + name + (b || info === undefined ? '' : '   → ' + JSON.stringify(info))); };
const ruf = async (body) => { const r = await handler({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '10.5.0.1' }, body: JSON.stringify(body) }); return { s: r.statusCode, d: JSON.parse(r.body) }; };
const VEKTOR = 'eyJ2IjoxLCJhdWQiOiJnbmMtb2ZmaWNlIiwic3ViIjoia3ViaSIsIm5hbWUiOiJLdWJpIiwicm9sbGUiOiJzdXBlcmFkbWluIiwiemYiOnRydWUsImlhdCI6MTc5ODc2MTYwMCwiZXhwIjoxNzk4NzYxNjYwLCJqdGkiOiIwMTIzNDU2Nzg5YWJjZGVmMDEyMzQ1Njc4OWFiY2RlZiJ9.SjsZnBA4r5wLROYJnAhCjQE55sqS5e3gTAY6Nl1YtgE';

(async () => {
  ok('Prüfvektor stimmt mit dem Office überein', T.signieren({ v: 1, aud: 'gnc-office', sub: 'kubi', name: 'Kubi', rolle: 'superadmin', zf: true, iat: 1798761600, exp: 1798761660, jti: '0123456789abcdef0123456789abcdef' }, 'testgeheimnis') === VEKTOR);

  const kubi = await sitzung.erstelle('admin-test', { role: 'admin', name: 'Kubi' }, { zweiFaktor: true });
  let r = await ruf({ password: kubi.token });
  const ticket = r.d.url && r.d.url.split('#t=')[1];
  const daten = ticket && JSON.parse(Buffer.from(ticket.split('.')[0], 'base64url').toString());
  ok('Kubi mit 2FA-Sitzung bekommt einen Link ins Office', r.s === 200 && r.d.url.startsWith('https://office.test/anmelden#t='), r);
  ok('… Ticket: Inhaber-Rolle, 60 Sekunden, mit 2FA-Vermerk, zufällige jti', daten && daten.sub === 'kubi' && daten.rolle === 'superadmin' && daten.exp - daten.iat === 60 && daten.zf === true && /^[a-f0-9]{32}$/.test(daten.jti), daten);

  DATEN.set('team|u:lena', JSON.stringify({ name: 'Lena', role: 'admin', pwHash: await hashen('lena-pw-1234') }));
  DATEN.set('team|u:tom', JSON.stringify({ name: 'Tom', role: 'staff', pwHash: await hashen('tom-pw-1234') }));
  const lena = await sitzung.erstelle('lena-pw-1234', { role: 'admin', name: 'Lena' }, { zweiFaktor: true });
  r = await ruf({ password: lena.token });
  const dl = JSON.parse(Buffer.from(r.d.url.split('#t=')[1].split('.')[0], 'base64url').toString());
  ok('Team-Admin Lena bekommt Rolle admin und ihren Slug', r.s === 200 && dl.sub === 'lena' && dl.rolle === 'admin', dl);

  const tom = await sitzung.erstelle('tom-pw-1234', { role: 'staff', name: 'Tom' }, { zweiFaktor: true });
  ok('Team ohne Admin-Rolle: 403', (await ruf({ password: tom.token })).s === 403);
  const ohne = await sitzung.erstelle('admin-test', { role: 'admin', name: 'Kubi' }, { zweiFaktor: false });
  ok('Sitzung ohne 2FA: kein Ticket', (await ruf({ password: ohne.token })).s !== 200);
  ok('Rohes Passwort statt Sitzung: 401', (await ruf({ password: 'admin-test' })).s === 401);

  delete process.env.OFFICE_TICKET_SECRET;
  ok('Ohne Geheimnis: 500 nicht_eingerichtet', (await ruf({ password: kubi.token })).d.error === 'nicht_eingerichtet');

  console.log('\n' + (n - fehler) + '/' + n + ' bestanden');
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
