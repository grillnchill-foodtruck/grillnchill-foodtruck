/**
 * lib/catering-angebot.js
 * ----------------------------------------------------------------------------
 * Catering-Angebote mit einem Klick: aus einer Anfrage wird ein Angebot mit
 * fortlaufender Nummer, PDF und Kundenlink. Der Kunde nimmt online an, auf
 * Wunsch zahlt er die Anzahlung über SumUp.
 *
 * Speicher: Blob-Store "catering" (dort liegen auch die Anfragen c:…).
 *   angebot:<id>              das Angebot (id = 12 Hexzeichen)
 *   angebot-zaehler:<jahr>    letzter Stand der Nummer, { n }
 *   angebot-nr:<nummer>       Reservierung der Nummer (onlyIfNew)
 *   angebot-annahme:<id>      Marker: Annahme ist durch (onlyIfNew, nur einmal)
 *   angebot-zahlung:<id>      Marker: Anzahlung ist verbucht (onlyIfNew)
 *   angebot-erinnerung:<id>   Marker: Erinnerungsmail ist raus (onlyIfNew)
 *   angebot-einstellungen     Paketpreise, Pauschalen, Gültigkeit, Anzahlung
 *
 * Status: entwurf -> gesendet -> angenommen -> bezahlt
 *                            \-> abgelehnt | abgelaufen
 *
 * Beträge sind Endpreise inklusive gesetzlicher MwSt. Ein Angebot ist keine
 * Rechnung: keine Steueraufteilung, keine Rechnungsnummer. Gerechnet wird in
 * Cent, gespeichert in Euro mit zwei Nachkommastellen.
 *
 * Anzahlung online steht hinter dem Schalter einstellungen.anzahlungOnline
 * (Standard AUS). Eine Anzahlung kann eine Anzahlungsrechnung auslösen
 * (§ 14 Abs. 5 UStG); das klärt Kubi mit dem Steuerberater, bevor er den
 * Schalter umlegt.
 * ----------------------------------------------------------------------------
 */

const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { telegram, esc: tEsc } = require('./telegram');

const SUMUP_API_BASE = 'https://api.sumup.com/v0.1';
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

