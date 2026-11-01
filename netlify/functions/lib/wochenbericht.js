/**
 * lib/wochenbericht.js
 * ----------------------------------------------------------------------------
 * Wochenbericht für Kubi per Telegram, montags für die Woche davor
 * (Montag bis Sonntag, Europe/Berlin).
 *
 *   baueWochenbericht(daten)   reine Funktion: Daten -> Telegram-Text (HTML)
 *   sammleWochendaten(o)       liest Bestellungen, Feedback, Catering, Firmen
 *   sendeWochenbericht(o)      sammeln, bauen, senden
 *
 * Inhalt: Umsatz, Bestellungen, Durchschnittsbon, Vergleich zur Vorwoche,
 * Abholung gegen Lieferung, Top 5. Dazu, nur wenn etwas da ist: Feedback der
 * Woche, offene Catering-Anfragen und Angebote, neue Firmenanträge und ein
 * Hinweis, wenn für beliebte Artikel der Wareneinsatz fehlt.
 *
 * Keine Kundennamen, keine Adressen, keine Kontaktdaten. Aus Feedback-Texten
 * werden Mail-Adressen und Telefonnummern entfernt.
 *
 * Die Stores feedback, firmen und die Angebote (catering, angebot:) legen
 * andere Bausteine an. Fehlen sie oder sehen Felder anders aus, fällt der
 * Abschnitt still weg; der Bericht kommt trotzdem.
 * ----------------------------------------------------------------------------
 */

const { telegram, esc } = require('./telegram');
const tw = require('./tageswerte');
const ma = require('./menue-analyse');

const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const fmtEur = (x) => eur.format(Number(x) || 0).replace(/\u00a0/g, ' ');
const fmtZahl = (x, st) => new Intl.NumberFormat('de-DE', { minimumFractionDigits: st || 0, maximumFractionDigits: st || 0 }).format(x);
const tagMonat = (d) => d.slice(8, 10) + '.' + d.slice(5, 7) + '.';
const tagMonatJahr = (d) => tagMonat(d) + d.slice(0, 4);

/* ---------------- Zeitraum ---------------- */
/** Letzte vollständige Woche Montag bis Sonntag vor dem Tag von jetzt. */
function letzteWoche(jetzt) {
  const heute = tw.berlinDate(jetzt || Date.now());
  const wt = new Date(heute + 'T12:00:00Z').getUTCDay() || 7;   // Montag 1 bis Sonntag 7
  const montag = tw.plusTage(heute, -(wt - 1));
  const von = tw.plusTage(montag, -7);
  return { von, bis: tw.plusTage(von, 6), kw: isoWoche(von) };
}
function isoWoche(d) {
  const t = new Date(d + 'T12:00:00Z');
  const wt = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - wt);
  const jahr = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - jahr) / 86400000 + 1) / 7);
}

/* ---------------- Text ---------------- */
/* Feedback-Text kürzen und Kontaktdaten entfernen. Eigene Formulierungen
   des Gastes bleiben stehen (Zitat). */
function kuerze(text, max) {
  let t = String(text || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    // Gruß und Unterschrift am Ende weglassen, dort stehen Namen
    .replace(/(^|[\s.,;:!?])((viele|liebe|beste|freundliche|schöne)\s+)?(grüße|grüsse|gruß|gruss|lg|vg|mfg)(?=$|[\s.,;:!?])[\s\S]*$/i, '$1')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '…')
    .replace(/\+?\d[\d\s/().-]{6,}\d/g, '…')
    .replace(/\s+/g, ' ')
    .trim();
  const m = max || 120;
  if (t.length > m) {
    const schnitt = t.lastIndexOf(' ', m);
    t = t.slice(0, schnitt > m * 0.6 ? schnitt : m).replace(/[\s.,;:]+$/, '') + ' …';
  }
  return t;
}

function vergleich(jetzt, vorher) {
  if (!(vorher > 0)) return jetzt > 0 ? 'Vorwoche ohne Umsatz.' : '';
  const p = Math.round((jetzt - vorher) / vorher * 100);
  if (p === 0) return 'Wie in der Vorwoche (' + fmtEur(vorher) + ').';
  return (p > 0 ? '+' : '-') + Math.abs(p) + ' % zur Vorwoche (' + fmtEur(vorher) + ').';
}

