/**
 * team.js
 * ----------------------------------------------------------------------------
 * Team-Logins fürs Admin-Tool.
 *
 * Rollen:
 *   admin = ADMIN_PASSWORD (Kubi) – Vollzugriff inkl. Push-Marketing, Zahlen,
 *           Rückerstattungen und Team-Verwaltung.
 *   staff = Mitarbeiter-Passwörter (hier verwaltet) – Laden-Status (Pause,
 *           Ausverkauft, Special) und Bestellungen (prüfen/abschließen).
 *
 * Es gibt bewusst KEINE Benutzernamen im Login: Jedes Team-Mitglied bekommt
 * ein eigenes, eindeutiges Passwort – das Passwort identifiziert die Person.
 * Passwörter werden ausschließlich als SHA-256-Hash gespeichert.
 *
 *   POST { password, action, ... }
 *     action = "anmelden", code?, einrichtung?, merken
 *                                          → Passwort + Code -> Sitzungs-Token
 *                                            (Zwei-Faktor, lib/zweifaktor.js)
 *     action = "whoami"                    → { role, name }        (alle)
 *     action = "list"                      → { staff: [...] }      (admin)
 *     action = "add",    name, staffPassword → legt Mitarbeiter an (admin)
 *     action = "remove", name              → entfernt Mitarbeiter  (admin)
 *     action = "zfzuruecksetzen", name?    → Zwei-Faktor neu einrichten lassen
 *                                            (ohne name: das eigene Konto)
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung, erstelle, beende, istToken } = require('./lib/admin-sitzung');
const zf = require('./lib/zweifaktor');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...CORS },
  body: JSON.stringify(data),
});

function teamStore() {
  const opts = { name: 'team', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}


// --- Änderungs-Protokoll (Store: audit) – best effort, blockiert nie ---
async function auditLog(who, action, detail) {
  try {
    const opts = { name: 'audit', consistency: 'strong' };
    if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
      opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
      opts.token = process.env.NETLIFY_BLOBS_TOKEN;
    }
    const s = getStore(opts);
    const key = 'a:' + new Date().toISOString() + '_' + Math.random().toString(36).slice(2, 7);
    await s.setJSON(key, {
      at: new Date().toISOString(),
      name: (who && who.name) || '?',
      role: (who && who.role) || '?',
      action,
      detail: String(detail || '').slice(0, 300),
    });
  } catch (e) {}
}

const hash = (pw) => crypto.createHash('sha256').update(String(pw)).digest('hex');
const slug = zf.slug;   // dieselbe Regel wie für die Zwei-Faktor-Konten

async function authRole(pw) {
  if (!pw) return null;
  const admin = process.env.ADMIN_PASSWORD || '';
  if (admin && pw === admin) return { role: 'superadmin', name: 'Kubi' };
  try {
    const t = teamStore();
    const { blobs } = await t.list({ prefix: 'u:' });
    const h = hash(pw);
    for (const b of blobs) {
      const u = await t.get(b.key, { type: 'json' });
      if (u && u.pwHash === h) return { role: u.role === 'admin' ? 'admin' : 'staff', name: u.name || b.key.slice(2) };
    }
  } catch (e) {}
  return null;
}

/* ---- Anmelden mit Passwort und Code (lib/zweifaktor.js) ------------------- */
// Ohne "angemeldet bleiben" gilt die Sitzung einen Arbeitstag, nicht 30 Tage
const SITZUNG_TAB_MS = 12 * 60 * 60 * 1000;

