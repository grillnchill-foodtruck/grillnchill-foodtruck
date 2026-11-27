#!/usr/bin/env node
/**
 * werkzeug/auslieferung-test.js
 * ----------------------------------------------------------------------------
 * Netlify liefert mit publish = "." das ganze Repo aus. Dieser Test prüft in
 * netlify.toml, dass interne Pfade per 404 gesperrt sind und dass die
 * gebrandete 404-Sammelregel die letzte Weiterleitung bleibt:
 *
 *   node werkzeug/auslieferung-test.js
 *
 * Gesperrt sein müssen alle getrackten Ordner und Dateien, die keine Seite und
 * kein Asset sind (Werkzeuge, Quellen der Functions, Notizen, Paketlisten).
 * Die Functions selbst laufen unter /.netlify/functions/ und bleiben offen.
 * ----------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const W = path.join(__dirname, '..');
let n = 0;
let fehler = 0;
const ok = (name, b, info) => { n++; console.log((b ? '✅ ' : '❌ ') + name + (b || !info ? '' : '\n   ' + info)); if (!b) fehler++; };

// Redirect-Blöcke in Reihenfolge lesen (einfacher Parser, reicht für netlify.toml)
const toml = fs.readFileSync(path.join(W, 'netlify.toml'), 'utf8');
const regeln = toml.split(/^\[\[redirects\]\]\s*$/m).slice(1).map((block) => {
  const wert = (k) => { const m = block.match(new RegExp('^\\s*' + k + '\\s*=\\s*(.+?)\\s*(#.*)?$', 'm')); return m ? m[1].replace(/^"|"$/g, '') : null; };
  return { from: wert('from'), to: wert('to'), status: wert('status'), force: wert('force') };
});

const letzte = regeln[regeln.length - 1] || {};
ok('404-Sammelregel ist die letzte Weiterleitung', letzte.from === '/*' && letzte.status === '404', JSON.stringify(letzte));

const PFLICHT = ['/werkzeug/*', '/netlify/*', '/docs/*', '/package.json', '/package-lock.json'];
for (const p of PFLICHT) {
  const i = regeln.findIndex((r) => r.from === p);
  const r = regeln[i] || {};
  ok(p + ' ist per 404 mit force gesperrt', i >= 0 && r.status === '404' && r.force === 'true' && i < regeln.length - 1, JSON.stringify(r));
}

ok('Die Functions unter /.netlify/ bleiben offen', !regeln.some((r) => r.from && r.from.startsWith('/.netlify') && r.status === '404'));

// Jeder getrackte Top-Level-Ordner ist entweder ausgeliefertes Asset oder gesperrt
const OEFFENTLICH = new Set(['.well-known', 'badges', 'bilder', 'fonts', 'hero', 'img', 'marke', 'produktbilder', 'vendor', 'tr']);
let dateien = [];
try { dateien = execFileSync('git', ['ls-files'], { cwd: W, encoding: 'utf8' }).split('\n').filter(Boolean); } catch (e) {}
const ordner = [...new Set(dateien.filter((f) => f.includes('/')).map((f) => f.split('/')[0]))];
const ungeklaert = ordner.filter((o) => !OEFFENTLICH.has(o) && !regeln.some((r) => r.from === '/' + o + '/*' && r.status === '404'));
ok('Jeder getrackte Ordner ist Asset oder gesperrt', dateien.length === 0 || ungeklaert.length === 0, 'neu und ungeklärt: ' + ungeklaert.join(', '));

console.log('\n' + (fehler ? n - fehler + ' von ' + n + ' grün, ' + fehler + ' FEHLER' : '✅ Alle ' + n + ' Prüfungen grün'));
process.exit(fehler ? 1 : 0);