/**
 * Den Bericht bauen. Rein: gleiche Daten, gleicher Text.
 * @param {object} d  { von, bis, kw, woche:{umsatz,bestellungen,abholung,lieferung},
 *                      vorwoche:{umsatz,bestellungen}, top:[{name,qty}],
 *                      feedback, catering, firmen, fehlenderWareneinsatz:[name] }
 */
function baueWochenbericht(d) {
  const z = [];
  const w = d.woche || {};
  const vw = d.vorwoche || {};
  z.push('<b>Wochenbericht KW ' + esc(d.kw) + '</b>');
  z.push('Montag ' + tagMonat(d.von) + ' bis Sonntag ' + tagMonatJahr(d.bis));

  z.push('');
  z.push('<b>Umsatz</b>');
  const n = w.bestellungen || 0;
  if (!n) {
    z.push('Keine Bestellungen in dieser Woche.');
    if (vw.bestellungen) z.push('Vorwoche: ' + vw.bestellungen + ' Bestellungen, ' + fmtEur(vw.umsatz) + '.');
  } else {
    z.push(fmtEur(w.umsatz) + '. ' + vergleich(w.umsatz, vw.umsatz));
    z.push(n + (n === 1 ? ' Bestellung' : ' Bestellungen') + ', Durchschnittsbon ' + fmtEur(w.umsatz / n) + '.');
    const ab = w.abholung || 0, li = w.lieferung || 0;
    const pz = (x) => Math.round(x / Math.max(1, ab + li) * 100);
    z.push('Abholung ' + ab + ' (' + pz(ab) + ' %), Lieferung ' + li + ' (' + pz(li) + ' %).');
  }

  const top = (d.top || []).filter((t) => t && t.qty > 0).slice(0, 5);
  if (top.length) {
    z.push('');
    z.push('<b>Top 5</b>');
    top.forEach((t, i) => z.push((i + 1) + '. ' + esc(t.name) + ': ' + t.qty + ' Stück'));
  }

  const fb = d.feedback;
  if (fb && fb.anzahl > 0) {
    z.push('');
    z.push('<b>Feedback</b>');
    z.push('Schnitt ' + fmtZahl(fb.schnitt, 1) + ' von 5 Sternen aus ' + fb.anzahl + (fb.anzahl === 1 ? ' Bewertung.' : ' Bewertungen.'));
    const s = fb.schwaechste;
    if (s && s.stars < 5) {
      const text = kuerze(s.text, 120);
      z.push('Schwächste: ' + s.stars + (s.stars === 1 ? ' Stern' : ' Sterne') + (text ? '. „' + esc(text) + '“' : '.'));
    }
  }

  const c = d.catering;
  if (c && (c.ohneAngebot > 0 || c.offeneAngebote > 0)) {
    z.push('');
    z.push('<b>Catering</b>');
    if (c.ohneAngebot > 0) {
      z.push(c.ohneAngebot === 1 ? '1 Anfrage ohne Angebot.' : c.ohneAngebot + ' Anfragen ohne Angebot.');
    }
    if (c.offeneAngebote > 0) {
      z.push((c.offeneAngebote === 1 ? '1 Angebot ist offen' : c.offeneAngebote + ' Angebote sind offen')
        + (c.entwuerfe > 0 ? ', davon ' + c.entwuerfe + (c.entwuerfe === 1 ? ' Entwurf.' : ' Entwürfe.') : '.'));
    }
  }

  const f = d.firmen;
  if (f && f.offen > 0) {
    z.push('');
    z.push('<b>Firmenkunden</b>');
    z.push((f.offen === 1 ? '1 Antrag wartet' : f.offen + ' Anträge warten') + ' auf Prüfung'
      + (f.neu > 0 ? ', ' + f.neu + ' davon neu in dieser Woche.' : '.'));
  }

  const fehlt = (d.fehlenderWareneinsatz || []).slice(0, 6);
  if (fehlt.length) {
    z.push('');
    z.push('<b>Hinweis</b>');
    z.push('Wareneinsatz fehlt für beliebte Artikel: ' + fehlt.map(esc).join(', ') + '. Eintragen im Cockpit unter Auswertung.');
  }
  return z.join('\n');
}