function store() {
  const opts = { name: 'catering', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

function seite() {
  return (process.env.SITE_URL || process.env.URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');
}

/* ---- Status --------------------------------------------------------------- */
const STATUS = ['entwurf', 'gesendet', 'angenommen', 'bezahlt', 'abgelehnt', 'abgelaufen'];
const STATUS_NAME = {
  entwurf: 'Entwurf', gesendet: 'Gesendet', angenommen: 'Angenommen',
  bezahlt: 'Bezahlt', abgelehnt: 'Abgelehnt', abgelaufen: 'Abgelaufen',
};
// Von Hand (Telefon, bar, Absage): Ziel -> erlaubte Ausgangsstände
const VON_HAND = {
  angenommen: ['entwurf', 'gesendet', 'abgelaufen', 'abgelehnt', 'bezahlt'],
  bezahlt: ['entwurf', 'gesendet', 'angenommen', 'abgelaufen'],
  abgelehnt: ['entwurf', 'gesendet', 'angenommen', 'abgelaufen'],
};

/* ---- Einstellungen -------------------------------------------------------- */
// Standardwerte wie auf /catering und im Funnel der Startseite
const STANDARD = {
  pakete: {
    classic: { name: 'Classic', preis: 21, ab: 30, text: '1 Burger nach Wahl aus der Event-Karte, Pommes mit Dip' },
    gnc: { name: "Grill'n Chill", preis: 26, ab: 30, text: '1 Burger nach Wahl mit Double Patty, Pommes mit Dip' },
    flat: { name: 'All-in Flat', preis: 32, ab: 40, text: '2 Stunden Burger-Flatrate aus der Event-Karte, Pommes inklusive' },
  },
  pauschale: 300,
  pauschaleWochenende: 450,
  inklKm: 25,
  kmPreis: 1,
  stundenPreis: 89,
  inklStunden: 2.5,
  gueltigTage: 14,
  anzahlungProzent: 30,
  anzahlungOnline: false,
};
const PAKETE = Object.keys(STANDARD.pakete);

function zahl(v, min, max, ersatz, stellen) {
  const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : Number(v);
  if (!Number.isFinite(n)) return ersatz;
  const f = Math.pow(10, stellen == null ? 2 : stellen);
  return Math.min(max, Math.max(min, Math.round(n * f) / f));
}
function text(v, max) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/g, '')
    .trim().slice(0, max);
}
function einzeilig(v, max) { return text(v, max).replace(/\s+/g, ' '); }

function einstellungenMischen(roh) {
  const r = roh && typeof roh === 'object' ? roh : {};
  const out = JSON.parse(JSON.stringify(STANDARD));
  for (const k of PAKETE) {
    const p = r.pakete && r.pakete[k];
    if (!p || typeof p !== 'object') continue;
    const st = STANDARD.pakete[k];
    out.pakete[k] = {
      name: einzeilig(p.name, 40) || st.name,
      preis: zahl(p.preis, 0, 1000, st.preis),
      ab: zahl(p.ab, 0, 2000, st.ab, 0),
      text: einzeilig(p.text, 160) || st.text,
    };
  }
  out.pauschale = zahl(r.pauschale, 0, 20000, STANDARD.pauschale);
  out.pauschaleWochenende = zahl(r.pauschaleWochenende, 0, 20000, STANDARD.pauschaleWochenende);
  out.inklKm = zahl(r.inklKm, 0, 1000, STANDARD.inklKm, 0);
  out.kmPreis = zahl(r.kmPreis, 0, 50, STANDARD.kmPreis);
  out.stundenPreis = zahl(r.stundenPreis, 0, 2000, STANDARD.stundenPreis);
  out.inklStunden = zahl(r.inklStunden, 0, 24, STANDARD.inklStunden, 1);
  out.gueltigTage = zahl(r.gueltigTage, 1, 90, STANDARD.gueltigTage, 0);
  out.anzahlungProzent = zahl(r.anzahlungProzent, 0, 100, STANDARD.anzahlungProzent, 0);
  out.anzahlungOnline = r.anzahlungOnline === true;
  return out;
}

async function einstellungenLesen(s) {
  let roh = null;
  try { roh = await (s || store()).get('angebot-einstellungen', { type: 'json' }); } catch (e) {}
  return einstellungenMischen(roh);
}
async function einstellungenSpeichern(roh, wer) {
  const s = store();
  const e = einstellungenMischen(roh);
  await s.setJSON('angebot-einstellungen', { ...e, geaendertAm: new Date().toISOString(), geaendertVon: wer || '' });
  return e;
}

/* ---- Datum (Europe/Berlin) ------------------------------------------------ */
function heute(jetzt) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(jetzt || new Date());
}
const istTag = (x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
function utc(ymd) { const [y, m, d] = ymd.split('-').map(Number); return Date.UTC(y, m - 1, d); }
function plusTage(ymd, n) { return new Date(utc(ymd) + n * 864e5).toISOString().slice(0, 10); }
/** Kalendertage zwischen einem Zeitpunkt (ISO) und jetzt, in Berliner Zeit. */
function tageSeit(iso, jetzt) {
  if (!iso) return 0;
  const t = new Date(iso);
  if (isNaN(t)) return 0;
  return Math.round((utc(heute(jetzt)) - utc(heute(t))) / 864e5);
}
function wochentag(ymd) { return new Date(utc(ymd)).getUTCDay(); }
const WOCHENTAGE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
function deDatum(ymd) { return istTag(ymd) ? ymd.split('-').reverse().join('.') : ''; }
function deDatumLang(ymd) { return istTag(ymd) ? WOCHENTAGE[wochentag(ymd)] + ', ' + deDatum(ymd) : ''; }

/* ---- Geld ----------------------------------------------------------------- */
const cent = (eur) => Math.round((Number(eur) || 0) * 100);
const euro = (c) => Math.round(c) / 100;
function eur(n) {
  return (Number(n) || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}
function dez(n) { return String(n).replace('.', ','); }

/* ---- Positionen ----------------------------------------------------------- */
const ARTEN = ['paket', 'pauschale', 'anfahrt', 'stunde', 'extra'];

/** Vorgabetext einer Position. Weicht der Text davon ab, hat Kubi ihn selbst geschrieben. */
function standardText(z, e) {
  if (z.art === 'paket') {
    const p = e.pakete[z.paket];
    return p ? 'Paket ' + p.name + ': ' + p.text : '';
  }
  if (z.art === 'pauschale') return 'Event-Pauschale: Anfahrt bis ' + e.inklKm + ' km, Auf- und Abbau, Personal, bis ' + dez(e.inklStunden) + ' Std. Ausgabe';
  if (z.art === 'anfahrt') return 'Anfahrt über ' + e.inklKm + ' km (je km)';
  if (z.art === 'stunde') return 'Zusätzliche Stunde Ausgabe';
  return '';
}

function rechnen(a) {
  const zeilen = (a.zeilen || []).map((z) => ({ ...z, betrag: euro(Math.round(cent(z.einzel) * (Number(z.menge) || 0))) }));
  const summeC = zeilen.reduce((n, z) => n + cent(z.betrag), 0);
  const r = a.rabatt || {};
  let rabattC = 0;
  if (r.art === 'prozent') rabattC = Math.round(summeC * (Number(r.wert) || 0) / 100);
  else if (r.art === 'betrag') rabattC = Math.min(cent(r.wert), summeC);
  rabattC = Math.max(0, Math.min(rabattC, summeC));
  const gesamtC = summeC - rabattC;
  const anzC = Math.round(gesamtC * (Number(a.anzahlungProzent) || 0) / 100);
  return {
    zeilen,
    summe: euro(summeC),
    rabattBetrag: euro(rabattC),
    gesamt: euro(gesamtC),
    anzahlung: euro(anzC),
    rest: euro(gesamtC - anzC),
  };
}

/** Eingaben aus dem Editor prüfen und zuschneiden. Unbekanntes fällt weg. */
function entwurfBereinigen(roh, e) {
  const r = roh && typeof roh === 'object' ? roh : {};
  const k = r.kunde || {};
  const ev = r.event || {};
  const kunde = {
    name: einzeilig(k.name, 80),
    firma: einzeilig(k.firma, 80),
    email: einzeilig(k.email, 120).toLowerCase(),
    telefon: einzeilig(k.telefon, 40),
  };
  const paket = PAKETE.includes(ev.paket) ? ev.paket : '';
  const event = {
    datum: istTag(ev.datum) ? ev.datum : '',
    zeit: einzeilig(ev.zeit, 60),
    ort: einzeilig(ev.ort, 160),
    personen: zahl(ev.personen, 0, 5000, 0, 0),
    paket,
  };
  const zeilen = (Array.isArray(r.zeilen) ? r.zeilen : []).slice(0, 30).map((z) => {
    const art = ARTEN.includes(z && z.art) ? z.art : 'extra';
    const zeile = {
      art,
      text: einzeilig(z.text, 200),
      menge: zahl(z.menge, 0, 100000, 0),
      einzel: zahl(z.einzel, 0, 100000, 0),
    };
    if (art === 'paket') zeile.paket = PAKETE.includes(z.paket) ? z.paket : (paket || 'gnc');
    const std = standardText(zeile, e);
    if (!zeile.text) zeile.text = std;
    zeile.standard = !!std && zeile.text === std;
    return zeile;
  }).filter((z) => z.text);
  const ra = r.rabatt || {};
  const rabattArt = ra.art === 'prozent' || ra.art === 'betrag' ? ra.art : 'keiner';
  const rabatt = {
    art: rabattArt,
    wert: rabattArt === 'prozent' ? zahl(ra.wert, 0, 100, 0) : rabattArt === 'betrag' ? zahl(ra.wert, 0, 1000000, 0) : 0,
  };
  return {
    kunde, event, zeilen, rabatt,
    gueltigTage: zahl(r.gueltigTage, 1, 90, e.gueltigTage, 0),
    anzahlungProzent: zahl(r.anzahlungProzent, 0, 100, e.anzahlungProzent, 0),
    hinweis: text(r.hinweis, 1000),
  };
}

/* ---- Vorbefüllen aus der Anfrage ------------------------------------------ */
function paketAusText(t) {
  const s = String(t || '');
  if (/flat/i.test(s)) return 'flat';
  if (/classic/i.test(s)) return 'classic';
  if (/grill/i.test(s)) return 'gnc';
  return '';
}
function personenAusText(t) { const m = String(t || '').match(/\d+/); return m ? parseInt(m[0], 10) : 0; }
function pauschaleFuer(datum, e) {
  const wt = istTag(datum) ? wochentag(datum) : -1;
  return wt === 5 || wt === 6 ? e.pauschaleWochenende : e.pauschale;
}
function grundZeilen(paket, personen, datum, e) {
  return [
    { art: 'paket', paket, menge: personen, einzel: e.pakete[paket].preis },
    { art: 'pauschale', menge: 1, einzel: pauschaleFuer(datum, e) },
    { art: 'anfahrt', menge: 0, einzel: e.kmPreis },
  ].map((z) => ({ ...z, text: standardText(z, e), standard: true }));
}
function entwurfAusAnfrage(anf, e) {
  const a = anf || {};
  const paket = paketAusText(a.package) || 'gnc';
  const personen = personenAusText(a.guests) || e.pakete[paket].ab;
  const datum = istTag(a.date) ? a.date : '';
  return {
    kunde: { name: einzeilig(a.name, 80), firma: '', email: einzeilig(a.email, 120).toLowerCase(), telefon: einzeilig(a.phone, 40) },
    event: { datum, zeit: '', ort: einzeilig(a.location, 160), personen, paket },
    zeilen: grundZeilen(paket, personen, datum, e),
    rabatt: { art: 'keiner', wert: 0 },
    gueltigTage: e.gueltigTage,
    anzahlungProzent: e.anzahlungProzent,
    hinweis: '',
    // Nur fürs Admin-Tool: was der Kunde angefragt hat
    anfrageInfo: {
      gaeste: einzeilig(a.guests, 40), paket: einzeilig(a.package, 60),
      nachricht: text(a.msg, 1000), kontaktweg: einzeilig(a.contactPref, 30),
    },
  };
}
function leererEntwurf(e) {
  return {
    kunde: { name: '', firma: '', email: '', telefon: '' },
    event: { datum: '', zeit: '', ort: '', personen: e.pakete.gnc.ab, paket: 'gnc' },
    zeilen: grundZeilen('gnc', e.pakete.gnc.ab, '', e),
    rabatt: { art: 'keiner', wert: 0 },
    gueltigTage: e.gueltigTage,
    anzahlungProzent: e.anzahlungProzent,
    hinweis: '',
  };
}

/* ---- Nummer und Token ----------------------------------------------------- */
/* Fortlaufend je Jahr: A-2026-0001. Die Nummer wird erst reserviert
   (onlyIfNew), dann der Zähler fortgeschrieben. Wer beim Reservieren
   verliert, nimmt die nächste. So vergibt auch ein gleichzeitiger zweiter
   Aufruf nie dieselbe Nummer, und ein hängengebliebener Zähler heilt sich. */
async function naechsteNummer(s, id, jetzt) {
  const jahr = heute(jetzt).slice(0, 4);
  const key = 'angebot-zaehler:' + jahr;
  const cur = (await s.get(key, { type: 'json' })) || { n: 0 };
  let n = Number(cur.n) || 0;
  for (let versuch = 0; versuch < 50; versuch++) {
    n++;
    const nummer = 'A-' + jahr + '-' + String(n).padStart(4, '0');
    const res = await s.setJSON('angebot-nr:' + nummer, { id, at: (jetzt || new Date()).toISOString() }, { onlyIfNew: true });
    if (res && res.modified === false) continue;
    await s.setJSON(key, { n });
    return nummer;
  }
  throw new Error('Angebotsnummer konnte nicht vergeben werden');
}

const ID_FORM = /^[a-f0-9]{12}$/;
const TOKEN_FORM = /^[A-Za-z0-9_-]{32}$/;
function neueId() { return crypto.randomBytes(6).toString('hex'); }
function neuerToken() { return crypto.randomBytes(24).toString('base64url'); }
function tokenStimmt(a, t) {
  if (!a || typeof a.token !== 'string' || typeof t !== 'string' || !TOKEN_FORM.test(t)) return false;
  const x = Buffer.from(a.token), y = Buffer.from(t);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function kundenLink(a, basis) {
  return (basis || seite()) + '/angebot?id=' + a.id + '&t=' + a.token;
}

/* ---- Laden, Speichern ----------------------------------------------------- */
async function laden(s, id) {
  if (!ID_FORM.test(String(id || ''))) return null;
  return (await s.get('angebot:' + id, { type: 'json' })) || null;
}
async function sichern(s, a) { await s.setJSON('angebot:' + a.id, a); }
function vermerk(a, was, wer, jetzt) {
  a.verlauf = (a.verlauf || []).concat([{ at: (jetzt || new Date()).toISOString(), was, wer: wer || '' }]).slice(-40);
}

function istAbgelaufen(a, jetzt) {
  const h = heute(jetzt);
  return (istTag(a.gueltigBis) && a.gueltigBis < h) || (a.event && istTag(a.event.datum) && a.event.datum < h);
}
/** Ein gesendetes Angebot nach Ablauf gilt schon als abgelaufen, bevor der Zeitplan es umschreibt. */
function wirksamerStatus(a, jetzt) {
  if (a && a.status === 'gesendet' && istAbgelaufen(a, jetzt)) return 'abgelaufen';
  return a ? a.status : '';
}

async function anlegen({ anfrageKey, vorlage, wer, jetzt }) {
  const s = store();
  const e = await einstellungenLesen(s);
  let basis;
  if (vorlage) basis = vorlage;
  else if (anfrageKey) {
    if (!/^c:[\w-]{1,60}$/.test(anfrageKey)) throw fehler('bad_key', 400);
    const anf = await s.get(anfrageKey, { type: 'json' });
    if (!anf) throw fehler('anfrage_fehlt', 404);
    basis = entwurfAusAnfrage(anf, e);
  } else basis = leererEntwurf(e);

  const t = jetzt || new Date();
  const id = neueId();
  const nummer = await naechsteNummer(s, id, t);
  const a = {
    id, nummer, token: neuerToken(), status: 'entwurf',
    anfrage: anfrageKey || null,
    ...basis,
    erstelltAm: t.toISOString(), geaendertAm: t.toISOString(),
  };
  Object.assign(a, rechnen(a));
  vermerk(a, 'angelegt', wer, t);
  await sichern(s, a);
  return a;
}

async function speichern(id, roh, { wer, jetzt } = {}) {
  const s = store();
  const a = await laden(s, id);
  if (!a) throw fehler('nicht_gefunden', 404);
  if (a.status !== 'entwurf') throw fehler('nur_entwurf', 409);
  const e = await einstellungenLesen(s);
  Object.assign(a, entwurfBereinigen(roh, e));
  Object.assign(a, rechnen(a));
  a.geaendertAm = (jetzt || new Date()).toISOString();
  a.geaendertVon = wer || '';
  await sichern(s, a);
  return a;
}

async function loeschen(id) {
  const s = store();
  const a = await laden(s, id);
  if (!a) throw fehler('nicht_gefunden', 404);
  if (a.status !== 'entwurf') throw fehler('nur_entwurf', 409);
  await s.delete('angebot:' + id);
  return true;
}

async function duplizieren(id, { wer, jetzt } = {}) {
  const s = store();
  const a = await laden(s, id);
  if (!a) throw fehler('nicht_gefunden', 404);
  const vorlage = {
    kunde: { ...a.kunde }, event: { ...a.event },
    zeilen: (a.zeilen || []).map((z) => { const { betrag, ...rest } = z; return rest; }),
    rabatt: { ...(a.rabatt || { art: 'keiner', wert: 0 }) },
    gueltigTage: a.gueltigTage, anzahlungProzent: a.anzahlungProzent, hinweis: a.hinweis || '',
    ...(a.anfrageInfo ? { anfrageInfo: a.anfrageInfo } : {}),
  };
  const neu = await anlegen({ anfrageKey: a.anfrage, vorlage, wer, jetzt });
  neu.vorgaenger = a.id;
  neu.vorgaengerNummer = a.nummer;
  neu.verlauf = [{ at: neu.erstelltAm, was: 'dupliziert aus ' + a.nummer, wer: wer || '' }];
  await sichern(s, neu);
  return neu;
}

/* ---- Senden --------------------------------------------------------------- */
async function senden(id, { wer, jetzt, basis } = {}) {
  const s = store();
  const a = await laden(s, id);
  if (!a) throw fehler('nicht_gefunden', 404);
  const t = jetzt || new Date();
  const st = wirksamerStatus(a, t);
  const erneut = st === 'gesendet';
  if (st !== 'entwurf' && !erneut) throw fehler('status', 409);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.kunde && a.kunde.email || '')) throw fehler('email_fehlt', 400);
  if (!a.kunde.name) throw fehler('name_fehlt', 400);
  if (!(a.gesamt > 0)) throw fehler('betrag_fehlt', 400);
  if (a.event && istTag(a.event.datum) && a.event.datum < heute(t)) throw fehler('datum_vorbei', 400);
  const e = await einstellungenLesen(s);

  if (!erneut) {
    let bis = plusTage(heute(t), a.gueltigTage || e.gueltigTage);
    // Nach dem Event gibt es nichts mehr anzunehmen
    if (a.event && istTag(a.event.datum) && a.event.datum < bis) bis = a.event.datum;
    a.gueltigBis = bis;
    a.gesendetAm = t.toISOString();
  }
  const pdf = await require('./angebot-pdf').angebotPdf(a, e);
  const mail = mailAngebot(a, e, kundenLink(a, basis));
  // Scheitert die Mail, bleibt das Angebot unverändert (nichts gespeichert)
  await brevo({
    an: a.kunde.email, name: a.kunde.name, betreff: mail.betreff, html: mail.html,
    anhaenge: [{ name: 'Angebot-' + a.nummer + '.pdf', content: pdf.toString('base64') }],
  });
  a.status = 'gesendet';
  a.geaendertAm = t.toISOString();
  vermerk(a, erneut ? 'erneut gesendet an ' + a.kunde.email : 'gesendet an ' + a.kunde.email, wer, t);
  await sichern(s, a);

  // Ein Duplikat ersetzt das alte, noch offene Angebot: das alte lässt sich nicht mehr annehmen
  if (!erneut && a.vorgaenger) {
    try {
      const v = await laden(s, a.vorgaenger);
      if (v && v.status === 'gesendet') {
        v.status = 'abgelehnt';
        v.abgelehntAm = t.toISOString();
        v.ersetztDurch = a.nummer;
        v.geaendertAm = t.toISOString();
        vermerk(v, 'ersetzt durch ' + a.nummer, wer, t);
        await sichern(s, v);
      }
    } catch (err) { console.error('angebot vorgaenger:', err.message); }
  }
  return a;
}

/* ---- Annehmen (Kunde) ----------------------------------------------------- */
async function annehmen(id, token, { lang, ipHash, jetzt, basis } = {}) {
  const s = store();
  const a = await laden(s, id);
  if (!a || a.status === 'entwurf' || !tokenStimmt(a, token)) return { code: 404, fehler: 'nicht_gefunden' };
  const t = jetzt || new Date();
  const st = wirksamerStatus(a, t);
  const e = await einstellungenLesen(s);
  if (st === 'angenommen' || st === 'bezahlt') return { code: 409, fehler: 'schon_angenommen', a, e };
  if (st !== 'gesendet') return { code: 409, fehler: st, a, e };

  // Nur einmal: wer den Marker zuerst anlegt, nimmt an. Ein zweiter Klick,
  // ein zweiter Tab oder ein Doppel-Request scheitert hier.
  const res = await s.setJSON('angebot-annahme:' + id, { at: t.toISOString(), lang: lang || '', ipHash: ipHash || '' }, { onlyIfNew: true });
  if (res && res.modified === false) {
    const neu = await laden(s, id);
    return { code: 409, fehler: 'schon_angenommen', a: neu || a, e };
  }
  a.status = 'angenommen';
  a.angenommenAm = t.toISOString();
  a.annahme = { weg: 'online', lang: lang || '', ipHash: ipHash || '', gesamt: a.gesamt };
  a.geaendertAm = t.toISOString();
  vermerk(a, 'vom Kunden online angenommen', 'Kunde', t);
  await sichern(s, a);

  const link = kundenLink(a, basis);
  await Promise.all([
    telegram(telegramAnnahme(a, e), { html: true }),
    (async () => {
      try { const m = mailAnnahme(a, e, link); await brevo({ an: a.kunde.email, name: a.kunde.name, betreff: m.betreff, html: m.html }); }
      catch (err) { console.error('angebot annahme-mail:', err.message); }
    })(),
  ]);
  return { code: 200, a, e };
}

/* ---- Status von Hand (Admin) ---------------------------------------------- */
async function statusSetzen(id, ziel, { wer, jetzt } = {}) {
  const s = store();
  const a = await laden(s, id);
  if (!a) throw fehler('nicht_gefunden', 404);
  const t = jetzt || new Date();
  const iso = t.toISOString();
  const st = wirksamerStatus(a, t);
  if (!VON_HAND[ziel] || !VON_HAND[ziel].includes(st)) throw fehler('status_nicht_moeglich', 409);

  if (ziel === 'angenommen' && st === 'bezahlt') {
    // Rückgängig: nur eine von Hand eingetragene Zahlung
    if (a.zahlung && a.zahlung.weg === 'online') throw fehler('online_bezahlt', 409);
    a.zahlung = { ...(a.zahlung || {}), status: 'ZURUECK' };
    a.bezahltAm = null;
    try { await s.delete('angebot-zahlung:' + id); } catch (e) {}
    vermerk(a, 'Zahlung zurückgenommen', wer, t);
  } else if (ziel === 'angenommen') {
    a.angenommenAm = iso;
    a.annahme = { weg: 'telefon', wer: wer || '', gesamt: a.gesamt };
    await s.setJSON('angebot-annahme:' + id, { at: iso, weg: 'telefon' }, { onlyIfNew: true });
    vermerk(a, 'von Hand angenommen (Telefon)', wer, t);
  } else if (ziel === 'bezahlt') {
    if (!a.angenommenAm) {
      a.angenommenAm = iso;
      a.annahme = { weg: 'telefon', wer: wer || '', gesamt: a.gesamt };
      await s.setJSON('angebot-annahme:' + id, { at: iso, weg: 'telefon' }, { onlyIfNew: true });
    }
    a.bezahltAm = iso;
    a.zahlung = { ...(a.zahlung || {}), status: 'PAID', weg: 'bar', betrag: a.anzahlung, bezahltAm: iso };
    await s.setJSON('angebot-zahlung:' + id, { at: iso, weg: 'bar' }, { onlyIfNew: true });
    vermerk(a, 'Anzahlung von Hand eingetragen (bar)', wer, t);
  } else if (ziel === 'abgelehnt') {
    a.abgelehntAm = iso;
    vermerk(a, 'von Hand abgelehnt', wer, t);
  }
  a.status = ziel;
  a.geaendertAm = iso;
  await sichern(s, a);
  return a;
}

/* ---- Anzahlung online (SumUp) --------------------------------------------- */
async function zahlungStarten(id, token, { jetzt, basis } = {}) {
  const s = store();
  const e = await einstellungenLesen(s);
  // Schalter zuerst: ist er aus, wird keine Kasse angelegt, egal was der Aufrufer schickt
  if (!e.anzahlungOnline) return { code: 403, fehler: 'anzahlung_aus' };
  const a = await laden(s, id);
  if (!a || a.status === 'entwurf' || !tokenStimmt(a, token)) return { code: 404, fehler: 'nicht_gefunden' };
  if (a.status !== 'angenommen') return { code: 409, fehler: a.status === 'bezahlt' ? 'schon_bezahlt' : 'nicht_angenommen' };
  if (!(a.anzahlung > 0)) return { code: 409, fehler: 'keine_anzahlung' };
  const apiKey = process.env.SUMUP_API_KEY;
  const merchantCode = process.env.SUMUP_MERCHANT_CODE;
  if (!apiKey || !merchantCode) return { code: 500, fehler: 'nicht_eingerichtet' };

  const t = jetzt || new Date();
  const b = basis || seite();
  const reference = 'GNC-AN-' + a.id + '-' + t.getTime().toString(36).toUpperCase();
  const payload = {
    checkout_reference: reference,
    amount: a.anzahlung,
    currency: 'EUR',
    merchant_code: merchantCode,
    description: 'Grilln Chill Catering-Anzahlung ' + a.nummer,
    return_url: b + '/.netlify/functions/sumup-webhook',
    redirect_url: kundenLink(a, b) + '&zahlung=zurueck',
    hosted_checkout: { enabled: true },
  };
  const r = await fetch(SUMUP_API_BASE + '/checkouts', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data || !data.id) {
    console.error('angebot sumup:', r.status, JSON.stringify(data || {}).slice(0, 300));
    return { code: 502, fehler: 'kasse' };
  }
  a.zahlung = {
    ...(a.zahlung || {}),
    status: 'PENDING', checkoutId: data.id, reference, betrag: a.anzahlung, angelegtAm: t.toISOString(),
    versuche: ((a.zahlung && a.zahlung.versuche) || []).concat([data.id]).slice(-10),
  };
  a.geaendertAm = t.toISOString();
  await sichern(s, a);
  return { code: 200, url: data.hosted_checkout_url || null, checkoutId: data.id };
}

/** Echten Stand eines Checkouts bei SumUp holen (nie dem Aufrufer glauben). */
async function sumupCheckout(checkoutId) {
  const apiKey = process.env.SUMUP_API_KEY;
  if (!apiKey || !checkoutId) return null;
  try {
    const r = await fetch(SUMUP_API_BASE + '/checkouts/' + encodeURIComponent(checkoutId), {
      headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' },
    });
    const d = await r.json().catch(() => null);
    return r.ok ? d : null;
  } catch (e) { return null; }
}

/**
 * Zahlung verbuchen. `data` ist die bei SumUp abgefragte Checkout-Antwort
 * (aus sumup-webhook.js, der Rückkehr des Kunden oder dem Zeitplan).
 */
async function zahlungVerbuchen(data, quelle, jetzt) {
  const ref = String((data && data.checkout_reference) || '');
  const m = /^GNC-AN-([a-f0-9]{12})-/.exec(ref);
  if (!m) return { ok: true, ignoriert: 'keine_anzahlung' };
  const s = store();
  const a = await laden(s, m[1]);
  if (!a) return { ok: true, ignoriert: 'unbekanntes_angebot' };
  const t = jetzt || new Date();
  const status = String(data.status || '').toUpperCase();

  if (status === 'PAID') {
    const res = await s.setJSON('angebot-zahlung:' + a.id, { at: t.toISOString(), checkoutId: data.id || '', quelle }, { onlyIfNew: true });
    if (res && res.modified === false) {
      // Schon verbucht. Ein zweiter, ebenfalls bezahlter Checkout heißt: doppelt gezahlt.
      const marker = await s.get('angebot-zahlung:' + a.id, { type: 'json' });
      const bekannt = (a.zahlung && a.zahlung.doppelt) || [];
      if (marker && marker.checkoutId && data.id && marker.checkoutId !== data.id && !bekannt.includes(data.id)) {
        a.zahlung = { ...(a.zahlung || {}), doppelt: bekannt.concat([data.id]) };
        await sichern(s, a);
        await telegram('<b>Catering-Anzahlung doppelt bezahlt</b>\n' + tEsc(a.nummer) + ' · ' + tEsc(a.kunde.name)
          + '\nZweite Zahlung ' + tEsc(eur(data.amount)) + ' bitte in SumUp erstatten.', { html: true });
      }
      return { ok: true, ignoriert: 'schon_bezahlt' };
    }
    const vorher = a.status;
    const tx = Array.isArray(data.transactions) && data.transactions[0] ? data.transactions[0] : {};
    a.status = 'bezahlt';
    a.bezahltAm = t.toISOString();
    if (!a.angenommenAm) a.angenommenAm = t.toISOString();
    a.zahlung = {
      ...(a.zahlung || {}),
      status: 'PAID', weg: 'online', checkoutId: data.id || (a.zahlung && a.zahlung.checkoutId) || '',
      betrag: Number(data.amount) || a.anzahlung, transaktion: tx.transaction_code || '', bezahltAm: t.toISOString(), quelle,
    };
    a.geaendertAm = t.toISOString();
    vermerk(a, 'Anzahlung online bezahlt (' + quelle + ')', 'SumUp', t);
    await sichern(s, a);
    const e = await einstellungenLesen(s);
    await Promise.all([
      telegram(telegramZahlung(a, vorher), { html: true }),
      (async () => {
        try { const mm = mailZahlung(a, e, kundenLink(a)); await brevo({ an: a.kunde.email, name: a.kunde.name, betreff: mm.betreff, html: mm.html }); }
        catch (err) { console.error('angebot zahlungs-mail:', err.message); }
      })(),
    ]);
    return { ok: true, aktion: 'bezahlt', nummer: a.nummer };
  }

  if ((status === 'FAILED' || status === 'EXPIRED') && a.zahlung && a.zahlung.checkoutId === data.id && a.zahlung.status === 'PENDING') {
    a.zahlung = { ...a.zahlung, status };
    await sichern(s, a);
    return { ok: true, aktion: 'zahlung_' + status.toLowerCase() };
  }
  return { ok: true, status };
}

/** Rückkehr des Kunden: offenen Checkout bei SumUp nachsehen. */
async function zahlungPruefen(a, quelle) {
  if (!a || !a.zahlung || a.zahlung.status !== 'PENDING' || !a.zahlung.checkoutId) return null;
  const d = await sumupCheckout(a.zahlung.checkoutId);
  if (!d) return null;
  return zahlungVerbuchen(d, quelle || 'rueckkehr');
}

/* ---- Täglicher Lauf: Erinnerung, Ablauf, Zahlungen, Aufräumen ------------- */
const ERINNERN_NACH_TAGEN = 3;
const AUFBEWAHREN_TAGE = 365;

async function taeglicherLauf(jetzt, basis) {
  const t = jetzt || new Date();
  const s = store();
  const e = await einstellungenLesen(s);
  const bericht = { geprueft: 0, erinnert: [], abgelaufen: [], bezahlt: [], geloescht: 0, fehler: 0 };
  const { blobs } = await s.list({ prefix: 'angebot:' });
  for (const b of blobs) {
    let a;
    try { a = await s.get(b.key, { type: 'json' }); } catch (err) { bericht.fehler++; continue; }
    if (!a || !a.id) continue;
    bericht.geprueft++;
    try {
      if (a.status === 'gesendet' && istAbgelaufen(a, t)) {
        a.status = 'abgelaufen';
        a.abgelaufenAm = t.toISOString();
        a.geaendertAm = t.toISOString();
        vermerk(a, 'abgelaufen', 'Zeitplan', t);
        await sichern(s, a);
        bericht.abgelaufen.push(a);
        continue;
      }
      if (a.status === 'gesendet' && !a.erinnertAm && tageSeit(a.gesendetAm, t) >= ERINNERN_NACH_TAGEN) {
        const res = await s.setJSON('angebot-erinnerung:' + a.id, { at: t.toISOString() }, { onlyIfNew: true });
        if (!(res && res.modified === false)) {
          try {
            const m = mailErinnerung(a, e, kundenLink(a, basis));
            await brevo({ an: a.kunde.email, name: a.kunde.name, betreff: m.betreff, html: m.html });
            a.erinnertAm = t.toISOString();
            vermerk(a, 'Erinnerung gesendet', 'Zeitplan', t);
            await sichern(s, a);
            bericht.erinnert.push(a);
          } catch (err) {
            // Nicht raus: Marker wieder weg, morgen neuer Versuch
            console.error('angebot erinnerung:', err.message);
            try { await s.delete('angebot-erinnerung:' + a.id); } catch (x) {}
            bericht.fehler++;
          }
        }
      }
      if (a.zahlung && a.zahlung.status === 'PENDING' && a.zahlung.checkoutId
          && t - new Date(a.zahlung.angelegtAm || 0) > 10 * 60 * 1000) {
        const r = await zahlungPruefen(a, 'zeitplan');
        if (r && r.aktion === 'bezahlt') bericht.bezahlt.push(a);
      }
      if (['entwurf', 'abgelehnt', 'abgelaufen'].includes(a.status) && tageSeit(a.geaendertAm || a.erstelltAm, t) > AUFBEWAHREN_TAGE) {
        await s.delete('angebot:' + a.id);
        for (const k of ['angebot-annahme:', 'angebot-zahlung:', 'angebot-erinnerung:']) { try { await s.delete(k + a.id); } catch (x) {} }
        bericht.geloescht++;
      }
    } catch (err) {
      console.error('angebot taeglich ' + a.id + ':', err.message);
      bericht.fehler++;
    }
  }
  if (bericht.erinnert.length || bericht.abgelaufen.length) {
    const z = ['<b>Catering-Angebote</b>'];
    bericht.erinnert.forEach((a) => z.push('Erinnerung an ' + tEsc(a.kunde.name) + ' (' + tEsc(a.nummer) + ', ' + tEsc(eur(a.gesamt)) + ')'));
    bericht.abgelaufen.forEach((a) => z.push('Abgelaufen: ' + tEsc(a.nummer) + ' · ' + tEsc(a.kunde.name)));
    await telegram(z.join('\n'), { html: true });
  }
  return {
    geprueft: bericht.geprueft, geloescht: bericht.geloescht, fehler: bericht.fehler,
    erinnert: bericht.erinnert.map((a) => a.nummer),
    abgelaufen: bericht.abgelaufen.map((a) => a.nummer),
    bezahlt: bericht.bezahlt.map((a) => a.nummer),
  };
}

/* ---- Listen und Ansichten ------------------------------------------------- */
async function alle(jetzt) {
  const s = store();
  const { blobs } = await s.list({ prefix: 'angebot:' });
  const out = [];
  for (const b of blobs) {
    const a = await s.get(b.key, { type: 'json' });
    if (a && a.id) out.push(a);
  }
  out.sort((x, y) => String(y.erstelltAm).localeCompare(String(x.erstelltAm)));
  return out.map((a) => kurz(a, jetzt));
}
function kurz(a, jetzt) {
  return {
    id: a.id, nummer: a.nummer, status: wirksamerStatus(a, jetzt), anfrage: a.anfrage || null,
    kunde: { name: a.kunde && a.kunde.name || '', email: a.kunde && a.kunde.email || '' },
    event: { datum: a.event && a.event.datum || '', personen: a.event && a.event.personen || 0, ort: a.event && a.event.ort || '' },
    gesamt: a.gesamt || 0, anzahlung: a.anzahlung || 0, gueltigBis: a.gueltigBis || '',
    erstelltAm: a.erstelltAm, gesendetAm: a.gesendetAm || null, erinnertAm: a.erinnertAm || null,
    angenommenAm: a.angenommenAm || null, bezahltAm: a.bezahltAm || null,
    vorgaenger: a.vorgaenger || null, ersetztDurch: a.ersetztDurch || null,
  };
}
function summen(liste) {
  const offen = liste.filter((a) => a.status === 'gesendet');
  const angenommen = liste.filter((a) => a.status === 'angenommen');
  const sum = (l, f) => euro(l.reduce((n, a) => n + cent(a[f]), 0));
  return {
    offen: { anzahl: offen.length, summe: sum(offen, 'gesamt') },
    angenommen: { anzahl: angenommen.length, summe: sum(angenommen, 'gesamt'), anzahlung: sum(angenommen, 'anzahlung') },
  };
}
/** Für das Admin-Tool: alles außer dem Token, dazu der fertige Kundenlink. */
function adminAnsicht(a, jetzt) {
  const { token, ...rest } = a;
  return { ...rest, status: wirksamerStatus(a, jetzt), link: a.status === 'entwurf' ? null : kundenLink(a) };
}
/** Für die Kundenseite: nur was der Kunde sehen muss. Keine Mail, kein Telefon, kein Verlauf. */
function kundenAnsicht(a, e, jetzt) {
  const st = wirksamerStatus(a, jetzt);
  const p = a.event && a.event.paket && e.pakete[a.event.paket];
  return {
    id: a.id,
    nummer: a.nummer,
    status: st,
    vorname: String(a.kunde && a.kunde.name || '').split(/\s+/)[0] || '',
    firma: a.kunde && a.kunde.firma || '',
    event: {
      datum: a.event && a.event.datum || '', zeit: a.event && a.event.zeit || '', ort: a.event && a.event.ort || '',
      personen: a.event && a.event.personen || 0, paket: a.event && a.event.paket || '', paketName: p ? p.name : '',
    },
    zeilen: (a.zeilen || []).filter((z) => Number(z.menge) > 0).map((z) => ({
      art: z.art, paket: z.paket || '', text: z.text, standard: !!z.standard, menge: z.menge, einzel: z.einzel, betrag: z.betrag,
    })),
    summe: a.summe, rabatt: { art: a.rabatt && a.rabatt.art || 'keiner', wert: a.rabatt && a.rabatt.wert || 0, betrag: a.rabattBetrag || 0 },
    gesamt: a.gesamt, anzahlungProzent: a.anzahlungProzent, anzahlung: a.anzahlung, rest: a.rest,
    gueltigBis: a.gueltigBis || '', hinweis: a.hinweis || '',
    angenommenAm: a.angenommenAm || null, bezahltAm: a.bezahltAm || null,
    ersetzt: !!a.ersetztDurch,
    anzahlungOnline: !!e.anzahlungOnline && st === 'angenommen' && a.anzahlung > 0,
    zahlungLaeuft: !!(a.zahlung && a.zahlung.status === 'PENDING'),
    werte: { inklKm: e.inklKm, inklStunden: e.inklStunden, stundenPreis: e.stundenPreis },
  };
}

/* ---- Bedingungen (Deutsch, fürs PDF) -------------------------------------- */
function bedingungen(a, e) {
  const l = [];
  l.push(istTag(a.gueltigBis)
    ? 'Das Angebot gilt bis ' + deDatum(a.gueltigBis) + '. Mit der Annahme buchst du verbindlich.'
    : 'Das Angebot gilt ' + (a.gueltigTage || e.gueltigTage) + ' Tage ab Versand. Mit der Annahme buchst du verbindlich.');
  l.push(a.anzahlung > 0
    ? 'Nach der Annahme ist eine Anzahlung von ' + a.anzahlungProzent + ' % (' + eur(a.anzahlung) + ') fällig. Den Rest zahlst du nach dem Event.'
    : 'Den Gesamtbetrag zahlst du nach dem Event.');
  l.push('Getränke stellst du als Gastgeber. Wir brauchen einen Stellplatz und eine Steckdose.');
  l.push('Bis zu ' + dez(e.inklStunden) + ' Stunden Ausgabe sind enthalten. Jede weitere Stunde kostet ' + eur(e.stundenPreis) + '.');
  l.push('Es gelten unsere AGB: grillnchill-foodtruck.de/#agb');
  return l;
}

/* ---- Mails (über Brevo, wie send-email.js) -------------------------------- */
async function brevo({ an, name, betreff, html, anhaenge }) {
  const apiKey = process.env.BREVO_API_KEY || '';
  const absender = process.env.BREVO_SENDER_EMAIL || '';
  if (!apiKey || !absender) throw new Error('mail_nicht_eingerichtet');
  const antwortAn = process.env.OWNER_EMAIL || '';
  const r = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: { accept: 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: { email: absender, name: process.env.BREVO_SENDER_NAME || 'Grilln Chill' },
      to: [{ email: an, name: name || '' }],
      ...(antwortAn ? { replyTo: { email: antwortAn, name: "Grill'n Chill" } } : {}),
      subject: betreff,
      htmlContent: html,
      ...(anhaenge && anhaenge.length ? { attachment: anhaenge } : {}),
    }),
  });
  const d = await r.json().catch(() => null);
  if (!r.ok) throw new Error('Brevo ' + r.status + ': ' + ((d && (d.message || d.code)) || 'unbekannt'));
  return d;
}

