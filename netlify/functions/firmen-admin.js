/**
 * firmen-admin.js
 * ----------------------------------------------------------------------------
 * Verwaltung des Firmen-Mittags (Seite /firmen-admin). Nur Admin und
 * Inhaber: hier stehen Anschriften, Umsätze und Rechnungen.
 *
 *   POST { password, action, ... }   password = Sitzungs-Token aus dem Admin
 *
 *   'uebersicht'                         → { antraege, firmen }
 *   'antrag_annehmen'  { id, limit?, zahlungsziel?, domains? }  → { firma }
 *   'antrag_ablehnen'  { id }
 *   'firma_speichern'  { id, firma: { … } }                     → { firma }
 *   'code_neu'         { id }                                   → { firma }
 *   'bestellungen'     { id }   laufender und letzter Monat, Rechnungen
 *   'abgleich'         { id }   Firmenbestellungen aus dem Archiv nachtragen
 *   'rechnung_erstellen' { id, monat }   Sammelrechnung (nur abgeschlossene Monate)
 *   'rechnung_senden'    { id, monat }   Mail mit PDF und XRechnung, nur auf Klick
 *   'rechnung_status'    { id, monat, status: 'erstellt'|'versendet'|'bezahlt' }
 *
 * Die Sammelrechnung nutzt lib/invoice.js (PDF und XRechnung) und denselben
 * Nummernkreis wie die Einzelrechnungen (lib/rechnungsnummer.js). Sie liegt
 * wie jede Rechnung als inv:<Nummer> im Store "invoices" und erscheint damit
 * auch in der Rechnungsliste und im ZIP-Export des Admin-Tools.
 * ----------------------------------------------------------------------------
 */

const { getStore } = require('@netlify/blobs');
const { pruefeSperre, meldeErgebnis } = require('./lib/auth-guard');
const { passwortAusSitzung } = require('./lib/admin-sitzung');
const { mitglied } = require('./lib/team-passwort');
const { buildInvoicePdf, buildInvoiceXml } = require('./lib/invoice');
const { naechsteRechnungsnummer } = require('./lib/rechnungsnummer');
const F = require('./lib/firmen');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (statusCode, data) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  body: JSON.stringify(data),
});

function store(name) {
  const opts = { name, consistency: 'strong' };
  if (process.env.NETLIFY_BLOBS_SITE_ID && process.env.NETLIFY_BLOBS_TOKEN) {
    opts.siteID = process.env.NETLIFY_BLOBS_SITE_ID;
    opts.token = process.env.NETLIFY_BLOBS_TOKEN;
  }
  return getStore(opts);
}

/* Rolle bestimmen, gleiche Logik wie in invoices-list.js */
async function authRole(pw) {
  if (!pw) return null;
  const admin = process.env.ADMIN_PASSWORD || '';
  if (admin && pw === admin) return { role: 'superadmin', name: 'Kubi' };
  try {
    const t = store('team');
    const { blobs } = await t.list({ prefix: 'u:' });
    const { key, u } = (await mitglied(t, pw, blobs)) || {};
    if (u) return { role: u.role === 'admin' ? 'admin' : 'staff', name: u.name || key.slice(2) };
  } catch (e) {}
  return null;
}

async function auditLog(who, detail) {
  try {
    const key = 'a:' + new Date().toISOString() + '_' + Math.random().toString(36).slice(2, 7);
    await store('audit').setJSON(key, {
      at: new Date().toISOString(), name: (who && who.name) || '?', role: (who && who.role) || '?',
      action: 'Firmen', detail: String(detail || '').slice(0, 300),
    });
  } catch (e) {}
}

/* Schalter: Sammelrechnungen erst nach Freigabe durch den Steuerberater.
   Netlify FIRMEN_SAMMELRECHNUNG=an. Bis dahin laufen Bestellungen auf
   Firmenrechnung normal auf, nur das Erstellen der Rechnung ist gesperrt. */