/* ---------------- Daten sammeln ---------------- */
const zeitVon = (rec, key) => {
  for (const f of ['at', 'createdAt', 'receivedAt', 'eingegangen', 'angelegt', 'datum', 'zeit']) {
    const t = rec && rec[f] ? Date.parse(rec[f]) : NaN;
    if (Number.isFinite(t)) return t;
  }
  const m = /(\d{12,14})/.exec(key || '');
  return m ? Number(m[1]) : null;
};
const status = (rec) => String((rec && (rec.status || rec.stand)) || '').toLowerCase().trim();

async function liesListe(storeName, prefix, filter, max) {
  const s = tw.store(storeName);
  const { blobs } = await s.list({ prefix });
  const keys = blobs.map((b) => b.key).filter((k) => !filter || filter(k)).slice(-(max || 500));
  const out = [];
  for (let i = 0; i < keys.length; i += 40) {
    const teil = keys.slice(i, i + 40);
    const got = await Promise.all(teil.map((k) => s.get(k, { type: 'json' }).catch(() => null)));
    got.forEach((rec, j) => { if (rec && typeof rec === 'object') out.push({ key: teil[j], rec }); });
  }
  return out;
}

async function feedbackDerWoche(vonMs, bisMs) {
  const liste = await liesListe('feedback', 'f:', (k) => { const t = tw.keyZeit(k); return t === null || t >= vonMs - 21 * 86400000; });
  const woche = [];
  for (const { key, rec } of liste) {
    const t = zeitVon(rec, key);
    const stars = Math.round(Number(rec.stars));
    if (t === null || t < vonMs || t >= bisMs || !(stars >= 1 && stars <= 5)) continue;
    woche.push({ stars, text: typeof rec.text === 'string' ? rec.text.slice(0, 500) : '', t, ref: rec.ref || key.slice(2) });
  }
  if (!woche.length) return null;
  woche.sort((a, b) => a.stars - b.stars || b.t - a.t);
  return {
    anzahl: woche.length,
    schnitt: Math.round(woche.reduce((s, x) => s + x.stars, 0) / woche.length * 10) / 10,
    schwaechste: { stars: woche[0].stars, text: await ohneNamen(woche[0].text, woche[0].ref) },
  };
}

/* Schreibt der Gast seinen Namen in den Text, steht er auch in der
   Bestellung. Diese Namensteile werden aus dem Zitat entfernt. */