async function anmelden(event, input) {
  const pw = String(input.password || '');
  if (!pw || istToken(pw)) return json(400, { error: 'password_required' });
  const who = await authRole(pw);
  if (!who) {
    await meldeErgebnis(event, false);
    return json(401, { error: 'unauthorized' });
  }

  const fertig = async (extra) => {
    await meldeErgebnis(event, true);
    const sitzung = await erstelle(pw, who, { zweiFaktor: true, gueltigMs: input.merken ? 0 : SITZUNG_TAB_MS });
    if (!sitzung) return json(503, { error: 'sitzung_fehlgeschlagen', hint: 'Die Anmeldung hat geklappt, die Sitzung ließ sich aber nicht speichern. Bitte gleich noch einmal versuchen.' });
    return json(200, { ok: true, token: sitzung.token, exp: sitzung.exp, role: who.role, name: who.name || '', ...extra });
  };

  // Notschalter ZWEI_FAKTOR=aus: Passwort genügt
  if (!zf.pflicht()) return fertig({ zweiFaktor: false });

  const konto = zf.kontoVon(who);
  const anzeige = who.name || 'Admin';

  if (!(await zf.istEingerichtet(konto))) {
    if (!input.einrichtung) {
      const e = await zf.einrichtungStarten(konto, anzeige);
      return json(200, { ok: false, schritt: 'einrichten', einrichtung: e.einrichtung, geheim: e.geheim, url: e.url, name: anzeige });
    }
    const r = await zf.einrichtungAbschliessen(input.einrichtung, konto, input.code);
    if (!r.ok) {
      if (r.grund === 'abgelaufen') return json(410, { error: 'einrichtung_abgelaufen', hint: 'Die Einrichtung hat zu lange gedauert. Bitte neu anmelden.' });
      await meldeErgebnis(event, false, { zaehleImmer: true });
      return json(401, { error: 'code_falsch' });
    }
    await auditLog(who, 'Zwei-Faktor', 'Eingerichtet');
    return fertig({ notfallCodes: r.notfallCodes });
  }

  if (!input.code) return json(200, { ok: false, schritt: 'code', name: anzeige });
  const r = await zf.pruefe(konto, input.code);
  if (!r.ok) {
    if (r.grund === 'gesperrt') {
      return json(429, { error: 'too_many_attempts', retryAfter: r.retryAfter, hint: 'Zu viele falsche Codes. Bitte in einigen Minuten erneut versuchen.' });
    }
    await meldeErgebnis(event, false, { zaehleImmer: true });
    return json(401, { error: 'code_falsch' });
  }
  if (r.notfall) await auditLog(who, 'Zwei-Faktor', 'Mit Notfallcode angemeldet, noch ' + r.rest + ' übrig');
  return fertig(r.notfall ? { notfallRest: r.rest } : {});
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }

  // Bremse gegen Durchprobieren – siehe lib/auth-guard.js
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;

  /* Anmelden: der einzige Weg, auf dem noch ein Passwort angenommen wird.
     Antwortet in Schritten, der Browser fragt jeweils nach:
       1. nur Passwort     -> { schritt: 'code' } oder beim ersten Mal
                              { schritt: 'einrichten', geheim, url }
       2. Passwort + Code  -> { ok, token, exp } (+ notfallCodes nach der Einrichtung)
     Ein richtiges Passwort ohne Code meldet nichts an die Bremse: Erfolg
     würde den Zähler löschen, und zwischen zwei Code-Versuchen ließe sich so
     endlos weiterraten. Falsche Codes zählen mit (zaehleImmer). */
  if (String(input.action || '') === 'anmelden') return anmelden(event, input);
  const who = await authRole(await passwortAusSitzung(input.password));
  await meldeErgebnis(event, !!who);
  if (!who) return json(401, { error: 'unauthorized' });

  const action = String(input.action || 'whoami');

  if (action === 'whoami') return json(200, { ok: true, role: who.role, name: who.name, zweiFaktor: zf.pflicht() });

  /* Zwei-Faktor zurücksetzen: Beim nächsten Anmelden richtet die Person die
     App neu ein (neues Handy, App gelöscht). Das eigene Konto darf jeder
     zurücksetzen, er ist ja gerade mit Code angemeldet. Fremde Konten: Admins
     für Mitarbeiter, Admin-Zugänge nur der Superadmin. Den Superadmin kann
     niemand außer ihm selbst zurücksetzen. */
  if (action === 'zfzuruecksetzen') {
    const eigenes = zf.kontoVon(who);
    let konto = eigenes, ziel = who.name || 'eigenes Konto';
    if (input.name) {
      if (who.role !== 'superadmin' && who.role !== 'admin') return json(403, { error: 'forbidden' });
      const u = await teamStore().get('u:' + slug(input.name), { type: 'json' });
      if (!u) return json(404, { error: 'not_found' });
      if (u.role === 'admin' && who.role !== 'superadmin') return json(403, { error: 'forbidden', hint: 'Admin-Zugänge kann nur der Superadmin zurücksetzen' });
      konto = 'u:' + slug(input.name); ziel = u.name;
    }
    await zf.zuruecksetzen(konto);
    await auditLog(who, 'Zwei-Faktor', 'Zurückgesetzt für ' + ziel);
    return json(200, { ok: true, eigenes: konto === eigenes });
  }

  /* "Angemeldet bleiben" – siehe lib/admin-sitzung.js.
     Der Browser bekommt einen Sitzungs-Token und legt NUR den ab; das
     Passwort lag dort früher dreissig Tage im Klartext.
     Bewusst vor der Admin-Schranke unten: auch Mitarbeiter dürfen
     angemeldet bleiben, sie kommen damit an nichts, was ihnen nicht
     ohnehin offensteht. */
  if (action === 'sitzung') {
    if (istToken(input.password)) return json(200, { ok: true, schonSitzung: true });
    const sitzung = await erstelle(input.password, who);
    return sitzung
      ? json(200, { ok: true, token: sitzung.token, exp: sitzung.exp })
      : json(200, { ok: false, hint: 'Sitzung konnte nicht angelegt werden – Anmeldung gilt trotzdem.' });
  }

  /* Abmelden: Sitzung serverseitig entwerten, damit ein kopierter Token
     auf einem anderen Geraet sofort wertlos ist. */
  if (action === 'abmelden') {
    await beende(input.password);
    return json(200, { ok: true });
  }

  // Ab hier: Admin oder Superadmin
  const isSuper = who.role === 'superadmin';
  if (!isSuper && who.role !== 'admin') return json(403, { error: 'forbidden', hint: 'Nur für den Admin-Zugang' });

  const t = teamStore();
  try {
    if (action === 'list') {
      const { blobs } = await t.list({ prefix: 'u:' });
      const staff = [];
      for (const b of blobs) {
        const u = await t.get(b.key, { type: 'json' });
        if (u) staff.push({
          name: u.name || b.key.slice(2), role: u.role === 'admin' ? 'admin' : 'staff', createdAt: u.createdAt || null,
          zweiFaktor: await zf.istEingerichtet('u:' + b.key.slice(2)),
        });
      }
      staff.sort((a, b2) => (a.name || '').localeCompare(b2.name || ''));
      return json(200, { ok: true, staff });
    }

    if (action === 'add') {
      const name = String(input.name || '').trim().slice(0, 40);
      const pw = String(input.staffPassword || '');
      if (!name) return json(400, { error: 'missing_name' });
      if (pw.length < 6) return json(400, { error: 'weak_password', hint: 'Mindestens 6 Zeichen' });
      if (pw === (process.env.ADMIN_PASSWORD || '')) return json(400, { error: 'reserved_password' });
      const key = 'u:' + slug(name);
      if (await t.get(key, { type: 'json' })) return json(409, { error: 'name_exists', hint: 'Name schon vergeben – bitte anderen wählen' });
      // Passwort-Kollision mit anderem Mitarbeiter verhindern (Passwort = Identität)
      const { blobs } = await t.list({ prefix: 'u:' });
      const h = hash(pw);
      for (const b of blobs) {
        const u = await t.get(b.key, { type: 'json' });
        if (u && u.pwHash === h) return json(409, { error: 'password_exists', hint: 'Dieses Passwort ist bereits vergeben' });
      }
      const role = input.role === 'admin' ? 'admin' : 'staff';
      if (role === 'admin' && !isSuper) return json(403, { error: 'forbidden', hint: 'Admins kann nur der Superadmin anlegen' });
      await t.setJSON(key, { name, pwHash: h, role, createdAt: new Date().toISOString() });
      await auditLog(who, 'Team', 'Zugang angelegt: ' + name + ' (' + (role === 'admin' ? 'Admin' : 'Mitarbeiter') + ')');
      return json(200, { ok: true, name, role });
    }

    if (action === 'setpassword') {
      const key = 'u:' + slug(input.name);
      const u = await t.get(key, { type: 'json' });
      if (!u) return json(404, { error: 'not_found' });
      if (u.role === 'admin' && !isSuper) return json(403, { error: 'forbidden', hint: 'Admin-Passwörter kann nur der Superadmin ändern' });
      const pw = String(input.staffPassword || '');
      if (pw.length < 6) return json(400, { error: 'weak_password', hint: 'Mindestens 6 Zeichen' });
      if (pw === (process.env.ADMIN_PASSWORD || '')) return json(400, { error: 'reserved_password' });
      // Kollision mit anderem Team-Mitglied verhindern (Passwort = Identität)
      const h = hash(pw);
      const { blobs } = await t.list({ prefix: 'u:' });
      for (const b of blobs) {
        if (b.key === key) continue;
        const other = await t.get(b.key, { type: 'json' });
        if (other && other.pwHash === h) return json(409, { error: 'password_exists', hint: 'Dieses Passwort ist bereits vergeben' });
      }
      u.pwHash = h;
      u.passwordChangedAt = new Date().toISOString();
      await t.setJSON(key, u);
      await auditLog(who, 'Team', 'Passwort geändert für: ' + u.name);
      return json(200, { ok: true, name: u.name });
    }

    if (action === 'setrole') {
      if (!isSuper) return json(403, { error: 'forbidden', hint: 'Rollen kann nur der Superadmin ändern' });
      const key = 'u:' + slug(input.name);
      const u = await t.get(key, { type: 'json' });
      if (!u) return json(404, { error: 'not_found' });
      u.role = input.role === 'admin' ? 'admin' : 'staff';
      await t.setJSON(key, u);
      await auditLog(who, 'Team', 'Rolle geändert: ' + u.name + ' → ' + (u.role === 'admin' ? 'Admin' : 'Mitarbeiter'));
      return json(200, { ok: true, name: u.name, role: u.role });
    }

    if (action === 'remove') {
      const key = 'u:' + slug(input.name);
      const u = await t.get(key, { type: 'json' });
      if (u && u.role === 'admin' && !isSuper) return json(403, { error: 'forbidden', hint: 'Admins kann nur der Superadmin entfernen' });
      await t.delete(key);
      // Sonst übernähme ein später gleichnamig angelegter Zugang die alte App-Kopplung
      try { await zf.zuruecksetzen(key); } catch (e) {}
      await auditLog(who, 'Team', 'Zugang entfernt: ' + (u ? u.name : input.name));
      return json(200, { ok: true });
    }
  } catch (e) {
    return json(500, { error: 'team_failed', detail: String((e && e.message) || e) });
  }
  return json(400, { error: 'unknown_action' });
};