const sammelrechnungFrei = () => String(process.env.FIRMEN_SAMMELRECHNUNG || '').toLowerCase() === 'an';

const idSauber = (x) => String(x || '').replace(/[^a-z0-9]/g, '').slice(0, 24);
const monatSauber = (x) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(x || '')) ? String(x) : '');
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;

function adresse(a, alt) {
  const x = a && typeof a === 'object' ? a : null;
  if (!x) return alt || null;
  const street = F.clean(x.street, 80);
  const zip = String(x.zip || '').replace(/\D/g, '').slice(0, 5);
  const city = F.clean(x.city, 40);
  if (!street || zip.length !== 5 || !city) return alt || null;
  return { street, zip, city };
}
function euro(x, alt) {
  const n = Number(x);
  return isFinite(n) && n >= 0 ? Math.min(100000, F.r2(n)) : alt;
}
function tage(x, alt) {
  const n = parseInt(x, 10);
  return n >= 0 && n <= 90 ? n : alt;
}

/* Neuen Code vergeben, der noch frei ist, und den Verweis anlegen */
async function codeVergeben(s, firma) {
  for (let i = 0; i < 10; i++) {
    const code = F.neuerCode();
    if (await s.get('code:' + code, { type: 'json' })) continue;
    if (firma.code) { try { await s.delete('code:' + firma.code); } catch (e) {} }
    await s.setJSON('code:' + code, { id: firma.id });
    firma.code = code;
    return code;
  }
  throw new Error('kein freier Code');
}

