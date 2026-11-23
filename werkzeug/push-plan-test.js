#!/usr/bin/env node
/**
 * werkzeug/push-plan-test.js
 * ----------------------------------------------------------------------------
 * Geplante Push-Nachrichten (lib/push-plan.js, push-send.js, push-plan-lauf.js):
 *
 *   node werkzeug/push-plan-test.js
 *
 * Blob-Speicher im Arbeitsspeicher mit etag (onlyIfMatch/onlyIfNew) und
 * verzahnten Zugriffen, damit Gleichzeitigkeit echt geprüft wird. Der Versand
 * ist nachgebaut, nichts verlässt den Rechner.
 * ----------------------------------------------------------------------------
 */
const path = require('path');
const Module = require('module');

const DATEN = new Map();
let etagNr = 0;
const tick = () => new Promise((r) => setImmediate(r));
const store = (name) => ({
  async get(k, o) { await tick(); const e = DATEN.get(name + '|' + k); return e ? (o && o.type === 'json' ? JSON.parse(e.v) : e.v) : null; },
  async getWithMetadata(k, o) { await tick(); const e = DATEN.get(name + '|' + k); return e ? { data: o && o.type === 'json' ? JSON.parse(e.v) : e.v, etag: e.etag, metadata: {} } : null; },
  async setJSON(k, v, o) {
    await tick();
    const key = name + '|' + k, e = DATEN.get(key);
    if (o && o.onlyIfNew && e) return { modified: false };
    if (o && o.onlyIfMatch && (!e || e.etag !== o.onlyIfMatch)) return { modified: false };
    const etag = 'e' + (++etagNr);
    DATEN.set(key, { v: JSON.stringify(v), etag });
    return { modified: true, etag };
  },
  async set(k, v) { DATEN.set(name + '|' + k, { v: String(v), etag: 'e' + (++etagNr) }); return { modified: true }; },
  async delete(k) { await tick(); DATEN.delete(name + '|' + k); },
  async list({ prefix } = {}) { await tick(); return { blobs: [...DATEN.keys()].filter((k) => k.startsWith(name + '|' + (prefix || ''))).map((k) => ({ key: k.slice(name.length + 1) })) }; },
});
const lies = (name, k) => { const e = DATEN.get(name + '|' + k); return e ? JSON.parse(e.v) : null; };
const schreib = (name, k, v) => DATEN.set(name + '|' + k, { v: JSON.stringify(v), etag: 'e' + (++etagNr) });
const originalLoad = Module._load;
Module._load = function (anfrage, ...rest) {
  if (anfrage === '@netlify/blobs') return { getStore: (o) => store(typeof o === 'string' ? o : o.name) };
  return originalLoad.call(this, anfrage, ...rest);
};
Object.assign(process.env, { ADMIN_PASSWORD: 'admin-test', ZWEI_FAKTOR: 'aus' });
delete process.env.NETLIFY_BLOBS_SITE_ID;

const F = path.join(__dirname, '..', 'netlify', 'functions');
const plan = require(F + '/lib/push-plan.js');

const leise = console.log;
console.log = () => {}; console.error = () => {}; console.warn = () => {};
let n = 0, fehler = 0;
const ok = (name, b, info) => { n++; if (!b) fehler++; leise('  ' + (b ? '✅' : '❌') + ' ' + name + (b || info === undefined ? '' : '   → ' + JSON.stringify(info).slice(0, 400))); };

const GESENDET = [];
const versendenOk = async (m) => { await tick(); GESENDET.push(m); return { ziel: m.ziel, sent: 3, removed: 0, failed: 0, uebersprungen: 0, total: 3, ios: 'gesendet' }; };
const T0 = Date.UTC(2026, 10, 24, 10, 0, 0);          // Di 24.11.2026, 11:00 Berlin
const wer = { name: 'Kubi', role: 'superadmin' };
const deps = (jetzt, extra) => ({ holeStore: store, jetzt, versenden: versendenOk, ...(extra || {}) });
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60000;

