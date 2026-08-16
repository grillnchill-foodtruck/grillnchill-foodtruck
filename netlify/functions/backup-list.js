/**
 * backup-list.js
 * ----------------------------------------------------------------------------
 * Datensicherungen auflisten und herunterladen.
 *
 *   GET ?password=<Token oder Passwort>              → { ok, staende: [...] }
 *   GET ?password=...&stand=<ISO>                    → application/zip
 *   GET ?password=...&stand=jetzt                    → sofort neu erzeugen + ZIP
 *
 * ZUGRIFF: nur superadmin und admin – das Archiv enthält Namen, Anschriften,
 * Telefonnummern und die Passwort-Hashes der Team-Zugänge. Personal am Truck
 * bekommt 403.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung } = require('./lib/admin-sitzung');
const { sammle, baueArchiv, store } = require('./lib/sicherung');

/* Grenze der Function-Antwort liegt bei rund 6 MB, und die Base64-Kodierung
   bläht noch einmal um ein Drittel auf. Lieber ehrlich abweisen als einen
   abgeschnittenen Download ausliefern, den niemand entpacken kann. */
const MAX_BYTES = 4 * 1024 * 1024;

function teamStore() {
  const opts = { name: 'team', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

async function authRole(pw) {
  if (!pw) return null;
  const admin = process.env.ADMIN_PASSWORD || '';
  if (admin && pw === admin) return { role: 'superadmin', name: 'Kubi' };
  try {
    const t = teamStore();
    const { blobs } = await t.list({ prefix: 'u:' });
    const h = crypto.createHash('sha256').update(String(pw)).digest('hex');
    for (const b of blobs) {
      const u = await t.get(b.key, { type: 'json' });
      if (u && u.pwHash === h) {
        return { role: u.role === 'admin' ? 'admin' : 'staff', name: u.name || b.key.slice(2) };
      }
    }
  } catch (e) {}
  return null;
}

const json = (code, body) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  body: JSON.stringify(body),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { error: 'method_not_allowed' });
  const p = event.queryStringParameters || {};

  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;
  const who = await authRole(await passwortAusSitzung(p.password));
  await meldeErgebnis(event, !!who);
  if (!who) return json(401, { error: 'unauthorized' });
  if (who.role !== 'superadmin' && who.role !== 'admin') {
    return json(403, { error: 'forbidden', hint: 'Datensicherungen sind nur für Admins zugänglich' });
  }

  const s = store('backups');

  try {
    /* --- Liste --------------------------------------------------------- */
    if (!p.stand) {
      const { blobs } = await s.list({ prefix: 'kopf:' });
      const staende = [];
      for (const b of blobs) {
        const k = await s.get(b.key, { type: 'json' });
        if (k) staende.push(k);
      }
      staende.sort((a, b2) => String(b2.stand).localeCompare(String(a.stand)));
      return json(200, { ok: true, staende });
    }

    /* --- Sofort erzeugen ----------------------------------------------- */
    let zip;
    let stand;
    if (p.stand === 'jetzt') {
      const daten = await sammle();
      zip = baueArchiv(daten);
      stand = daten.stand;
    } else {
      // Nur das erwartete Muster zulassen – der Wert geht in den Schlüssel.
      stand = String(p.stand).replace(/[^0-9TZ:.\-]/g, '').slice(0, 30);
      if (!/^\d{4}-\d{2}-\d{2}T/.test(stand)) return json(400, { error: 'bad_stand' });
      const roh = await s.get('bak:' + stand, { type: 'arrayBuffer' });
      if (!roh) return json(404, { error: 'not_found' });
      zip = Buffer.from(roh);
    }

    if (zip.length > MAX_BYTES) {
      return json(413, {
        error: 'zu_gross',
        bytes: zip.length,
        hint: 'Das Archiv ist zu groß für einen direkten Download ('
          + (zip.length / 1048576).toFixed(1).replace('.', ',')
          + ' MB). Bitte über die Netlify-Blobs-API abholen – Speicher "backups", Schlüssel "bak:' + stand + '".',
      });
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="Grillnchill-Sicherung-${stand.slice(0, 10)}.zip"`,
        'Cache-Control': 'no-store',
        'X-Backup-Stand': stand,
        'Access-Control-Allow-Origin': '*',
      },
      body: zip.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (e) {
    console.error('backup-list:', e);
    return json(500, { error: 'server_error' });
  }
};