/* ---- Mail an die Rechnungsadresse (Brevo, wie send-email.js) ---- */
async function rechnungMailen(firma, rechnung, pdf, xml) {
  const apiKey = process.env.BREVO_API_KEY || '';
  const absender = process.env.BREVO_SENDER_EMAIL || '';
  const name = process.env.BREVO_SENDER_NAME || 'Grilln Chill';
  const an = firma.rechnungsEmail || firma.email;
  if (!apiKey || !absender) throw new Error('mail_nicht_eingerichtet');
  if (!an) throw new Error('keine_adresse');
  const e = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const eur = (n) => (Number(n) || 0).toFixed(2).replace('.', ',') + ' €';
  const iban = process.env.RECHNUNG_IBAN || '';
  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#222;line-height:1.6;">
    <p>Hallo ${e(firma.ansprechperson || firma.name)},</p>
    <p>anbei die Sammelrechnung ${e(rechnung.invoiceNo)} für den Firmen-Mittag im ${e(rechnung.leistungsmonat)}:
       ${rechnung.sammel.anzahl} Bestellungen, zusammen <strong>${eur(rechnung.total)}</strong>.</p>
    <p>Bitte überweise den Betrag bis zum ${e(rechnung.faelligAm)}${iban ? ' auf ' + e(iban) : ''}.
       Verwendungszweck: ${e(rechnung.invoiceNo)}.</p>
    <p>Die PDF-Datei ist zum Ablegen, die XML-Datei (XRechnung) für eure Buchhaltung.</p>
    <p>Danke fürs Bestellen.<br>Kubi und das Team von Grill'n Chill</p>
    <p style="color:#888;font-size:12px;">Grill'n Chill Yildiz und Öztas GbR · Gütersloher Straße 122, 33649 Bielefeld · info@grillnchill-foodtruck.de</p>
  </div>`;
  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { accept: 'application/json', 'api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      sender: { email: absender, name },
      to: [{ email: an, name: firma.name || '' }],
      bcc: process.env.OWNER_EMAIL ? [{ email: process.env.OWNER_EMAIL }] : undefined,
      subject: `Rechnung ${rechnung.invoiceNo}: Firmen-Mittag ${rechnung.leistungsmonat}`,
      htmlContent: html,
      attachment: [
        { name: `Rechnung-${rechnung.invoiceNo}.pdf`, content: pdf.toString('base64') },
        { name: `Rechnung-${rechnung.invoiceNo}.xml`, content: Buffer.from(xml, 'utf8').toString('base64') },
      ],
    }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => null);
    throw new Error('Brevo ' + r.status + ': ' + ((d && (d.message || d.code)) || ''));
  }
  return an;
}

async function liste(s, prefix) {
  const { blobs } = await s.list({ prefix });
  const out = [];
  for (const b of blobs) {
    try { const v = await s.get(b.key, { type: 'json' }); if (v) out.push(v); } catch (e) {}
  }
  return out;
}

async function rechnungenDerFirma(s, id) {
  const r = await liste(s, 'rechnung:' + id + ':');
  return r.sort((a, b) => String(b.monat).localeCompare(String(a.monat)));
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'method_not_allowed' });
  if (Buffer.byteLength(event.body || '') > 64 * 1024) return json(413, { error: 'payload_too_large' });

  let input = {};
  try { input = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'invalid_json' }); }

  // Bremse gegen Durchprobieren, siehe lib/auth-guard.js
  const gesperrt = await pruefeSperre(event);
  if (gesperrt) return gesperrt;
  const who = await authRole(await passwortAusSitzung(String(input.password || '')));
  await meldeErgebnis(event, !!who);
  if (!who) return json(401, { error: 'unauthorized' });
  if (who.role !== 'admin' && who.role !== 'superadmin') {
    return json(403, { error: 'forbidden', hint: 'Firmen verwaltet nur ein Admin.' });
  }

  const s = F.store();
  const action = String(input.action || '');

  try {
    /* ---------- Übersicht ---------- */
    if (action === 'uebersicht') {
      const monat = F.monatVon(Date.now());
      const antraege = (await liste(s, 'antrag:'))
        .sort((a, b) => String(b.at).localeCompare(String(a.at)))
        .slice(0, 200);
      const firmen = await liste(s, 'firma:');
      for (const f of firmen) {
        const n = await F.nutzungLesen(f.id, monat);
        f.monatSumme = n.summe;
        f.monatAnzahl = Object.keys(n.eintraege).length;
      }
      firmen.sort((a, b) => String(a.name).localeCompare(String(b.name), 'de'));
      return json(200, {
        ok: true, monat, antraege, firmen,
        iban: !!process.env.RECHNUNG_IBAN,
        sammelrechnung: sammelrechnungFrei(),
        mail: !!(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL),
      });
    }

    /* ---------- Antrag annehmen: Firma mit Code anlegen ---------- */
    if (action === 'antrag_annehmen') {
      const id = idSauber(input.id);
      const a = await s.get('antrag:' + id, { type: 'json' });
      if (!a) return json(404, { error: 'not_found' });
      if (a.status === 'angenommen' && a.firmaId) {
        return json(200, { ok: true, firma: await F.firmaLesen(a.firmaId) });
      }
      const firma = {
        id: a.id,
        name: a.firma, rechnungsname: '',
        ansprechperson: a.ansprechperson, email: a.email, rechnungsEmail: '', telefon: a.telefon,
        lieferadresse: a.lieferadresse, rechnungsadresse: a.rechnungsadresse || a.lieferadresse,
        ustId: a.ustId || '',
        domains: F.domainsLesen(input.domains != null ? input.domains : a.domains),
        limit: euro(input.limit, F.STANDARD.limit),
        zahlungsziel: tage(input.zahlungsziel, F.STANDARD.zahlungsziel),
        aktiv: true,
        gebiet: a.gebiet || null,
        personen: a.personen || null,
        antragId: a.id,
        createdAt: new Date().toISOString(),
        createdBy: who.name,
      };
      await codeVergeben(s, firma);
      await s.setJSON('firma:' + firma.id, firma);
      a.status = 'angenommen';
      a.firmaId = firma.id;
      a.entschiedenAt = new Date().toISOString();
      a.entschiedenVon = who.name;
      await s.setJSON('antrag:' + id, a);
      await auditLog(who, 'Antrag angenommen: ' + firma.name);
      return json(200, { ok: true, firma });
    }

    if (action === 'antrag_ablehnen') {
      const id = idSauber(input.id);
      const a = await s.get('antrag:' + id, { type: 'json' });
      if (!a) return json(404, { error: 'not_found' });
      if (a.status === 'angenommen') return json(409, { error: 'schon_angenommen' });
      a.status = 'abgelehnt';
      a.entschiedenAt = new Date().toISOString();
      a.entschiedenVon = who.name;
      await s.setJSON('antrag:' + id, a);
      await auditLog(who, 'Antrag abgelehnt: ' + a.firma);
      return json(200, { ok: true });
    }

    /* ---------- Firma bearbeiten ---------- */
    if (action === 'firma_speichern') {
      const id = idSauber(input.id);
      const f = await F.firmaLesen(id);
      if (!f) return json(404, { error: 'not_found' });
      const n = input.firma && typeof input.firma === 'object' ? input.firma : {};
      if (n.name != null && F.clean(n.name, 80)) f.name = F.clean(n.name, 80);
      if (n.rechnungsname != null) f.rechnungsname = F.clean(n.rechnungsname, 80);
      if (n.ansprechperson != null) f.ansprechperson = F.clean(n.ansprechperson, 60);
      if (n.email != null && EMAIL.test(String(n.email).trim())) f.email = String(n.email).trim().toLowerCase().slice(0, 120);
      if (n.rechnungsEmail != null) {
        const re = String(n.rechnungsEmail).trim().toLowerCase().slice(0, 120);
        f.rechnungsEmail = EMAIL.test(re) ? re : '';
      }
      if (n.telefon != null) f.telefon = F.clean(n.telefon, 30);
      f.lieferadresse = adresse(n.lieferadresse, f.lieferadresse);
      f.rechnungsadresse = adresse(n.rechnungsadresse, f.rechnungsadresse);
      if (n.ustId != null) {
        const u = String(n.ustId).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 14);
        f.ustId = /^[A-Z]{2}[A-Z0-9]{2,12}$/.test(u) ? u : '';
      }
      if (n.domains != null) f.domains = F.domainsLesen(n.domains);
      f.limit = euro(n.limit, f.limit);
      f.zahlungsziel = tage(n.zahlungsziel, f.zahlungsziel);
      if (typeof n.aktiv === 'boolean') f.aktiv = n.aktiv;
      f.updatedAt = new Date().toISOString();
      f.updatedBy = who.name;
      await s.setJSON('firma:' + f.id, f);
      await auditLog(who, 'Firma gespeichert: ' + f.name + (f.aktiv ? '' : ' (inaktiv)'));
      return json(200, { ok: true, firma: f });
    }

    if (action === 'code_neu') {
      const f = await F.firmaLesen(idSauber(input.id));
      if (!f) return json(404, { error: 'not_found' });
      await codeVergeben(s, f);
      f.updatedAt = new Date().toISOString();
      await s.setJSON('firma:' + f.id, f);
      await auditLog(who, 'Neuer Firmencode für ' + f.name);
      return json(200, { ok: true, firma: f });
    }

    /* ---------- Bestellungen: laufender und letzter Monat ---------- */
    if (action === 'bestellungen') {
      const f = await F.firmaLesen(idSauber(input.id));
      if (!f) return json(404, { error: 'not_found' });
      const jetzt = F.monatVon(Date.now());
      const monate = [jetzt, F.vormonat(jetzt)];
      const aus = [];
      for (const m of monate) {
        const l = await F.monatsBestellungen(f.id, m);
        const summe = F.r2(l.filter((e) => e.zaehlt).reduce((a, e) => a + (Number(e.total) || 0), 0));
        aus.push({
          monat: m, name: F.monatName(m), summe, anzahl: l.filter((e) => e.zaehlt).length,
          bestellungen: l.map((e) => ({ ref: e.ref, at: e.at, name: e.name, email: e.email, total: e.total, status: e.status, zaehlt: e.zaehlt, mode: e.mode, artikel: (e.items || []).reduce((a, i) => a + (Number(i.qty) || 0), 0) })),
          rechnung: await s.get('rechnung:' + f.id + ':' + m, { type: 'json' }),
          abgeschlossen: m < jetzt,
        });
      }
      return json(200, { ok: true, firma: f, monate: aus, rechnungen: await rechnungenDerFirma(s, f.id) });
    }

    /* ---------- Abgleich: Firmenbestellungen aus dem Archiv nachtragen ----------
       Falls das Vermerken nach einer Bestellung gescheitert ist (Telegram
       meldet das), holt dieser Lauf sie aus dem Bestell-Archiv der letzten
       62 Tage. Doppelt wird nichts: je Bestellung zählt der erste Eintrag. */
    if (action === 'abgleich') {
      const f = await F.firmaLesen(idSauber(input.id));
      if (!f) return json(404, { error: 'not_found' });
      const os = store('orders');
      const ab = Date.now() - 62 * 86400000;
      const { blobs } = await os.list({ prefix: 'o:GNC-' });
      const keys = blobs.map((b) => b.key).filter((k) => {
        const m = /^o:GNC-(\d{12,14})$/.exec(k);
        return !m || Number(m[1]) >= ab;
      });
      let neu = 0;
      for (const k of keys) {
        const rec = await os.get(k, { type: 'json' }).catch(() => null);
        if (!rec || rec.status !== 'completed' || !rec.order || rec.order.firma !== f.id) continue;
        if (await F.bestellungVermerken(rec.order, { at: rec.completedAt || rec.createdAt })) neu++;
      }
      if (neu) await auditLog(who, 'Abgleich ' + f.name + ': ' + neu + ' Bestellungen nachgetragen');
      return json(200, { ok: true, neu });
    }

    /* ---------- Sammelrechnung erstellen ---------- */
    if (action === 'rechnung_erstellen') {
      const f = await F.firmaLesen(idSauber(input.id));
      if (!f) return json(404, { error: 'not_found' });
      const monat = monatSauber(input.monat);
      if (!monat) return json(400, { error: 'monat' });
      if (!sammelrechnungFrei()) {
        return json(409, { error: 'gesperrt', hint: 'Sammelrechnungen sind noch gesperrt, bis der Steuerberater sie freigibt (Netlify: FIRMEN_SAMMELRECHNUNG=an).' });
      }
      if (monat >= F.monatVon(Date.now())) {
        return json(409, { error: 'monat_offen', hint: 'Den laufenden Monat rechnest du nach dem Monatsende ab.' });
      }
      const rk = 'rechnung:' + f.id + ':' + monat;
      const vorhanden = await s.get(rk, { type: 'json' });
      if (vorhanden && vorhanden.invoiceNo) return json(200, { ok: true, rechnung: vorhanden, schon: true });
      // Hängengebliebene Sperre (Lauf abgebrochen): nach 5 Minuten freigeben
      if (vorhanden && !vorhanden.invoiceNo && Date.now() - Date.parse(vorhanden.at || 0) > 5 * 60000) {
        try { await s.delete(rk); } catch (e) {}
      }
      const adr = f.rechnungsadresse || f.lieferadresse;
      if (!adr || !adr.street) return json(409, { error: 'adresse', hint: 'Rechnungsadresse fehlt.' });

      const eintraege = await F.monatsBestellungen(f.id, monat);
      const zaehlen = eintraege.filter((e) => e.zaehlt);
      if (!zaehlen.length) return json(409, { error: 'leer', hint: 'In diesem Monat gibt es keine abrechenbaren Bestellungen.' });

      // Sperre gegen Doppelklick: nur ein Lauf legt die Rechnung an
      const sperre = await s.setJSON(rk, { monat, status: 'in_arbeit', at: new Date().toISOString() }, { onlyIfNew: true });
      if (sperre && sperre.modified === false) return json(409, { error: 'laeuft', hint: 'Die Rechnung wird gerade erstellt.' });

      let rechnung;
      try {
        const nummer = await naechsteRechnungsnummer(store('invoices'));
        rechnung = F.sammelrechnungBauen(f, monat, eintraege, { invoiceNo: nummer });
        // Probe: PDF muss sich bauen lassen, bevor die Nummer endgültig belegt wird
        await buildInvoicePdf(rechnung);
        await store('invoices').setJSON('inv:' + nummer, rechnung);
      } catch (e) {
        try { await s.delete(rk); } catch (x) {}
        throw e;
      }
      const meta = {
        monat, firmaId: f.id, invoiceNo: rechnung.invoiceNo, status: 'erstellt',
        total: rechnung.total, anzahl: rechnung.sammel.anzahl,
        invoiceDate: rechnung.invoiceDate, faelligAm: rechnung.faelligAm,
        erstelltAm: new Date().toISOString(), erstelltVon: who.name,
      };
      await s.setJSON(rk, meta);
      await auditLog(who, 'Sammelrechnung ' + rechnung.invoiceNo + ' für ' + f.name + ' (' + monat + ', ' + rechnung.total.toFixed(2) + ' €)');
      return json(200, { ok: true, rechnung: meta });
    }

    /* ---------- Sammelrechnung per Mail senden (nur auf Klick) ---------- */
    if (action === 'rechnung_senden') {
      const f = await F.firmaLesen(idSauber(input.id));
      if (!f) return json(404, { error: 'not_found' });
      const monat = monatSauber(input.monat);
      const rk = 'rechnung:' + f.id + ':' + monat;
      const meta = monat && await s.get(rk, { type: 'json' });
      if (!meta || !meta.invoiceNo) return json(404, { error: 'keine_rechnung' });
      const rec = await store('invoices').get('inv:' + meta.invoiceNo, { type: 'json' });
      if (!rec || rec.platzhalter) return json(404, { error: 'keine_rechnung' });
      let an;
      try {
        const pdf = await buildInvoicePdf(rec);
        an = await rechnungMailen(f, rec, pdf, buildInvoiceXml(rec));
      } catch (e) {
        console.error('firmen-admin senden:', e.message);
        const grund = /mail_nicht_eingerichtet|keine_adresse/.test(e.message) ? e.message : 'mail';
        return json(502, { error: grund, hint: grund === 'keine_adresse' ? 'Keine E-Mail-Adresse hinterlegt.' : 'Die Mail ging nicht raus. Bitte später erneut versuchen.' });
      }
      meta.status = meta.status === 'bezahlt' ? 'bezahlt' : 'versendet';
      meta.versendetAm = new Date().toISOString();
      meta.versendetAn = an;
      meta.versendetVon = who.name;
      await s.setJSON(rk, meta);
      await auditLog(who, 'Sammelrechnung ' + meta.invoiceNo + ' an ' + an + ' gesendet');
      return json(200, { ok: true, rechnung: meta });
    }

    if (action === 'rechnung_status') {
      const f = await F.firmaLesen(idSauber(input.id));
      if (!f) return json(404, { error: 'not_found' });
      const monat = monatSauber(input.monat);
      const status = String(input.status || '');
      if (!['erstellt', 'versendet', 'bezahlt'].includes(status)) return json(400, { error: 'status' });
      const rk = 'rechnung:' + f.id + ':' + monat;
      const meta = monat && await s.get(rk, { type: 'json' });
      if (!meta || !meta.invoiceNo) return json(404, { error: 'keine_rechnung' });
      meta.status = status;
      if (status === 'bezahlt') meta.bezahltAm = new Date().toISOString();
      else delete meta.bezahltAm;
      meta.statusVon = who.name;
      await s.setJSON(rk, meta);
      await auditLog(who, 'Sammelrechnung ' + meta.invoiceNo + ': ' + status);
      return json(200, { ok: true, rechnung: meta });
    }

    return json(400, { error: 'unknown_action' });
  } catch (e) {
    console.error('firmen-admin:', e && e.message);
    return json(500, { error: 'server' });
  }
};
