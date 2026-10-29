// werkzeug/vorschau-server.js
// Lokale Vorschau wie auf Netlify: /tr/* fällt auf das Hauptverzeichnis zurück
// (netlify.toml). Vorher `node werkzeug/seiten-bauen.js`, dann
// `node werkzeug/vorschau-server.js` und http://localhost:8644/tr/ öffnen.
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const TYP = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain' };
function datei(p) { let f = path.join(ROOT, decodeURIComponent(p)); if (p.endsWith('/')) f = path.join(f, 'index.html'); return fs.existsSync(f) && fs.statSync(f).isFile() ? f : null; }
http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  let f = datei(p);
  if (!f && p.startsWith('/tr/')) f = datei(p.slice(3));
  if (!f) { res.writeHead(404); return res.end('404'); }
  res.writeHead(200, { 'Content-Type': TYP[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}).listen(8644, () => console.log('tr-server 8644'));
