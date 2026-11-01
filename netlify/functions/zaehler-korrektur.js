/**
 * zaehler-korrektur.js
 * ----------------------------------------------------------------------------
 * Einmalige Korrektur der Kundenzähler für Aktionscodes (GRILL5 u. a.).
 *
 * DER FEHLER (29.10. bis November 2026)
 * Seit Commit 45b61cb zählt send-email.js Einlösungen je Kunde im Datensatz
 * n:<CODE>:<sha256 der vereinheitlichten E-Mail>. Beim ersten Zählen eines
 * Kunden wurde aber zuerst usedBy im Gutschein erhöht und danach der neue
 * Datensatz aus genau diesem usedBy-Stand angelegt, plus eins. Jeder Zähler,
 * der in dieser Zeit entstand, steht deshalb um eins zu hoch. GRILL5 ging für
 * diese Kunden nur zweimal statt dreimal. Behoben im selben Paket.
 *
 * DIE KORREKTUR
 * usedBy und der Zähler wurden seitdem immer gemeinsam erhöht. Ein betroffener
 * Zähler erfüllt also n = usedBy + 1, ein richtiger n = usedBy. Gesenkt wird
 * nur, wenn alles eindeutig ist:
 *   - es gibt einen usedBy-Eintrag unter genau diesem Hash,
 *   - n ist genau usedBy + 1,
 *   - im Bestell-Archiv liegt seit dem 29.10. mindestens eine gezählte
 *     Bestellung (gutscheinGezaehlt) dieses Kunden mit diesem Code,
 *   - alle archivierten Bestellungen dieses Kunden mit diesem Code nutzen
 *     dieselbe Schreibweise der E-Mail. Andere Schreibweisen (Gmail-Punkte,
 *     +Zusatz) landen in usedBy unter einem anderen Hash, dann ist usedBy für
 *     diesen Zähler nicht vollständig.
 * Dann wird n auf usedBy gesetzt: nie höher als vorher, nie unter 0. Alles
 * andere bleibt unverändert und wird nur gezählt.
 *
 * LAUF
 * Zeitplan stündlich (netlify.toml). Der erste Lauf nach dem Deploy korrigiert
 * und setzt den Merker migration:zaehler-2026-11 im Store vouchers. Danach
 * liest jeder Lauf nur den Merker und kehrt zurück. Die Regel ist ohnehin
 * idempotent: ein korrigierter Zähler erfüllt n = usedBy und wird nie wieder
 * angefasst. Ergebnis ins Log und als Telegram an Kubi (nur Anzahlen).
 *
 * Reicht die Zeit für das Lesen des Bestell-Archivs nicht, wird NICHTS
 * geändert und der nächste Lauf versucht es erneut (höchstens 5-mal, dann
 * eine Meldung per Telegram).
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { mailVereinheitlichen } = require('./lib/gutschein-nutzung');
const { codeNormalisieren } = require('./lib/gutschein-code');
const { telegram, esc } = require('./lib/telegram');
const { schutz } = require('./lib/bremse');

const MERKER = 'migration:zaehler-2026-11';
const FEHLER_SEIT = Date.parse('2026-10-29T00:00:00+01:00');   // Deploy von 45b61cb
const BUDGET_MS = 20000;
const MAX_VERSUCHE = 5;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

const zahl = (v) => (typeof v === 'number' ? v : (v ? 1 : 0));

/**
 * Die eigentliche Korrektur. Gibt eine Zusammenfassung zurück (nur Anzahlen).
 * o.budgetMs für Tests.
 */
