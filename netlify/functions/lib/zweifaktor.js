/**
 * lib/zweifaktor.js
 * ----------------------------------------------------------------------------
 * Zwei-Faktor-Anmeldung für Admin-Tool, Dienstplan und Cockpit.
 *
 * Zweiter Faktor ist ein 6-stelliger Code aus einer Authenticator-App
 * (TOTP nach RFC 6238: Apple Passwörter, Google Authenticator, 1Password …).
 * Kein SMS, keine Mail: beides kostet Geld oder hängt an einem Dienst, und
 * ein Code aus der App funktioniert auch ohne Netz am Truck.
 *
 * WIE ES DURCHGESETZT WIRD
 * ------------------------
 * Das Admin-Tool schickt bei jeder Anfrage seinen Nachweis mit, und 23
 * Functions prüfen ihn einzeln (authRole, siehe lib/admin-sitzung.js). Ein
 * Code nur beim Anmeldebildschirm hätte deshalb nichts geschützt: Das
 * Passwort allein hätte jede Function weiter geöffnet. Deshalb gilt:
 *
 *   - Nur team.js (action "anmelden") nimmt noch ein Passwort an, und nur
 *     zusammen mit einem gültigen Code.
 *   - Dafür gibt es eine Sitzung mit dem Vermerk zf: true.
 *   - lib/admin-sitzung.js löst nur noch solche Sitzungen auf. Ein reines
 *     Passwort und alte Sitzungen ohne Vermerk werden zu '' und scheitern in
 *     jeder authRole.
 *
 * NOTSCHALTER: Netlify-Umgebungsvariable ZWEI_FAKTOR=aus und neu deployen.
 * Dann gilt wieder das Passwort allein, eingerichtete Apps bleiben gespeichert.
 *
 * SPEICHER (Blob-Store "team")
 *   zf:<konto>        { geheim, seit, letzterSchritt, notfall: [sha256], fehl, fehlSeit, gesperrtBis }
 *   zfneu:<sha256>    angefangene Einrichtung, 10 Minuten gültig
 *   <konto> ist "superadmin" (ADMIN_PASSWORD) oder "u:<slug>" wie in team.js.
 *
 * Das Geheimnis liegt im Klartext im Speicher, so wie die Passwort-Hashes
 * daneben: Es gibt keinen Lese-Endpunkt, und wer diesen Speicher lesen kann,
 * kommt ohnehin an alles andere. Notfallcodes nur als Hash.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');

const AUSSTELLER = "Grill'n Chill";
const SCHRITT_S = 30;
const STELLEN = 6;
const EINRICHTUNG_MS = 10 * 60 * 1000;
// Eigene Bremse je Konto, zusätzlich zur Bremse je Absender in lib/auth-guard.js:
// Wer das Passwort kennt und den Code über viele Adressen errät, stößt hier an.
const KONTO_FEHL_MAX = 10;
const KONTO_SPERRE_MS = 15 * 60 * 1000;
const NOTFALL_ANZAHL = 8;

function pflicht() {
  return String(process.env.ZWEI_FAKTOR || '').toLowerCase() !== 'aus';
}

function store() {
  const opts = { name: 'team', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

/** Gleiche Regel wie team.js – der Schlüssel eines Team-Zugangs ist "u:" + slug(name). */
const slug = (name) => String(name || '').trim().toLowerCase().replace(/[^a-z0-9äöüß-]/g, '-').slice(0, 30);

/** Konto zum Ergebnis von authRole. */
function kontoVon(who) {
  if (!who) return null;
  return who.role === 'superadmin' ? 'superadmin' : 'u:' + slug(who.name);
}