async function ohneNamen(text, ref) {
  let t = String(text || '');
  const r = String(ref || '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 60);
  if (!t || !r) return t;
  try {
    const rec = await tw.store('orders').get('o:' + r, { type: 'json' });
    const name = rec && rec.order && typeof rec.order.name === 'string' ? rec.order.name : '';
    for (const teil of name.split(/[\s,.-]+/).filter((x) => x.length >= 3).slice(0, 6)) {
      t = t.replace(new RegExp(teil.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), '…');
    }
  } catch (e) { /* ohne Bestellung bleibt der Text, wie er ist */ }
  return t;
}

const ANGEBOT_ZU = ['angenommen', 'abgelehnt', 'abgelaufen', 'storniert', 'erledigt', 'bezahlt', 'zurueckgezogen', 'zurückgezogen',
  'accepted', 'declined', 'rejected', 'expired', 'cancelled', 'canceled', 'done', 'paid'];
const ANGEBOT_ENTWURF = ['entwurf', 'draft'];

async function cateringOffen(jetzt) {
  const heute = tw.berlinDate(jetzt);
  const anfragen = await liesListe('catering', 'c:', (k) => { const t = Number((/^c:(\d{12,14})/.exec(k) || [])[1]); return !t || t >= jetzt - 120 * 86400000; });
  const angebote = await liesListe('catering', 'angebot:', null, 300);

  const verknuepft = new Set();
  let offen = 0, entwuerfe = 0;
  for (const { rec } of angebote) {
    for (const f of ['anfrage', 'anfrageKey', 'anfrageId', 'request', 'requestKey', 'cateringKey', 'quelle']) {
      const v = rec[f];
      if (typeof v === 'string' && v) { verknuepft.add(v); verknuepft.add(v.replace(/^c:/, '')); }
    }
    const st = status(rec);
    if (ANGEBOT_ZU.indexOf(st) !== -1) continue;
    offen += 1;
    if (ANGEBOT_ENTWURF.indexOf(st) !== -1) entwuerfe += 1;
  }
  let ohneAngebot = 0;
  for (const { key, rec } of anfragen) {
    if (rec.done) continue;
    if (rec.angebot || rec.angebotId || rec.angebotKey || rec.offer) continue;
    if (verknuepft.has(key) || verknuepft.has(key.replace(/^c:/, ''))) continue;
    const termin = /^\d{4}-\d{2}-\d{2}/.test(String(rec.date || '')) ? String(rec.date).slice(0, 10) : null;
    if (termin && termin < heute) continue;   // Termin vorbei
    ohneAngebot += 1;
  }
  return { ohneAngebot, offeneAngebote: offen, entwuerfe };
}

const ANTRAG_ENTSCHIEDEN = ['freigegeben', 'genehmigt', 'angenommen', 'aktiv', 'abgelehnt', 'gesperrt', 'erledigt',
  'approved', 'rejected', 'declined', 'active', 'done'];

async function firmenAntraege(vonMs, bisMs) {
  const liste = await liesListe('firmen', 'antrag:', null, 300);
  let offen = 0, neu = 0;
  for (const { key, rec } of liste) {
    if (ANTRAG_ENTSCHIEDEN.indexOf(status(rec)) !== -1) continue;
    offen += 1;
    const t = zeitVon(rec, key);
    if (t !== null && t >= vonMs && t < bisMs) neu += 1;
  }
  return { offen, neu };
}

async function versuch(fn) {
  try { return await fn(); } catch (e) { console.error('wochenbericht:', e && e.message); return null; }
}

/**
 * Alles für den Bericht der letzten vollständigen Woche zusammentragen.
 * @param {object} [o]  { jetzt }
 */
async function sammleWochendaten(o) {
  const jetzt = (o && o.jetzt) || Date.now();
  const sk = require('../../../speisekarte.js');
  const w = letzteWoche(jetzt);
  const vorVon = tw.plusTage(w.von, -7);
  const tage = await tw.liesTage(tw.tageVonBis(vorVon, w.bis), { jetzt });
  const diese = tw.summiere(tw.tageVonBis(w.von, w.bis).map((d) => tage[d]));
  const vorher = tw.summiere(tw.tageVonBis(vorVon, tw.plusTage(w.von, -1)).map((d) => tage[d]));
  const vonMs = tw.berlinMitternacht(w.von);
  const bisMs = tw.berlinMitternacht(tw.plusTage(w.bis, 1));

  const namen = {};
  for (const a of ma.artikelListe(sk)) namen[a.id] = a.name;
  const top = Object.entries(diese.haupt)
    .map(([id, qty]) => ({ name: namen[id] || id, qty }))
    .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name, 'de'))
    .slice(0, 5);

  const kosten = await versuch(() => tw.store('kosten').get('artikel', { type: 'json' }));
  const auswertung = ma.auswerten(sk, diese, kosten || {});

  const [feedback, catering, firmen] = await Promise.all([
    versuch(() => feedbackDerWoche(vonMs, bisMs)),
    versuch(() => cateringOffen(jetzt)),
    versuch(() => firmenAntraege(vonMs, bisMs)),
  ]);

  return {
    von: w.von, bis: w.bis, kw: w.kw,
    woche: { umsatz: diese.revenue, bestellungen: diese.orders, abholung: diese.pickup, lieferung: diese.delivery },
    vorwoche: { umsatz: vorher.revenue, bestellungen: vorher.orders },
    top,
    feedback,
    catering,
    firmen,
    fehlenderWareneinsatz: ma.beliebtOhneKosten(auswertung).map((a) => a.name),
  };
}

/**
 * Sammeln, bauen, senden.
 * @returns {Promise<{ text, gesendet, von, bis }>}
 */
async function sendeWochenbericht(o) {
  const daten = await sammleWochendaten(o);
  const text = baueWochenbericht(daten);
  const gesendet = (o && o.nurVorschau) ? false : await telegram(text, { html: true });
  return { text, gesendet, von: daten.von, bis: daten.bis };
}

module.exports = { baueWochenbericht, sammleWochendaten, sendeWochenbericht, letzteWoche, isoWoche, kuerze };
