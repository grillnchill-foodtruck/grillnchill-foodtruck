/**
 * wallet-api.js
 * ----------------------------------------------------------------------------
 * Apples Pass-Aktualisierungs-Dienst (Wallet Web Service Protocol).
 * iOS ruft diese Endpunkte selbst auf – erreichbar unter /wallet-api/v1/…
 * (Redirect in netlify.toml).
 *
 *   POST   v1/devices/{geraet}/registrations/{passTyp}/{serial}
 *          {pushToken} → Geraet abonniert Aktualisierungen fuer diesen Pass
 *   DELETE v1/devices/{geraet}/registrations/{passTyp}/{serial}
 *          → Abo beenden (Pass geloescht)
 *   GET    v1/devices/{geraet}/registrations/{passTyp}?passesUpdatedSince=t
 *          → Welche Passe dieses Geraets haben sich geaendert?
 *   GET    v1/passes/{passTyp}/{serial}   → aktuellen Pass ausliefern
 *   POST   v1/log                         → Fehlermeldungen von iOS (Log)
 *
 * Auth: Header "Authorization: ApplePass <token>" – das Token steckt im Pass
 * und wird je Seriennummer aus dem privaten Schluessel abgeleitet
 * (lib/apple-pass.js); nur unser Server kann es errechnen.
 *
 * Blobs-Store "wallet":
 *   serial:<serial>            → { k: emailHash }        (schreibt wallet-pass.js)
 *   reg:<serial>:<geraet>      → { pushToken, stand }    (Registrierung)
 *   devreg:<geraet>:<serial>   → '1'                     (Rueckrichtung fuers Listing)
 * Der Aenderungsstand eines Passes ist rec.walletStand (setzen die
 * Treue-Funktionen bei jeder Gutschrift/Einloesung).
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');
const applePass = require('./lib/apple-pass');

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}
const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});

function authOk(event, serial) {
  const h = event.headers || {};
  const auth = String(h.authorization || h.Authorization || '');
  const token = auth.replace(/^ApplePass\s+/i, '').trim();
  if (!token) return false;
  try { return token === applePass.authTokenFuer(serial); } catch (e) { return false; }
}

exports.handler = async (event) => {
  if (!applePass.konfiguriert()) return json(503, { error: 'not_configured' });

  // Pfad hinter der Function: /v1/…
  const pfad = (event.path || '')
    .replace(/^.*\/wallet-api/, '')
    .replace(/^\/\.netlify\/functions\/wallet-api/, '');
  const teile = pfad.split('/').filter(Boolean);   // ['v1', 'devices', …]
  const methode = event.httpMethod;

  // iOS meldet Probleme hierher – ins Function-Log, hilft bei der Fehlersuche
  if (methode === 'POST' && teile[1] === 'log') {
    try {
      const d = JSON.parse(event.body || '{}');
      (d.logs || []).forEach((z) => console.log('wallet-api log:', String(z).slice(0, 300)));
    } catch (e) {}
    return { statusCode: 200, body: '' };
  }

  // --- Registrierungen: v1/devices/{geraet}/registrations/{passTyp}[/{serial}]
  if (teile[1] === 'devices' && teile[3] === 'registrations') {
    const geraet = String(teile[2] || '').slice(0, 80);
    const passTyp = String(teile[4] || '');
    if (passTyp !== applePass.passTypeId()) return json(404, { error: 'unknown_pass_type' });

    if (methode === 'GET') {
      // Welche Passe dieses Geraets haben sich seit `passesUpdatedSince` geaendert?
      const seit = Number((event.queryStringParameters || {}).passesUpdatedSince || 0);
      const s = store('wallet');
      const { blobs } = await s.list({ prefix: 'devreg:' + geraet + ':' });
      const serials = [];
      let neuester = seit;
      for (const b of blobs) {
        const serial = b.key.slice(('devreg:' + geraet + ':').length);
        const zuord = await s.get('serial:' + serial, { type: 'json' });
        if (!zuord) continue;
        const rec = await store('customers').get('c:' + zuord.k, { type: 'json' });
        const stand = (rec && rec.walletStand) || 0;
        if (stand > seit) { serials.push(serial); if (stand > neuester) neuester = stand; }
      }
      if (!serials.length) return { statusCode: 204, body: '' };
      return json(200, { lastUpdated: String(neuester), serialNumbers: serials });
    }

    const serial = String(teile[5] || '').slice(0, 40);
    if (!serial || !authOk(event, serial)) return json(401, { error: 'unauthorized' });
    const s = store('wallet');

    if (methode === 'POST') {
      let pushToken = '';
      try { pushToken = String(JSON.parse(event.body || '{}').pushToken || '').slice(0, 200); } catch (e) {}
      if (!pushToken) return json(400, { error: 'missing_push_token' });
      const bekannt = await s.get('reg:' + serial + ':' + geraet, { type: 'json' });
      await s.setJSON('reg:' + serial + ':' + geraet, { pushToken, stand: Date.now() });
      await s.set('devreg:' + geraet + ':' + serial, '1');
      return { statusCode: bekannt ? 200 : 201, body: '' };
    }
    if (methode === 'DELETE') {
      await s.delete('reg:' + serial + ':' + geraet);
      await s.delete('devreg:' + geraet + ':' + serial);
      return { statusCode: 200, body: '' };
    }
  }

  // --- Aktueller Pass: v1/passes/{passTyp}/{serial}
  if (methode === 'GET' && teile[1] === 'passes') {
    const passTyp = String(teile[2] || '');
    const serial = String(teile[3] || '').slice(0, 40);
    if (passTyp !== applePass.passTypeId()) return json(404, { error: 'unknown_pass_type' });
    if (!authOk(event, serial)) return json(401, { error: 'unauthorized' });

    const zuord = await store('wallet').get('serial:' + serial, { type: 'json' });
    if (!zuord) return json(404, { error: 'unknown_serial' });
    const rec = await store('customers').get('c:' + zuord.k, { type: 'json' });
    if (!rec || !rec.qrToken) return json(404, { error: 'no_card' });

    // Nichts Neues seit dem letzten Abruf? Dann spart 304 die Signatur.
    const stand = rec.walletStand || 0;
    const seit = Date.parse((event.headers || {})['if-modified-since'] || '') || 0;
    if (stand && seit && stand <= seit) return { statusCode: 304, body: '' };

    const pkpass = applePass.bauePass(rec, zuord.k);
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.pkpass',
        'Last-Modified': new Date(stand || Date.now()).toUTCString(),
        'Cache-Control': 'no-store',
      },
      body: pkpass.toString('base64'),
      isBase64Encoded: true,
    };
  }

  return json(404, { error: 'not_found' });
};