const h = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const vorname = (a) => String(a.kunde && a.kunde.name || '').split(/\s+/)[0] || '';
const TEL = '+49 151 18 54 06 04';
const TEL_LINK = 'tel:+4915118540604';

function rahmen(titel, inhalt) {
  return '<!DOCTYPE html><html lang="de"><body style="margin:0;padding:0;background:#F5E9D0;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;">'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5E9D0;padding:30px 10px;"><tr><td align="center">'
    + '<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:14px;overflow:hidden;">'
    + '<tr><td style="background:#0C0B09;padding:28px 30px;text-align:center;">'
    + '<div style="color:#F5E9D0;font-size:24px;font-weight:800;letter-spacing:1px;">GRILL\'N CHILL</div>'
    + '<div style="color:#E85A24;margin-top:6px;font-size:12px;letter-spacing:2px;font-weight:700;">' + h(titel) + '</div>'
    + '</td></tr><tr><td style="padding:30px;color:#333;line-height:1.6;font-size:15px;">' + inhalt + '</td></tr>'
    + '<tr><td style="background:#F8F5EE;padding:18px 30px;text-align:center;color:#777;font-size:12px;line-height:1.6;">'
    + 'Grill\'n Chill Yildiz und Öztas GbR · Gütersloher Straße 122 · 33649 Bielefeld<br>'
    + '<a href="' + TEL_LINK + '" style="color:#CC4715;text-decoration:none;">' + TEL + '</a> · '
    + '<a href="https://grillnchill-foodtruck.de" style="color:#CC4715;text-decoration:none;">grillnchill-foodtruck.de</a>'
    + '</td></tr></table></td></tr></table></body></html>';
}
function knopf(link, beschriftung) {
  return '<p style="margin:26px 0;text-align:center;"><a href="' + h(link) + '" style="display:inline-block;background:#CC4715;color:#fff;padding:15px 28px;border-radius:10px;text-decoration:none;font-weight:700;font-size:16px;">' + h(beschriftung) + '</a></p>';
}
function tabelle(zeilen) {
  return '<table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border:1px solid #eee;border-radius:8px;overflow:hidden;">'
    + zeilen.map(([l, w, fett], i) => '<tr><td style="padding:10px 14px;color:#777;' + (i < zeilen.length - 1 ? 'border-bottom:1px solid #eee;' : '') + '">' + h(l) + '</td>'
      + '<td style="padding:10px 14px;text-align:right;color:#222;font-weight:' + (fett ? '800' : '600') + ';' + (i < zeilen.length - 1 ? 'border-bottom:1px solid #eee;' : '') + '">' + h(w) + '</td></tr>').join('')
    + '</table>';
}
function eckdaten(a) {
  const z = [];
  if (a.event && a.event.datum) z.push(['Datum', deDatumLang(a.event.datum) + (a.event.zeit ? ', ' + a.event.zeit : '')]);
  if (a.event && a.event.ort) z.push(['Ort', a.event.ort]);
  if (a.event && a.event.personen) z.push(['Personen', String(a.event.personen)]);
  z.push(['Gesamt inkl. MwSt.', eur(a.gesamt), true]);
  if (a.anzahlung > 0) z.push(['Anzahlung ' + a.anzahlungProzent + ' %', eur(a.anzahlung)]);
  return z;
}

