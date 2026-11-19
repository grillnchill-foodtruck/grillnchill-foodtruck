/**
 * werkzeug/vorschau-bilder.mjs – winzige, unscharfe Vorschaubilder
 * ----------------------------------------------------------------------------
 * Erzeugt für jedes Foto eine 16 px breite Vorschau (WebP, als data:-URI) und
 * schreibt sie nach bild-vorschau.js. Der Browser zeigt sie hochskaliert und
 * damit weich, bis das echte Bild geladen ist – wie BlurHash, nur ohne
 * Dekodier-Skript. Braucht ffmpeg und cwebp (nur lokal, nicht beim Deploy).
 *
 *   node werkzeug/vorschau-bilder.mjs
 *
 * Neu ausführen, wenn Fotos in produktbilder/, bilder/ oder hero/ dazukommen.
 * ----------------------------------------------------------------------------
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WURZEL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUELLEN = [
  ...fs.readdirSync(path.join(WURZEL, 'produktbilder')).filter((f) => f.endsWith('.webp')).map((f) => 'produktbilder/' + f),
  ...fs.readdirSync(path.join(WURZEL, 'bilder')).filter((f) => f.endsWith('.webp')).map((f) => 'bilder/' + f),
  'hero/poster-780.webp',
];

// ffmpeg verkleinert (liest WebP), cwebp schreibt das winzige WebP
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gnc-vorschau-'));
const vorschau = {};
for (const rel of QUELLEN) {
  const png = path.join(tmp, 'v.png'), webp = path.join(tmp, 'v.webp');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', path.join(WURZEL, rel), '-vf', 'scale=16:-2:flags=area', '-frames:v', '1', png]);
  execFileSync('cwebp', ['-quiet', '-q', '55', png, '-o', webp]);
  vorschau[rel] = 'data:image/webp;base64,' + fs.readFileSync(webp).toString('base64');
}
fs.rmSync(tmp, { recursive: true, force: true });

const kopf = '/* bild-vorschau.js – ERZEUGT von werkzeug/vorschau-bilder.mjs, nicht von Hand ändern.\n'
  + '   Unscharfe Vorschau je Foto (16 px), bis das echte Bild geladen ist. */\n';
fs.writeFileSync(path.join(WURZEL, 'bild-vorschau.js'), kopf + 'window.GNC_VORSCHAU = ' + JSON.stringify(vorschau, null, 1) + ';\n');
const groesse = Object.values(vorschau).reduce((s, v) => s + v.length, 0);
console.log(`bild-vorschau.js: ${QUELLEN.length} Vorschauen, ${(groesse / 1024).toFixed(1)} KB`);