(async () => {
  leise('\nGeplante Push-Nachrichten\n');

  /* 1. Anlegen und Prüfregeln */
  let r = await plan.anlegen({ title: '', body: 'x', sendAt: iso(T0 + 30 * MIN) }, wer, deps(T0));
  ok('ohne Titel: abgewiesen', r.status === 400 && r.fehler === 'leer', r);
  r = await plan.anlegen({ title: 'A', body: 'x', sendAt: iso(T0 + 30 * 1000) }, wer, deps(T0));
  ok('in 30 Sekunden: zu knapp', r.status === 400 && r.fehler === 'zeit_vorbei', r);
  r = await plan.anlegen({ title: 'A', body: 'x', sendAt: iso(T0 - MIN) }, wer, deps(T0));
  ok('in der Vergangenheit: abgewiesen', r.status === 400 && r.fehler === 'zeit_vorbei', r);
  r = await plan.anlegen({ title: 'A', body: 'x', sendAt: iso(T0 + 61 * 86400000) }, wer, deps(T0));
  ok('in 61 Tagen: zu weit', r.status === 400 && r.fehler === 'zeit_weit', r);
  r = await plan.anlegen({ title: 'A', body: 'x', sendAt: 'morgen' }, wer, deps(T0));
  ok('Zeitpunkt unlesbar: abgewiesen', r.status === 400 && r.fehler === 'zeit', r);

  const a = await plan.anlegen({ title: 'Mittag', body: 'Der Grill ist heiß', ziel: 'app', sendAt: iso(T0 + 30 * MIN) }, wer, deps(T0));
  const b = await plan.anlegen({ title: 'Abend', body: 'Heute bis 20:30', sendAt: iso(T0 + 8 * 3600000) }, wer, deps(T0));
  ok('gültig: geplant mit Ziel und Zeit', a.status === 200 && a.eintrag.status === 'geplant' && a.eintrag.ziel === 'app' && a.eintrag.sendAt === iso(T0 + 30 * MIN), a);
  ok('unbekanntes Ziel wird „alle“', b.eintrag.ziel === 'alle', b.eintrag);
  let l = await plan.liste(deps(T0));
  ok('Liste: zwei geplant, früheste zuerst', l.geplant.length === 2 && l.geplant[0].title === 'Mittag' && l.zuletzt.length === 0, l);

  /* 2. Ändern bis zum Versand */
  r = await plan.aendern(a.eintrag.id, { title: 'Mittag!', body: 'Neu: Special', ziel: 'alle', sendAt: iso(T0 + 45 * MIN) }, wer, a.eintrag.updatedAt, deps(T0 + MIN));
  ok('Ändern: Text, Ziel und Zeit übernommen', r.status === 200 && r.eintrag.title === 'Mittag!' && r.eintrag.ziel === 'alle' && r.eintrag.sendAt === iso(T0 + 45 * MIN), r);
  const stand1 = r.eintrag.updatedAt;
  r = await plan.aendern(a.eintrag.id, { title: 'Alt', body: 'x', sendAt: iso(T0 + 45 * MIN) }, { name: 'Lena', role: 'admin' }, a.eintrag.updatedAt, deps(T0 + 2 * MIN));
  ok('Ändern mit altem Stand: 409, nichts überschrieben', r.status === 409 && r.fehler === 'geaendert' && lies('push-plan', 'p:' + a.eintrag.id).title === 'Mittag!', r);
  r = await plan.aendern(a.eintrag.id, { title: 'Mittag!', body: 'Neu: Special', sendAt: iso(T0 + MIN) }, wer, stand1, deps(T0 + 2 * MIN));
  ok('Ändern auf vergangene Zeit: abgewiesen', r.status === 400 && r.fehler === 'zeit_vorbei', r);

  /* 3. Streichen und Rückgängig */
  r = await plan.streichen(b.eintrag.id, wer, deps(T0 + 3 * MIN));
  ok('Streichen: Status gestrichen', r.status === 200 && r.eintrag.status === 'gestrichen', r);
  r = await plan.aendern(b.eintrag.id, { title: 'X', body: 'y', sendAt: iso(T0 + 9 * 3600000) }, wer, '', deps(T0 + 3 * MIN));
  ok('Gestrichenes lässt sich nicht ändern', r.status === 409 && r.fehler === 'nicht_mehr_offen', r);
  r = await plan.zurueckholen(b.eintrag.id, wer, deps(T0 + 4 * MIN));
  ok('Rückgängig: wieder geplant', r.status === 200 && r.eintrag.status === 'geplant', r);
  await plan.streichen(b.eintrag.id, wer, deps(T0 + 5 * MIN));
  r = await plan.zurueckholen(b.eintrag.id, wer, deps(T0 + 9 * 3600000));
  ok('Rückgängig nach dem Zeitpunkt: 409 zeit_vorbei', r.status === 409 && r.fehler === 'zeit_vorbei', r);

  /* 4. Zeitplan: erst zum Zeitpunkt, genau einmal */
  let lauf = await plan.faelligeSenden(deps(T0 + 40 * MIN));
  ok('Lauf vor dem Zeitpunkt: nichts gesendet', lauf.gesendet === 0 && GESENDET.length === 0, lauf);
  const [l1, l2] = await Promise.all([plan.faelligeSenden(deps(T0 + 45 * MIN)), plan.faelligeSenden(deps(T0 + 45 * MIN))]);
  ok('zwei Läufe gleichzeitig: genau ein Versand', GESENDET.length === 1 && l1.gesendet + l2.gesendet === 1, [l1, l2, GESENDET.length]);
  ok('… mit dem geänderten Text und Ziel', GESENDET[0] && GESENDET[0].title === 'Mittag!' && GESENDET[0].body === 'Neu: Special' && GESENDET[0].ziel === 'alle', GESENDET[0]);
  const ea = lies('push-plan', 'p:' + a.eintrag.id);
  ok('… Status gesendet mit Ergebnis', ea.status === 'gesendet' && ea.ergebnis && ea.ergebnis.sent === 3, ea);
  r = await plan.aendern(a.eintrag.id, { title: 'Zu spät', body: 'x', sendAt: iso(T0 + 2 * 3600000) }, wer, ea.updatedAt, deps(T0 + 46 * MIN));
  ok('Gesendetes lässt sich nicht mehr ändern', r.status === 409 && r.fehler === 'nicht_mehr_offen', r);
  await plan.faelligeSenden(deps(T0 + 50 * MIN));
  ok('nächster Lauf: kein zweiter Versand', GESENDET.length === 1);
  l = await plan.liste(deps(T0 + 50 * MIN));
  ok('Liste: Gesendetes und Gestrichenes unter „zuletzt“', l.geplant.length === 0 && l.zuletzt.length === 2 && l.zuletzt.some((x) => x.status === 'gesendet'), l);

  /* 5. Ändern in derselben Sekunde wie der Versand */
  const c = await plan.anlegen({ title: 'Rennen', body: 'alt', sendAt: iso(T0 + 2 * 3600000) }, wer, deps(T0));
  const [lr, ar] = await Promise.all([
    plan.faelligeSenden(deps(T0 + 2 * 3600000)),
    plan.aendern(c.eintrag.id, { title: 'Rennen', body: 'neu', sendAt: iso(T0 + 3 * 3600000) }, wer, c.eintrag.updatedAt, deps(T0 + 2 * 3600000 - 2 * MIN)),
  ]);
  const ec = lies('push-plan', 'p:' + c.eintrag.id);
  const raus = GESENDET.filter((m) => m.title === 'Rennen');
  ok('Rennen Ändern gegen Versand: entweder geändert und nicht gesendet oder gesendet und Änderung abgewiesen',
    (ar.status === 200 && raus.length === 0 && ec.status === 'geplant' && ec.body === 'neu')
    || (ar.status === 409 && raus.length === 1 && raus[0].body === 'alt' && ec.status === 'gesendet'), { ar: ar.status, raus: raus.length, status: ec.status, body: ec.body, lr });

  /* 6. Jetzt senden */
  const d = await plan.anlegen({ title: 'Sofort', body: 'jetzt', sendAt: iso(T0 + 5 * 3600000) }, wer, deps(T0));
  r = await plan.jetztSenden(d.eintrag.id, wer, deps(T0 + MIN));
  ok('Jetzt senden: raus, Status gesendet', r.status === 200 && r.eintrag.status === 'gesendet' && GESENDET.some((m) => m.title === 'Sofort'), r);
  const sofort = () => GESENDET.filter((m) => m.title === 'Sofort').length;
  r = await plan.jetztSenden(d.eintrag.id, wer, deps(T0 + 2 * MIN));
  await plan.faelligeSenden(deps(T0 + 5 * 3600000));
  ok('… zweiter Tipp und späterer Lauf senden nicht noch einmal', r.status === 409 && sofort() === 1, { r, sofort: sofort() });

  /* 7. Fehler beim Versand */
  const e1 = await plan.anlegen({ title: 'Ohne VAPID', body: 'x', sendAt: iso(T0 + 6 * 3600000) }, wer, deps(T0));
  await plan.faelligeSenden(deps(T0 + 6 * 3600000, { versenden: async () => { const e = new Error('vapid_not_configured'); e.code = 'vapid_not_configured'; throw e; } }));
  const f1 = lies('push-plan', 'p:' + e1.eintrag.id);
  ok('VAPID fehlt: Status fehler, nichts gesendet vermerkt', f1.status === 'fehler' && /nichts gesendet/.test(f1.fehler), f1);
  const e2 = await plan.anlegen({ title: 'Abbruch', body: 'x', sendAt: iso(T0 + 7 * 3600000) }, wer, deps(T0));
  await plan.faelligeSenden(deps(T0 + 7 * 3600000, { versenden: async () => { throw new Error('Zeitüberschreitung'); } }));
  const f2 = lies('push-plan', 'p:' + e2.eintrag.id);
  ok('Abbruch mitten im Versand: Status unklar, kein neuer Versuch', f2.status === 'unklar', f2);
  const v2 = GESENDET.length;
  await plan.faelligeSenden(deps(T0 + 7 * 3600000 + 5 * MIN));
  ok('… nächster Lauf versucht es nicht erneut', GESENDET.length === v2);

  /* 8. Hängt im Status „sendet“ */
  schreib('push-plan', 'p:haengt1', { id: 'haengt1', title: 'Hängt', body: 'x', ziel: 'alle', sendAt: iso(T0), status: 'sendet', claimedAt: iso(T0), updatedAt: iso(T0) });
  await plan.faelligeSenden(deps(T0 + 5 * MIN));
  ok('sendet seit 5 Minuten: bleibt (Versand läuft evtl. noch)', lies('push-plan', 'p:haengt1').status === 'sendet');
  await plan.faelligeSenden(deps(T0 + 11 * MIN));
  ok('sendet seit 11 Minuten: unklar, kein Versand', lies('push-plan', 'p:haengt1').status === 'unklar' && !GESENDET.some((m) => m.title === 'Hängt'));

  /* 9. Aufräumen */
  schreib('push-plan', 'p:alt1', { id: 'alt1', title: 'Alt', body: 'x', ziel: 'alle', sendAt: iso(T0 - 100 * 86400000), status: 'gesendet', sentAt: iso(T0 - 100 * 86400000), updatedAt: iso(T0 - 100 * 86400000) });
  lauf = await plan.faelligeSenden(deps(T0));
  ok('Erledigtes nach 90 Tagen gelöscht', !lies('push-plan', 'p:alt1') && lauf.geloescht === 1, lauf);

  /* 10. Über die Function (Anmeldung, Aktionen) */
  const h = require(F + '/push-send.js').handler;
  const ruf = async (body) => {
    const res = await h({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '10.9.0.1' }, body: JSON.stringify(body), queryStringParameters: {} });
    return { s: res.statusCode, d: JSON.parse(res.body) };
  };
  r = await ruf({ password: 'falsch', action: 'liste' });
  ok('Function: ohne Admin-Passwort 401', r.s === 401, r);
  const spaeter = new Date(Date.now() + 3 * 3600000);
  r = await ruf({ password: 'admin-test', action: 'planen', title: 'Über die Function', body: 'Test', ziel: 'web', sendAt: spaeter.toISOString() });
  ok('Function: planen', r.s === 200 && r.d.eintrag && r.d.eintrag.status === 'geplant' && r.d.eintrag.ziel === 'web', r);
  const fid = r.d.eintrag.id, fstand = r.d.eintrag.updatedAt;
  r = await ruf({ password: 'admin-test', action: 'liste' });
  ok('Function: Liste enthält sie', r.s === 200 && r.d.geplant.some((x) => x.id === fid) && !!r.d.jetzt, r);
  r = await ruf({ password: 'admin-test', action: 'aendern', id: fid, stand: fstand, title: 'Geändert', body: 'Test', ziel: 'alle', sendAt: spaeter.toISOString() });
  ok('Function: ändern', r.s === 200 && r.d.eintrag.title === 'Geändert', r);
  r = await ruf({ password: 'admin-test', action: 'streichen', id: fid });
  ok('Function: streichen', r.s === 200 && r.d.eintrag.status === 'gestrichen', r);
  r = await ruf({ password: 'admin-test', action: 'zurueckholen', id: fid });
  ok('Function: rückgängig', r.s === 200 && r.d.eintrag.status === 'geplant', r);
  r = await ruf({ password: 'admin-test', action: 'unsinn' });
  ok('Function: unbekannte Aktion 400', r.s === 400, r);
  const audit = [...DATEN.keys()].filter((k) => k.startsWith('audit|')).map((k) => lies('audit', k.slice(6)));
  ok('Protokoll: geplant, geändert, gestrichen, gesendet', ['geplant für', 'geändert', 'gestrichen', 'gesendet'].every((w) => audit.some((x) => x.action === 'Push' && x.detail.includes(w))), audit.map((x) => x.detail));

  leise('\n' + (n - fehler) + '/' + n + ' bestanden' + (fehler ? ', ' + fehler + ' FEHLER' : '') + '\n');
  process.exit(fehler ? 1 : 0);
})().catch((e) => { leise('Absturz:', e); process.exit(1); });