function mailAngebot(a, e, link) {
  const inhalt = '<p style="margin:0 0 14px;font-size:18px;font-weight:700;color:#111;">Hallo ' + h(vorname(a)) + ',</p>'
    + '<p style="margin:0 0 6px;">danke für deine Anfrage. Hier ist dein Angebot ' + h(a.nummer) + '.</p>'
    + tabelle(eckdaten(a).concat([['Gültig bis', deDatum(a.gueltigBis)]]))
    + '<p style="margin:0;">Alle Positionen stehen im PDF im Anhang. Passt alles, nimmst du das Angebot mit einem Klick an.</p>'
    + knopf(link, 'Angebot ansehen und annehmen')
    + '<p style="margin:0 0 6px;">Fragen oder Änderungswünsche? Antworte auf diese Mail oder ruf an: <a href="' + TEL_LINK + '" style="color:#CC4715;font-weight:600;text-decoration:none;">' + TEL + '</a>.</p>'
    + '<p style="margin:18px 0 0;">Viele Grüße<br><strong>Kubi und das Grill\'n Chill Team</strong></p>';
  return { betreff: 'Dein Catering-Angebot ' + a.nummer + ' von Grill\'n Chill', html: rahmen('CATERING-ANGEBOT', inhalt) };
}
function mailErinnerung(a, e, link) {
  const inhalt = '<p style="margin:0 0 14px;font-size:18px;font-weight:700;color:#111;">Hallo ' + h(vorname(a)) + ',</p>'
    + '<p style="margin:0 0 6px;">vor ein paar Tagen haben wir dir unser Angebot ' + h(a.nummer) + ' geschickt. Es gilt noch bis ' + h(deDatum(a.gueltigBis)) + '.</p>'
    + tabelle(eckdaten(a))
    + '<p style="margin:0;">Wenn es passt, nimmst du es hier mit einem Klick an. Wenn du etwas ändern willst, antworte einfach auf diese Mail.</p>'
    + knopf(link, 'Angebot ansehen und annehmen')
    + '<p style="margin:18px 0 0;">Viele Grüße<br><strong>Kubi und das Grill\'n Chill Team</strong></p>';
  return { betreff: 'Kurze Erinnerung: dein Catering-Angebot ' + a.nummer, html: rahmen('CATERING-ANGEBOT', inhalt) };
}
function mailAnnahme(a, e, link) {
  const online = e.anzahlungOnline && a.anzahlung > 0;
  const anz = a.anzahlung > 0
    ? (online
      ? '<p style="margin:0;">Mit der Anzahlung von ' + h(eur(a.anzahlung)) + ' ist dein Termin fest reserviert. Du kannst sie hier online zahlen:</p>' + knopf(link, 'Anzahlung zahlen')
      : '<p style="margin:0 0 6px;">Wegen der Anzahlung von ' + h(eur(a.anzahlung)) + ' melden wir uns bei dir.</p>')
    : '';
  const inhalt = '<p style="margin:0 0 14px;font-size:18px;font-weight:700;color:#111;">Danke, ' + h(vorname(a)) + '.</p>'
    + '<p style="margin:0 0 6px;">Wir haben deine Zusage für Angebot ' + h(a.nummer) + ' bekommen.</p>'
    + tabelle(eckdaten(a))
    + anz
    + '<p style="margin:14px 0 6px;">Vor dem Event klären wir mit dir Stellplatz, Strom und wie viele Gäste vegetarisch oder vegan essen.</p>'
    + '<p style="margin:0;">Dein Angebot findest du jederzeit hier: <a href="' + h(link) + '" style="color:#CC4715;font-weight:600;text-decoration:none;">Angebot ansehen</a></p>'
    + '<p style="margin:18px 0 0;">Wir freuen uns auf dein Event.<br><strong>Kubi und das Grill\'n Chill Team</strong></p>';
  return { betreff: 'Danke für deine Zusage: Catering ' + (a.event && a.event.datum ? 'am ' + deDatum(a.event.datum) : a.nummer), html: rahmen('ZUSAGE ERHALTEN', inhalt) };
}
function mailZahlung(a, e, link) {
  const inhalt = '<p style="margin:0 0 14px;font-size:18px;font-weight:700;color:#111;">Danke, ' + h(vorname(a)) + '.</p>'
    + '<p style="margin:0 0 6px;">Deine Anzahlung von ' + h(eur(a.zahlung && a.zahlung.betrag || a.anzahlung)) + ' für Angebot ' + h(a.nummer) + ' ist da. Dein Termin ist fest reserviert.</p>'
    + tabelle(eckdaten(a).concat([['Rest nach dem Event', eur(a.rest)]]))
    + '<p style="margin:0;">Dein Angebot: <a href="' + h(link) + '" style="color:#CC4715;font-weight:600;text-decoration:none;">Angebot ansehen</a></p>'
    + '<p style="margin:18px 0 0;">Bis bald<br><strong>Kubi und das Grill\'n Chill Team</strong></p>';
  return { betreff: 'Anzahlung erhalten: Catering ' + (a.event && a.event.datum ? 'am ' + deDatum(a.event.datum) : a.nummer), html: rahmen('ANZAHLUNG ERHALTEN', inhalt) };
}

