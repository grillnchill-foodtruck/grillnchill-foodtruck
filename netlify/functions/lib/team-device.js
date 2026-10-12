/**
 * lib/team-device.js
 * ----------------------------------------------------------------------------
 * Team-Geraete koppeln: Apple Watch und Cockpit-Widget von Kubi.
 *
 * Eine Uhr hat keine Tastatur fuer das Admin-Passwort, und ein Widget soll
 * es nicht kennen. Deshalb bekommt jedes Geraet einen eigenen, zufaelligen
 * Token, den der Admin jederzeit einzeln widerrufen kann.
 *
 * Ablauf
 *   1. Admin erzeugt im Admin-Tool einen 6-stelligen Code (10 Min gueltig).
 *   2. Die App loest den Code einmalig ein und bekommt den Token.
 *   3. Danach schickt die App nur noch den Token (orders-list, order-status).
 *
 * Ablage im Store "team-devices":
 *   pair:<code>          { role, name, exp }        exp = Unix-ms, einmalig
 *   dev:<sha256(token)>  { id, role, name, device, createdAt, lastSeen }
 *
 * Der Token selbst steht nirgends im Speicher, nur sein Hash. Wer den Store
 * liest, kann damit nichts anfangen.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const CODE_GUELTIG_MS = 10 * 60 * 1000;
/* lastSeen nur alle 10 Minuten schreiben: die Uhr fragt oft, jeder Aufruf
   waere sonst ein Schreibzugriff. */
const LASTSEEN_TAKT_MS = 10 * 60 * 1000;

function store() {
  const opts = { name: 'team-devices', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');
const TOKEN_FORM = /^[A-Za-z0-9_-]{43}$/;   // 32 Byte als base64url

function saubererText(x, max) {
  return String(x == null ? '' : x)
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Neuen Kopplungscode anlegen.
 * @param {{role:string, name:string}} who  der Admin, der koppelt
 * @returns {Promise<{code:string, expiresAt:string}>}
 */
async function erstelleCode(who) {
  const s = store();
  const jetzt = Date.now();

  // Abgelaufene Codes nebenbei wegraeumen (es sind nie viele)
  try {
    const { blobs } = await s.list({ prefix: 'pair:' });
    for (const b of blobs) {
      const p = await s.get(b.key, { type: 'json' });
      if (!p || !p.exp || jetzt > Number(p.exp)) {
        try { await s.delete(b.key); } catch (e) {}
      }
    }
  } catch (e) {}

  for (let i = 0; i < 8; i++) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const key = 'pair:' + code;
    const vorhanden = await s.get(key, { type: 'json' });
    if (vorhanden && Number(vorhanden.exp) > jetzt) continue;   // zufaellig belegt
    const exp = jetzt + CODE_GUELTIG_MS;
    await s.setJSON(key, {
      role: (who && who.role) === 'admin' ? 'admin' : 'staff',
      name: saubererText(who && who.name, 40) || 'Team',
      owner: !!(who && who.owner),   // mit dem Hauptpasswort gekoppelt: darf Umsatz sehen (Cockpit)
      exp,
    });
    return { code, expiresAt: new Date(exp).toISOString() };
  }
  throw new Error('kein_freier_code');
}

/**
 * Code einloesen. Gelingt genau einmal und nur innerhalb der Frist.
 * @returns {Promise<{token:string, name:string, role:string, id:string}|null>}
 */
async function loeseEin(code, device) {
  const c = String(code == null ? '' : code).replace(/\D/g, '');
  if (c.length !== 6) return null;
  const s = store();
  const key = 'pair:' + c;
  const p = await s.get(key, { type: 'json' });
  if (!p) return null;
  // Sofort loeschen: ein Code gilt nur einmal, auch wenn danach etwas scheitert
  try { await s.delete(key); } catch (e) {}
  if (!p.exp || Date.now() > Number(p.exp)) return null;

  const token = crypto.randomBytes(32).toString('base64url');
  const jetzt = new Date().toISOString();
  const rec = {
    id: crypto.randomBytes(4).toString('hex'),
    role: p.role === 'admin' ? 'admin' : 'staff',
    name: saubererText(p.name, 40) || 'Team',
    device: saubererText(device, 40) || 'Gerät',
    owner: !!p.owner,
    createdAt: jetzt,
    lastSeen: jetzt,
  };
  await s.setJSON('dev:' + sha(token), rec);
  return { token, name: rec.name, role: rec.role, id: rec.id, owner: rec.owner };
}

/**
 * Token pruefen.
 * @returns {Promise<{role:string, name:string, id:string, device:string, owner:boolean}|null>}
 */
async function pruefeTeamToken(token) {
  const t = String(token == null ? '' : token).trim();
  if (!TOKEN_FORM.test(t)) return null;
  try {
    const s = store();
    const key = 'dev:' + sha(t);
    const rec = await s.get(key, { type: 'json' });
    if (!rec || !rec.id) return null;
    const jetzt = Date.now();
    const zuletzt = Date.parse(rec.lastSeen || '') || 0;
    if (jetzt - zuletzt > LASTSEEN_TAKT_MS) {
      rec.lastSeen = new Date(jetzt).toISOString();
      try { await s.setJSON(key, rec); } catch (e) {}
    }
    return { role: rec.role === 'admin' ? 'admin' : 'staff', name: rec.name || 'Team', id: rec.id, device: rec.device || '', owner: !!rec.owner };
  } catch (e) {
    console.error('team-device pruefen:', e && e.message);
    return null;
  }
}

/** Alle gekoppelten Geraete, neueste zuerst. */
async function liste() {
  const s = store();
  const { blobs } = await s.list({ prefix: 'dev:' });
  const out = [];
  for (const b of blobs) {
    const r = await s.get(b.key, { type: 'json' });
    if (!r || !r.id) continue;
    out.push({
      id: r.id,
      device: r.device || '',
      name: r.name || '',
      createdAt: r.createdAt || null,
      lastSeen: r.lastSeen || null,
    });
  }
  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return out;
}

/**
 * Ein Geraet entkoppeln.
 * @returns {Promise<{id:string, device:string, name:string}|null>} null = nicht gefunden
 */
async function widerrufe(id) {
  const want = String(id == null ? '' : id).toLowerCase();
  if (!/^[a-f0-9]{8}$/.test(want)) return null;
  const s = store();
  const { blobs } = await s.list({ prefix: 'dev:' });
  for (const b of blobs) {
    const r = await s.get(b.key, { type: 'json' });
    if (r && r.id === want) {
      await s.delete(b.key);
      return { id: r.id, device: r.device || '', name: r.name || '' };
    }
  }
  return null;
}

module.exports = { erstelleCode, loeseEin, pruefeTeamToken, liste, widerrufe, CODE_GUELTIG_MS };
