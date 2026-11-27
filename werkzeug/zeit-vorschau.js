#!/usr/bin/env node
/**
 * werkzeug/zeit-vorschau.js
 * ----------------------------------------------------------------------------
 * Lokale Vorschau fürs Stempeln: Cockpit (/cockpit), Handy-Tab (/zeit) und Datenschutzhinweis (/zeit/datenschutz)
 * mit echten Functions (team, team-device, cockpit-data, dienstplan, zeit) und einem Blob-Speicher im Arbeitsspeicher.
 * zeit.js spricht mit einem lokalen GNC Office (im gnc-office: npm run db:lokal && npm run dev, Port 8791).
 * Zwei-Faktor ist hier aus (ZWEI_FAKTOR=aus): Anmelden nur mit Passwort, nichts davon gilt live.
 *
 *   node werkzeug/seiten-bauen.js        (CSP-Hashes für cockpit.html, sonst blockt der Browser das Inline-Skript)
 *   OFFICE_ZEIT_SECRET="$(sed -n 's/^OFFICE_ZEIT_SECRET=//p' "/Users/pasqualesgro/Downloads/Claude Code/gnc-office-zeit/.dev.vars")" \
 *     node werkzeug/zeit-vorschau.js
 *
 *   http://localhost:8657/cockpit   Kubi: kubi-lokal (Admin, koppelt das iPad als Stempeluhr)
 *   http://localhost:8657/zeit      Ali: ali-lokal-passwort (Login ali-lokal, steht im Dienstplan)
 *   http://localhost:8657/dienstplan  Kubi: Team verwalten mit Feld „Team-Login“
 * Anderer Port: PORT=8658. Anderes Office: OFFICE_URL=http://localhost:8795
 * ----------------------------------------------------------------------------
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const F = path.join(ROOT, 'netlify', 'functions');
if (!process.env.OFFICE_ZEIT_SECRET) { console.error('OFFICE_ZEIT_SECRET fehlt (aus gnc-office/.dev.vars, siehe Kopf dieser Datei)'); process.exit(1); }
Object.assign(process.env, { ADMIN_PASSWORD: 'kubi-lokal', ZWEI_FAKTOR: 'aus', OFFICE_URL: process.env.OFFICE_URL || 'http://localhost:8791' });
delete process.env.NETLIFY_BLOBS_SITE_ID;

const daten = new Map();
const store = (name) => ({
  async get(k, o) { const v = daten.get(name + '|' + k); return v === undefined ? null : (o && o.type === 'json' ? JSON.parse(v) : v); },
  async setJSON(k, v) { daten.set(name + '|' + k, JSON.stringify(v)); },
  async set(k, v) { daten.set(name + '|' + k, String(v)); },
  async delete(k) { daten.delete(name + '|' + k); },
  async list({ prefix } = {}) { return { blobs: [...daten.keys()].filter((k) => k.startsWith(name + '|' + (prefix || ''))).map((k) => ({ key: k.slice(name.length + 1) })) }; },
});
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) { if (r === '@netlify/blobs') return '@netlify/blobs'; return orig.call(this, r, ...a); };
require.cache['@netlify/blobs'] = { id: '@netlify/blobs', exports: { getStore: (o) => store(typeof o === 'string' ? o : o.name) }, loaded: true };

const FUNKTIONEN = ['team', 'team-device', 'cockpit-data', 'dienstplan', 'zeit'];
const handler = Object.fromEntries(FUNKTIONEN.map((n) => [n, require(path.join(F, n + '.js')).handler]));
const SEITEN = { '/cockpit': 'cockpit.html', '/zeit': 'zeit.html', '/zeit/datenschutz': 'zeit-datenschutz.html', '/dienstplan': 'dienstplan.html' };
const TYP = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
const csp = () => { try { return (/Content-Security-Policy: (.*)/.exec(fs.readFileSync(path.join(ROOT, '_headers'), 'utf8')) || [])[1]; } catch (e) { return null; } };

async function anlegen() {
  const ruf = (n, body) => handler[n]({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '127.0.0.1' }, body: JSON.stringify(body) });
  await ruf('team', { action: 'add', password: 'kubi-lokal', name: 'Ali Lokal', staffPassword: 'ali-lokal-passwort' });
  const heute = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
  const t = new Date(heute + 'T12:00:00Z');
  const montag = new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
  await store('dienstplan').setJSON('personal', [
    { id: 'lok-ali', name: 'Ali', farbe: '#E85A24', login: 'ali-lokal' },
    { id: 'lok-bea', name: 'Bea', farbe: '#6DBE45' },
    { id: 'lok-cem', name: 'Cem', farbe: '#4FA3D1' },
  ]);
  await store('dienstplan').setJSON('w:' + montag, { schichten: { [heute]: [{ pid: 'lok-bea', von: '11:30', bis: '20:30', notiz: '' }, { pid: 'lok-ali', von: '16:00', bis: '21:00', notiz: '' }] } });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const fn = url.pathname.match(/^\/\.netlify\/functions\/([a-z-]+)$/);
  if (fn) {
    if (!handler[fn[1]]) { res.writeHead(404); return res.end('{}'); }
    let body = '';
    for await (const teil of req) body += teil;
    const r = await handler[fn[1]]({ httpMethod: req.method, headers: { ...req.headers, 'x-nf-client-connection-ip': '127.0.0.1' }, body, queryStringParameters: Object.fromEntries(url.searchParams) });
    res.writeHead(r.statusCode, r.headers || {});
    return res.end(r.body || '');
  }
  const datei = path.join(ROOT, SEITEN[url.pathname] || decodeURIComponent(url.pathname));
  if (!datei.startsWith(ROOT) || !fs.existsSync(datei) || !fs.statSync(datei).isFile()) { res.writeHead(404); return res.end('404'); }
  const kopf = { 'Content-Type': TYP[path.extname(datei)] || 'application/octet-stream', 'Cache-Control': 'no-store' };
  if (datei.endsWith('.html') && csp()) kopf['Content-Security-Policy'] = csp().replace('upgrade-insecure-requests', '');
  res.writeHead(200, kopf);
  fs.createReadStream(datei).pipe(res);
}).listen(Number(process.env.PORT) || 8657, async function () {
  await anlegen();
  console.log('zeit-vorschau auf http://localhost:' + this.address().port + '/cockpit und /zeit, Office ' + process.env.OFFICE_URL);
});