/* ---- Telegram ------------------------------------------------------------- */
function telegramKopf(a) {
  const z = [tEsc(a.nummer) + ' · ' + tEsc(a.kunde && a.kunde.name)];
  const ev = [];
  if (a.event && a.event.datum) ev.push(deDatumLang(a.event.datum));
  if (a.event && a.event.ort) ev.push(tEsc(a.event.ort));
  if (a.event && a.event.personen) ev.push(a.event.personen + ' Personen');
  if (ev.length) z.push(ev.join(' · '));
  return z;
}
function telegramAnnahme(a, e) {
  const z = ['<b>Catering-Angebot angenommen</b>'].concat(telegramKopf(a));
  z.push('Gesamt ' + tEsc(eur(a.gesamt)) + (a.anzahlung > 0 ? ' · Anzahlung ' + tEsc(eur(a.anzahlung)) : ''));
  if (a.anzahlung > 0) z.push(e.anzahlungOnline ? 'Der Kunde kann die Anzahlung jetzt online zahlen.' : 'Anzahlung online ist aus: bitte wie gewohnt einfordern.');
  if (a.kunde && a.kunde.telefon) z.push('Tel: ' + tEsc(a.kunde.telefon));
  return z.join('\n');
}
function telegramZahlung(a, vorher) {
  const z = ['<b>Catering-Anzahlung bezahlt</b>'].concat(telegramKopf(a));
  z.push('Anzahlung ' + tEsc(eur(a.zahlung && a.zahlung.betrag || a.anzahlung)) + ' online über SumUp');
  if (vorher && vorher !== 'angenommen') z.push('Hinweis: Status vorher ' + tEsc(STATUS_NAME[vorher] || vorher) + '. Bitte prüfen.');
  return z.join('\n');
}

/* ---- Fehler --------------------------------------------------------------- */
function fehler(code, status) { const e = new Error(code); e.code = code; e.status = status || 400; return e; }

module.exports = {
  store, STATUS, STATUS_NAME, STANDARD, PAKETE, ID_FORM, TOKEN_FORM,
  einstellungenLesen, einstellungenSpeichern, einstellungenMischen,
  heute, plusTage, tageSeit, deDatum, deDatumLang, eur, dez,
  standardText, rechnen, entwurfBereinigen, entwurfAusAnfrage, pauschaleFuer,
  naechsteNummer, tokenStimmt, kundenLink, laden, wirksamerStatus, istAbgelaufen,
  anlegen, speichern, loeschen, duplizieren, senden, annehmen, statusSetzen,
  zahlungStarten, zahlungVerbuchen, zahlungPruefen, sumupCheckout, taeglicherLauf,
  alle, kurz, summen, adminAnsicht, kundenAnsicht, bedingungen,
  mailAngebot, mailErinnerung, mailAnnahme, mailZahlung,
};