async function korrigieren(o = {}) {
  const vs = o.vouchers || store('vouchers');
  const os = o.orders || store('orders');
  const start = Date.now();
  const budget = o.budgetMs || BUDGET_MS;

  const alt = (await vs.get(MERKER, { type: 'json' })) || null;
  if (alt && (alt.status === 'fertig' || alt.status === 'aufgegeben')) return { schon: true, status: alt.status };
  if (alt && alt.status === 'läuft' && Date.now() - alt.seit < 15 * 60 * 1000) return { laeuft: true };
  const versuche = ((alt && alt.versuche) || 0) + 1;
  await vs.setJSON(MERKER, { status: 'läuft', seit: Date.now(), versuche });

  // 1) Kundenzähler n:<CODE>:<hash> einsammeln
  const { blobs } = await vs.list({ prefix: 'n:' });
  const zaehler = [];
  for (const b of blobs) {
    const m = /^n:(.+):([0-9a-f]{64})$/.exec(b.key);
    if (m) zaehler.push({ key: b.key, code: m[1], hash: m[2] });
  }
  const codes = {};
  for (const z of zaehler) {
    if (!(z.code in codes)) codes[z.code] = await vs.get('c:' + z.code, { type: 'json' });
  }

  // 2) Bestell-Archiv: je Code und Kunde die Schreibweisen der E-Mail und die
  //    seit dem Fehler gezählten Bestellungen
  const archiv = {};   // code -> hash -> { schreibweisen:Set, gezaehlt:Zahl }
  const { blobs: ob } = await os.list({ prefix: 'o:' });
  const okeys = ob.map((b) => b.key);
  let abgebrochen = false;
  for (let i = 0; i < okeys.length; i += 25) {
    if (Date.now() - start > budget) { abgebrochen = true; break; }
    const recs = await Promise.all(okeys.slice(i, i + 25).map((k) => os.get(k, { type: 'json' }).catch(() => null)));
    recs.forEach((rec, j) => {
      const ord = rec && rec.order;
      if (!ord || !ord.email || !ord.voucherCode) return;
      const code = codeNormalisieren(ord.voucherCode);
      if (!(code in codes)) return;
      const roh = String(ord.email).trim().toLowerCase();
      const h = sha(mailVereinheitlichen(roh));
      const a = ((archiv[code] = archiv[code] || {})[h] = archiv[code][h] || { schreibweisen: new Set(), gezaehlt: 0 });
      a.schreibweisen.add(sha(roh));
      const ms = Number((/^o:GNC-(\d{10,})/.exec(okeys[i + j]) || [])[1]) || Date.parse(rec.createdAt || '') || 0;
      if (rec.gutscheinGezaehlt === code && ms >= FEHLER_SEIT) a.gezaehlt++;
    });
  }
  if (abgebrochen) {
    const status = versuche >= MAX_VERSUCHE ? 'aufgegeben' : 'abgebrochen';
    await vs.setJSON(MERKER, { status, seit: Date.now(), versuche });
    console.warn('zaehler-korrektur: Bestell-Archiv nicht in der Zeit gelesen, nichts geändert (Versuch ' + versuche + ')');
    if (status === 'aufgegeben') {
      await telegram('<b>Gutschein-Zähler</b>\nDie einmalige Korrektur lief ' + versuche + '-mal nicht durch und wurde ohne Änderung beendet. Pasquale Bescheid geben.', { html: true });
    }
    return { abgebrochen: true, versuche };
  }

  // 3) Zähler prüfen und nur eindeutige Fälle senken
  const e = { geprueft: 0, korrigiert: 0, richtig: 0, mehrdeutig: 0, ohneQuelle: 0, veraltet: 0, jeCode: {} };
  for (const z of zaehler) {
    e.geprueft++;
    const c = codes[z.code];
    const rec = await vs.get(z.key, { type: 'json' });
    if (!c || !rec || typeof rec.n !== 'number') { e.ohneQuelle++; continue; }
    if (rec.seit !== (c.createdAt || null)) { e.veraltet++; continue; }   // gehört zu einer früheren Fassung des Codes
    const usedBy = c.usedBy || {};
    if (!Object.prototype.hasOwnProperty.call(usedBy, z.hash)) { e.ohneQuelle++; continue; }
    const u = zahl(usedBy[z.hash]);
    if (rec.n === u) { e.richtig++; continue; }
    if (rec.n !== u + 1) { e.mehrdeutig++; continue; }
    const a = archiv[z.code] && archiv[z.code][z.hash];
    if (!a || a.gezaehlt === 0) { e.ohneQuelle++; continue; }
    if ([...a.schreibweisen].some((s) => s !== z.hash)) { e.mehrdeutig++; continue; }
    const neu = Math.max(0, Math.min(rec.n, u));
    if (neu === rec.n) { e.richtig++; continue; }
    rec.n = neu;
    rec.korrigiert = '2026-11';
    await vs.setJSON(z.key, rec);
    e.korrigiert++;
    e.jeCode[z.code] = (e.jeCode[z.code] || 0) + 1;
  }

  await vs.setJSON(MERKER, { status: 'fertig', am: new Date().toISOString(), versuche, ergebnis: e });
  const jeCode = Object.entries(e.jeCode).map(([k, v]) => k + ' ' + v).join(', ');
  console.log('zaehler-korrektur:', JSON.stringify(e));
  await telegram(
    '<b>Gutschein-Zähler korrigiert</b>\n'
    + 'Einmalige Korrektur nach dem Zählfehler vom 29.10.: ' + e.korrigiert + ' Kundenzähler um eins gesenkt'
    + (jeCode ? ' (' + esc(jeCode) + ')' : '') + '.\n'
    + 'Schon richtig: ' + e.richtig + '. Unverändert gelassen: ' + e.mehrdeutig + ' unklar, '
    + e.ohneQuelle + ' ohne Beleg, ' + e.veraltet + ' von einer früheren Fassung eines Codes.',
    { html: true },
  );
  return e;
}

exports.handler = async (event) => {
  // Läuft nach Zeitplan. Sollte sie doch über eine Adresse erreichbar sein,
  // ändert ein Aufruf nach dem ersten Lauf nichts mehr (Merker, idempotent).
  const halt = await schutz(event || {}, { name: 'zaehlerkorrektur', max: 6, maxKB: 4 });
  if (halt) return halt;
  try {
    const r = await korrigieren();
    return { statusCode: 200, body: JSON.stringify(r) };
  } catch (err) {
    console.error('zaehler-korrektur:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'fehlgeschlagen' }) };
  }
};
exports.korrigieren = korrigieren;
exports.MERKER = MERKER;
