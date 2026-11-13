#!/usr/bin/env node
/**
 * werkzeug/csp-test.js
 * ----------------------------------------------------------------------------
 * Prüft, ob die Seiten unter der strengen Content-Security-Policy laufen:
 *
 *   node werkzeug/seiten-bauen.js && node werkzeug/csp-test.js
 *
 * 1. Kein onclick="…" & Co. mehr, keine javascript:-Links, kein eval.
 * 2. Jedes data-on-*="…" lässt sich von ereignisse.js zerlegen, auch die,
 *    die erst per Template-String entstehen (${…} wird zu 0).
 * 3. Jede dort aufgerufene Funktion ist mit function name() deklariert.
 *    Ob sie wirklich am window hängt, zeigt erst der Browser:
 *    node werkzeug/csp-test.js --namen  gibt die Liste zum Prüfen aus.
 * 4. Seiten mit data-on-* laden ereignisse.js.
 * 5. _headers erlaubt jedes Inline-Skript per Hash und kein 'unsafe-inline'.
 * ----------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const W = path.join(__dirname, '..');
const lies = (f) => fs.readFileSync(path.join(W, f), 'utf8');

// ereignisse.js mit nachgebautem Browser laden, um den Zerleger zu bekommen
const fenster = {};
vm.runInNewContext(lies('ereignisse.js'), {
  window: fenster,
  document: { documentElement: {}, querySelectorAll: () => [], addEventListener() {} },
  MutationObserver: function () { this.observe = () => {}; },
  Map, WeakMap, Error, console,
});
const zerlegen = fenster.gncEreignisse.zerlegen;

const SEITEN = fs.readdirSync(W).filter((f) => f.endsWith('.html')).concat(fs.existsSync(path.join(W, 'tr/index.html')) ? ['tr/index.html'] : []);
const SKRIPTE = ['i18n.js', 'speisekarte.js', 'burger-jahr.js', 'admin-anmeldung.js', 'ereignisse.js'];
const EIGENE = { 'index.html': ['i18n.js', 'speisekarte.js', 'burger-jahr.js'], 'tr/index.html': ['i18n.js', 'speisekarte.js', 'burger-jahr.js'], 'firmen.html': ['i18n.js', 'speisekarte.js'],
  // Unterseiten seit 13.11.2026 mehrsprachig: Sprachwahl im Kopf ruft toggleLangDd aus i18n.js
  'halal.html': ['i18n.js'], 'catering.html': ['i18n.js'], 'liefergebiet.html': ['i18n.js', 'speisekarte.js'],
  'gutscheine.html': ['i18n.js', 'gutschein-shop.js'], '404.html': ['i18n.js'] };

let fehler = 0, n = 0;
const ok = (name, b, info) => { n++; console.log((b ? '✅ ' : '❌ ') + name + (b || !info ? '' : '\n   ' + info)); if (!b) fehler++; };

/* ---- 1. Keine Inline-Handler ------------------------------------------------ */
const ALT = /(?<![\w.$-])on[a-z]+=(\\?["'])/g;
for (const f of SEITEN.concat(SKRIPTE.filter((d) => d !== 'ereignisse.js'))) {   // dort nur in der Erklärung
  const s = lies(f);
  const reste = [...s.matchAll(ALT)].map((m) => s.slice(m.index, m.index + 50).replace(/\s+/g, ' '));
  ok(f + ': kein onclick & Co.', reste.length === 0, reste.slice(0, 3).join(' | '));
  ok(f + ': keine javascript:-Links, kein eval', !/href=["']javascript:|\beval\(|new Function\(/.test(s));
}

/* ---- 2./3. data-on-* zerlegbar, Funktionen deklariert ----------------------- */
const WERT = /data-on-([a-z]+)=(\\?["'])(.*?)(?<!\\)\2/g;
function ausQuelltext(roh) {
  return roh
    .replace(/\$\{[^}]*\}/g, '0')                          // Template: ${i} -> 0
    .replace(/\\?'\s*\+\s*[^+]+?\s*\+\s*\\?'/g, '0')      // 'a(\'' + x + '\')' -> a('0')
    .replace(/\\(['"])/g, '$1');
}
const namen = new Map();   // Funktionsname -> Seiten
for (const f of SEITEN.concat(SKRIPTE)) {
  const s = lies(f);
  const kaputt = [];
  for (const m of s.matchAll(WERT)) {
    if (/^\$\{\w+\}$/.test(m[3])) continue;   // ganzer Aufruf aus einer Variablen (appleKnopf), steht im Aufrufer
    const code = ausQuelltext(m[3]);
    try {
      const sammeln = (a) => {
        if (a.art === 'wenn') return sammeln(a.dann);
        if (a.art === 'ruf' && !a.feld) {
          if (!namen.has(a.fn)) namen.set(a.fn, new Set());
          namen.get(a.fn).add(f);
        }
      };
      zerlegen(code).forEach(sammeln);
    } catch (e) {
      kaputt.push(code + ' -> ' + e.message);
    }
  }
  ok(f + ': alle data-on-* zerlegbar', kaputt.length === 0, kaputt.slice(0, 3).join('\n   '));
}
const quelle = (f) => [f].concat(EIGENE[f] || (/^(admin|cockpit|dienstplan|firmen-admin)\.html$/.test(f) ? ['admin-anmeldung.js'] : [])).map(lies).join('\n');
const fehlend = [];
for (const [fn, wo] of namen) {
  for (const f of wo) {
    const seiten = SKRIPTE.includes(f) ? ['index.html'] : [f];
    for (const seite of seiten) {
      if (!new RegExp('(^|[\\s;}])(async\\s+)?function\\s+' + fn.replace('$', '\\$') + '\\s*\\(').test(quelle(seite))) fehlend.push(fn + ' (' + seite + ')');
    }
  }
}
ok('Aufgerufene Funktionen sind mit function deklariert (' + namen.size + ' Namen)', fehlend.length === 0, fehlend.join(', '));

/* ---- 4. ereignisse.js eingebunden ------------------------------------------ */
for (const f of SEITEN) {
  const s = lies(f);
  const braucht = /data-on-[a-z]+=/.test(s) || (EIGENE[f] || []).some((d) => /data-on-[a-z]+=/.test(lies(d)));
  if (braucht) ok(f + ': lädt ereignisse.js im <head>', /<script src="\/ereignisse\.js"><\/script>\s*<\/head>/.test(s));
}

/* ---- 5. _headers ----------------------------------------------------------- */
const kopf = fs.existsSync(path.join(W, '_headers')) ? lies('_headers') : '';
const policy = (/Content-Security-Policy: (.*)/.exec(kopf) || [])[1] || '';
const scriptSrc = (policy.split(';').find((d) => d.trim().startsWith('script-src')) || '');
ok('_headers vorhanden, script-src ohne unsafe-inline und unsafe-eval', !!scriptSrc && !/unsafe-inline|unsafe-eval/.test(scriptSrc));
const ohne = [];
for (const f of SEITEN) {
  for (const m of lies(f).matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    const attr = m[1] || '';
    if (/\ssrc\s*=/i.test(attr) || /type=["']?application\/ld\+json/i.test(attr)) continue;
    const h = "'sha256-" + crypto.createHash('sha256').update(m[2], 'utf8').digest('base64') + "'";
    if (!scriptSrc.includes(h)) ohne.push(f + ' (' + m[2].trim().slice(0, 40) + ')');
  }
}
ok('Jedes Inline-Skript steht mit Hash in der Policy', ohne.length === 0, ohne.join(', '));

if (process.argv.includes('--namen')) console.log(JSON.stringify(Object.fromEntries([...namen].map(([k, v]) => [k, [...v]]))));

console.log('\n' + (n - fehler) + ' von ' + n + (fehler ? ' – ' + fehler + ' FEHLER' : ' grün'));
process.exit(fehler ? 1 : 0);
