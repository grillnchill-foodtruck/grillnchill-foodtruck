/**
 * lib/bestand.js
 * ----------------------------------------------------------------------------
 * „Bestand zählt mit“: Buns und Patties je Tag. Jede Bestellung zieht ab,
 * bei null gehen die betroffenen Burger von selbst auf ausverkauft.
 *
 * So bequem wie möglich für Kubi: Einmal Standardwerte einstellen („jeden
 * Morgen 80 Buns, 80 Patties“), dann startet jeder Tag von selbst damit.
 * Nur wenn es anders ist, im Admin unter Heute den Rest ändern.
 *
 * Store "bestand":
 *   standard        { buns, patties, auto: true, warnAb: 10 }
 *   tag:YYYY-MM-DD  { start: { buns, patties }, verbraucht: { buns, patties },
 *                     refs: { <bestellnummer>: 1 }, gewarnt: { buns: 'niedrig'|'leer' } }
 *
 * Verbrauch je Burger: 1 Bun. Rinder-Patties: 1, Double Patty 2, Kubis Special 2.
 * Crispy Chicken und Veggie brauchen ein Bun, aber kein Rinder-Patty.
 * Ein Wert ohne Startzahl (null) wird nicht gezählt und sperrt nichts.
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');

let SK = null;
try { SK = require('../../../speisekarte.js'); } catch (e) { SK = null; }

const ARTEN = ['buns', 'patties'];
const NAMEN = { buns: 'Buns', patties: 'Patties' };
const WARN_AB = 10;
const KEIN_RIND = /(^crispy$|-veg$)/;          // Hähnchen und Gemüse-Patty
const ZWEI_PATTIES = ['kubis'];                // schon Double

function store() {
  const opts = { name: 'bestand', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

const fmtTag = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
const heute = () => fmtTag.format(new Date());
const zahl = (x) => { const n = Math.floor(Number(x)); return Number.isFinite(n) && n >= 0 && n <= 5000 ? n : null; };

function burgerIds() {
  return SK ? SK.MENU.filter((m) => m.cat === 'burger').map((m) => m.id) : [];
}

/** Verbrauch eines Warenkorbs (cartSnapshot) */
function verbrauch(korb) {
  const v = { buns: 0, patties: 0 };
  if (!korb || typeof korb !== 'object') return v;
  const burger = new Set(burgerIds());
  for (const k of Object.keys(korb)) {
    const e = korb[k];
    if (!e || !burger.has(e.menuId)) continue;
    const menge = Math.max(0, Math.min(99, Math.floor(Number(e.qty) || 0)));
    v.buns += menge;
    if (!KEIN_RIND.test(e.menuId)) v.patties += menge * (ZWEI_PATTIES.includes(e.menuId) || e.double ? 2 : 1);
  }
  return v;
}

function rest(t) {
  const r = {};
  for (const a of ARTEN) {
    const s = t && t.start ? t.start[a] : null;
    r[a] = (s === null || s === undefined) ? null : Math.max(0, s - ((t.verbraucht && t.verbraucht[a]) || 0));
  }
  return r;
}

/** Welche Burger bei diesem Rest ausverkauft sind */
function ausverkauft(r) {
  const ids = burgerIds();
  if (r.buns !== null && r.buns <= 0) return ids;
  if (r.patties === null) return [];
  return ids.filter((id) => !KEIN_RIND.test(id) && (r.patties <= 0 || (ZWEI_PATTIES.includes(id) && r.patties < 2)));
}

async function lies(s, key) {
  if (typeof s.getWithMetadata === 'function') {
    const g = await s.getWithMetadata(key, { type: 'json' });
    return g ? { data: g.data, etag: g.etag || null } : { data: null, etag: null };
  }
  return { data: await s.get(key, { type: 'json' }), etag: null };
}

/* Tagesdatensatz, beim ersten Zugriff aus dem Standard angelegt */
function neuerTag(standard) {
  const auto = standard && standard.auto !== false;
  return {
    start: { buns: auto && standard ? zahl(standard.buns) : null, patties: auto && standard ? zahl(standard.patties) : null },
    verbraucht: { buns: 0, patties: 0 },
    refs: {},
    gewarnt: {},
    ausStandard: !!(auto && standard),
  };
}

/**
 * Ändert den Tagesdatensatz mit bedingtem Schreiben (kein Verlust bei
 * gleichzeitigen Bestellungen). aendern(t) gibt false zurück, wenn nichts
 * zu tun ist.
 */
async function aendereTag(tag, aendern, s) {
  s = s || store();
  const standard = await s.get('standard', { type: 'json' }).catch(() => null);
  for (let versuch = 0; versuch < 10; versuch++) {
    if (versuch) await new Promise((r) => setTimeout(r, 5 + Math.random() * 25 * versuch));
    const { data, etag } = await lies(s, 'tag:' + tag);
    const t = data || neuerTag(standard);
    if (aendern(t, standard) === false) return { t, geaendert: false };
    const bedingung = data ? (etag ? { onlyIfMatch: etag } : {}) : { onlyIfNew: true };
    const res = await s.setJSON('tag:' + tag, t, bedingung);
    if (!res || res.modified !== false) return { t, geaendert: true };
  }
  throw new Error('bestand: zu viele gleichzeitige Änderungen');
}

