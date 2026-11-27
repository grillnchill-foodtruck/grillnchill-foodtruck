'use strict';
/**
 * lib/zeit-dienst.js
 * Personen und Schichten aus dem Dienstplan (Blob-Store dienstplan, siehe dienstplan.js) für die Zeiterfassung:
 *   personal     [{ id, name, farbe, login? }]   login = Team-Zugang (Schlüssel u:<login> im Store team)
 *   w:<montag>   { schichten: { 'JJJJ-MM-TT': [{ pid, von, bis, notiz }] } }
 */
const { getStore } = require('@netlify/blobs');

function store() {
  const opts = { name: 'dienstplan', consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

const fmtTag = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' });
const berlinTag = (ms) => fmtTag.format(new Date(ms));
const plusTage = (tag, n) => new Date(Date.parse(tag + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const montagVon = (tag) => plusTage(tag, -((new Date(tag + 'T12:00:00Z').getUTCDay() + 6) % 7));
const istMontag = (tag) => /^\d{4}-\d{2}-\d{2}$/.test(String(tag || '')) && new Date(tag + 'T12:00:00Z').getUTCDay() === 1;

// Uhrzeit wie im Office (HH:MM, 00:00 bis 23:59). Ungültige Plan-Einträge werden ignoriert.
const ZEIT = /^([01]\d|2[0-3]):[0-5]\d$/;

// Geplante Schicht einer Person an einem Tag. Zwei Schichten am selben Tag werden zu einer (früheste bis späteste).
function schichtAm(plan, tag, pid) {
  const liste = ((plan && plan.schichten && plan.schichten[tag]) || []).filter((s) => s && s.pid === pid && ZEIT.test(s.von) && ZEIT.test(s.bis));
  if (!liste.length) return null;
  return { von: liste.map((s) => s.von).sort()[0], bis: liste.map((s) => s.bis).sort().pop() };
}

// Für die Namensliste am iPad: erst alle mit Schicht heute (nach Beginn), dann die übrigen nach Namen
function personenListe(personal, plan, heute) {
  const liste = personal.map((p) => ({ id: p.id, name: p.name, farbe: p.farbe, schicht: schichtAm(plan, heute, p.id) }));
  const name = (a, b) => a.name.localeCompare(b.name, 'de');
  return [...liste.filter((p) => p.schicht).sort((a, b) => a.schicht.von.localeCompare(b.schicht.von) || name(a, b)),
    ...liste.filter((p) => !p.schicht).sort(name)];
}

// Herkunft "t-<login>" im Format der Office-Regel (nur a-z 0-9 ä ö ü ß und Bindestrich, höchstens 30 Zeichen).
// Deterministisch: dieselbe Sitzung bildet bei jeder Wiederholung denselben Wert, sonst kommt 409 schluessel_anders.
function vonLogin(login) {
  const l = String(login || '').toLowerCase().replace(/[^a-z0-9äöüß-]+/g, '-').slice(0, 30);
  return 't-' + (l || 'team');
}

async function lesePersonal() {
  const p = await store().get('personal', { type: 'json' });
  return Array.isArray(p) ? p.filter((x) => x && typeof x.id === 'string' && x.name) : [];
}
async function lesePlan(montag) {
  return (await store().get('w:' + montag, { type: 'json' })) || { schichten: {} };
}

module.exports = { berlinTag, plusTage, montagVon, istMontag, schichtAm, personenListe, lesePersonal, lesePlan, vonLogin };