/* ---- Base32 (RFC 4648, ohne Auffüllen) ---------------------------------- */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = 0, wert = 0, aus = '';
  for (const b of buf) {
    wert = (wert << 8) | b; bits += 8;
    while (bits >= 5) { aus += ALPHABET[(wert >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) aus += ALPHABET[(wert << (5 - bits)) & 31];
  return aus;
}
function base32lesen(text) {
  const t = String(text).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, wert = 0;
  const aus = [];
  for (const z of t) {
    wert = (wert << 5) | ALPHABET.indexOf(z); bits += 5;
    if (bits >= 8) { aus.push((wert >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(aus);
}

/* ---- TOTP (RFC 6238 mit HMAC-SHA1, 30 s, 6 Stellen) ---------------------- */
function hotp(schluessel, zaehler, stellen = STELLEN) {
  const z = Buffer.alloc(8);
  z.writeBigUInt64BE(BigInt(zaehler));
  const h = crypto.createHmac('sha1', schluessel).update(z).digest();
  const o = h[h.length - 1] & 0x0f;
  const zahl = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(zahl % 10 ** stellen).padStart(stellen, '0');
}
const schrittVon = (ms) => Math.floor(ms / 1000 / SCHRITT_S);

function gleich(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Code gegen das Geheimnis prüfen. Akzeptiert den aktuellen Schritt und je
 * einen davor und danach (Uhren gehen nicht genau gleich). Jeder Schritt
 * gilt nur einmal: ein mitgelesener Code lässt sich nicht nachspielen.
 * @returns {number|null} der passende Schritt oder null
 */
function codeSchritt(geheim, code, letzterSchritt, jetzt = Date.now()) {
  const c = String(code || '').replace(/\D/g, '');
  if (c.length !== STELLEN) return null;
  const k = base32lesen(geheim);
  const s = schrittVon(jetzt);
  for (const d of [0, -1, 1]) {
    const schritt = s + d;
    if (letzterSchritt != null && schritt <= letzterSchritt) continue;
    if (gleich(hotp(k, schritt), c)) return schritt;
  }
  return null;
}

function otpauthUrl(anzeigeName, geheim) {
  const label = encodeURIComponent(AUSSTELLER + ':' + anzeigeName);
  return `otpauth://totp/${label}?secret=${geheim}&issuer=${encodeURIComponent(AUSSTELLER)}&algorithm=SHA1&digits=${STELLEN}&period=${SCHRITT_S}`;
}

/* ---- Notfallcodes: einmalig, für ein verlorenes Handy ------------------- */
// Ohne Zeichen, die man beim Abtippen verwechselt (i, l, o, 0, 1)
const NOTFALL_ZEICHEN = 'abcdefghjkmnpqrstuvwxyz23456789';
const notfallNorm = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function neueNotfallCodes() {
  return Array.from({ length: NOTFALL_ANZAHL }, () => {
    let roh = '';
    for (let i = 0; i < 10; i++) roh += NOTFALL_ZEICHEN[crypto.randomInt(NOTFALL_ZEICHEN.length)];
    return roh.slice(0, 5) + '-' + roh.slice(5);
  });
}

/* ---- Speicher ----------------------------------------------------------- */
async function lies(konto) {
  return (await store().get('zf:' + konto, { type: 'json' })) || null;
}

async function istEingerichtet(konto) {
  const rec = await lies(konto);
  return !!(rec && rec.geheim);
}

/** Neue Einrichtung beginnen. Das Geheimnis gilt erst, wenn ein Code dazu passt. */
async function einrichtungStarten(konto, anzeigeName) {
  const geheim = base32(crypto.randomBytes(20));
  const einrichtung = 'gncz_' + crypto.randomBytes(24).toString('hex');
  await store().setJSON('zfneu:' + sha(einrichtung), {
    konto, geheim, exp: new Date(Date.now() + EINRICHTUNG_MS).toISOString(),
  });
  return { einrichtung, geheim, url: otpauthUrl(anzeigeName || konto, geheim) };
}

/**
 * Einrichtung mit dem ersten Code aus der App abschließen.
 * @returns {{ok:true, notfallCodes:string[]} | {ok:false, grund:'abgelaufen'|'falsch'}}
 */
async function einrichtungAbschliessen(einrichtung, konto, code) {
  const s = store();
  const key = 'zfneu:' + sha(String(einrichtung || ''));
  const neu = await s.get(key, { type: 'json' });
  if (!neu || neu.konto !== konto || Date.now() > new Date(neu.exp).getTime()) return { ok: false, grund: 'abgelaufen' };
  const schritt = codeSchritt(neu.geheim, code, null);
  if (schritt == null) return { ok: false, grund: 'falsch' };
  const notfallCodes = neueNotfallCodes();
  await s.setJSON('zf:' + konto, {
    geheim: neu.geheim,
    seit: new Date().toISOString(),
    letzterSchritt: schritt,
    notfall: notfallCodes.map((c) => sha(notfallNorm(c))),
  });
  try { await s.delete(key); } catch (e) {}
  return { ok: true, notfallCodes };
}

/**
 * Code bei der Anmeldung prüfen: 6 Ziffern aus der App oder ein Notfallcode.
 * @returns {{ok:true, notfall?:true, rest?:number} | {ok:false, grund:'falsch'|'gesperrt'|'nicht_eingerichtet', retryAfter?:number}}
 */
async function pruefe(konto, code) {
  const s = store();
  const rec = await lies(konto);
  if (!rec || !rec.geheim) return { ok: false, grund: 'nicht_eingerichtet' };
  const jetzt = Date.now();
  if (rec.gesperrtBis && jetzt < new Date(rec.gesperrtBis).getTime()) {
    return { ok: false, grund: 'gesperrt', retryAfter: Math.ceil((new Date(rec.gesperrtBis).getTime() - jetzt) / 1000) };
  }

  const schritt = codeSchritt(rec.geheim, code, rec.letzterSchritt, jetzt);
  if (schritt != null) {
    await s.setJSON('zf:' + konto, { ...rec, letzterSchritt: schritt, fehl: 0, fehlSeit: null, gesperrtBis: null });
    return { ok: true };
  }

  const n = notfallNorm(code);
  const treffer = n.length === 10 ? (rec.notfall || []).indexOf(sha(n)) : -1;
  if (treffer >= 0) {
    const notfall = rec.notfall.filter((_, i) => i !== treffer);
    await s.setJSON('zf:' + konto, { ...rec, notfall, fehl: 0, fehlSeit: null, gesperrtBis: null });
    return { ok: true, notfall: true, rest: notfall.length };
  }

  const frisch = !rec.fehlSeit || jetzt - new Date(rec.fehlSeit).getTime() > KONTO_SPERRE_MS;
  const fehl = frisch ? 1 : (rec.fehl || 0) + 1;
  const gesperrtBis = fehl >= KONTO_FEHL_MAX ? new Date(jetzt + KONTO_SPERRE_MS).toISOString() : null;
  await s.setJSON('zf:' + konto, { ...rec, fehl, fehlSeit: frisch ? new Date(jetzt).toISOString() : rec.fehlSeit, gesperrtBis });
  if (gesperrtBis) console.warn('zweifaktor: Konto ' + konto + ' nach ' + fehl + ' falschen Codes gesperrt bis ' + gesperrtBis);
  return { ok: false, grund: 'falsch' };
}

/** Zwei-Faktor für ein Konto löschen: Beim nächsten Anmelden wird neu eingerichtet. */
async function zuruecksetzen(konto) {
  await store().delete('zf:' + konto);
}

module.exports = {
  pflicht, kontoVon, slug,
  istEingerichtet, einrichtungStarten, einrichtungAbschliessen, pruefe, zuruecksetzen,
  // für Tests
  hotp, codeSchritt, base32, base32lesen, schrittVon, otpauthUrl, neueNotfallCodes, NOTFALL_ANZAHL,
};