/**
 * Bestellung abziehen. Einmal je Bestellnummer. Meldet per telegram(), wenn
 * ein Wert unter die Warnschwelle fällt oder alle ist.
 */
async function abziehen(ref, korb, tag, opts = {}) {
  const v = verbrauch(korb);
  if (!ref || (!v.buns && !v.patties)) return null;
  tag = tag || heute();
  let warnung = [];
  const { t, geaendert } = await aendereTag(tag, (t, standard) => {
    if (t.refs[ref]) return false;
    t.refs[ref] = 1;
    const vorher = rest(t);
    for (const a of ARTEN) t.verbraucht[a] = (t.verbraucht[a] || 0) + v[a];
    const nachher = rest(t);
    const ab = (standard && zahl(standard.warnAb)) || WARN_AB;
    warnung = [];
    for (const a of ARTEN) {
      if (nachher[a] === null) continue;
      if (nachher[a] <= 0 && t.gewarnt[a] !== 'leer') { t.gewarnt[a] = 'leer'; warnung.push({ a, art: 'leer' }); }
      else if (nachher[a] > 0 && nachher[a] <= ab && vorher[a] > ab && !t.gewarnt[a]) { t.gewarnt[a] = 'niedrig'; warnung.push({ a, art: 'niedrig', n: nachher[a] }); }
    }
  }, opts.store);
  if (geaendert && warnung.length && tag === heute()) {
    const tg = opts.telegram || require('./telegram').telegram;
    for (const w of warnung) {
      const text = w.art === 'leer'
        ? NAMEN[w.a] + ' sind alle. Die betroffenen Burger stehen jetzt online auf ausverkauft. Nachschub da? Im Admin unter Heute den Bestand ändern.'
        : 'Nur noch ' + w.n + ' ' + NAMEN[w.a] + ' übrig.';
      try { await tg(text); } catch (e) {}
    }
  }
  return rest(t);
}

/** Storno einer Eingabe (Telefon/Truck): Verbrauch dieser Bestellung zurückgeben */
async function zurueckbuchen(ref, korb, tag, opts = {}) {
  const v = verbrauch(korb);
  if (!ref) return null;
  const { t } = await aendereTag(tag || heute(), (t) => {
    if (!t.refs[ref]) return false;
    delete t.refs[ref];
    for (const a of ARTEN) t.verbraucht[a] = Math.max(0, (t.verbraucht[a] || 0) - v[a]);
    const r = rest(t);
    for (const a of ARTEN) if (r[a] !== null && r[a] > WARN_AB) delete t.gewarnt[a];
  }, opts.store);
  return rest(t);
}

/** Stand für Admin und shop-status */
async function stand(tag, s) {
  s = s || store();
  tag = tag || heute();
  const standard = await s.get('standard', { type: 'json' }).catch(() => null);
  const t = (await s.get('tag:' + tag, { type: 'json' }).catch(() => null)) || neuerTag(standard);
  const r = rest(t);
  return {
    tag,
    gezaehlt: ARTEN.some((a) => t.start[a] !== null),
    start: t.start,
    rest: r,
    verbraucht: t.verbraucht,
    ausverkauft: ausverkauft(r),
    standard: standard || null,
  };
}

/**
 * Admin setzt Werte. eingabe = { standard?: { buns, patties, auto }, start?: {...}, rest?: {...} }
 * - standard: Werte für jeden Morgen (auto = jeden Tag automatisch starten)
 * - start:    heutigen Startwert setzen (Verbrauch bleibt)
 * - rest:     „Es sind noch X da“ (setzt den Verbrauch passend, Start bleibt)
 */
async function setzen(eingabe, tag, s) {
  s = s || store();
  tag = tag || heute();
  if (eingabe && eingabe.standard && typeof eingabe.standard === 'object') {
    const st = eingabe.standard;
    await s.setJSON('standard', {
      buns: zahl(st.buns), patties: zahl(st.patties), auto: st.auto !== false,
      warnAb: zahl(st.warnAb) || WARN_AB, geaendert: new Date().toISOString(),
    });
  }
  await aendereTag(tag, (t) => {
    let etwas = false;
    for (const a of ARTEN) {
      if (eingabe && eingabe.start && a in eingabe.start) {
        t.start[a] = eingabe.start[a] === null || eingabe.start[a] === '' ? null : zahl(eingabe.start[a]);
        etwas = true;
      }
      if (eingabe && eingabe.rest && a in eingabe.rest) {
        const neu = zahl(eingabe.rest[a]);
        if (neu !== null) {
          if (t.start[a] === null || t.start[a] < neu) t.start[a] = neu + ((t.verbraucht && t.verbraucht[a]) || 0);
          t.verbraucht[a] = t.start[a] - neu;
          etwas = true;
        }
      }
    }
    // Wieder aufgefüllt: Warnungen neu scharf schalten
    if (etwas) { const r = rest(t); for (const a of ARTEN) if (r[a] === null || r[a] > WARN_AB) delete t.gewarnt[a]; }
    return etwas;
  }, s);
  return stand(tag, s);
}

module.exports = { verbrauch, rest, ausverkauft, abziehen, zurueckbuchen, stand, setzen, ARTEN, NAMEN };
