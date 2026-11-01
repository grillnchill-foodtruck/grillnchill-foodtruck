/**
 * burger-pass-erinnerung.js  (Zeitplan, täglich, siehe netlify.toml)
 * ----------------------------------------------------------------------------
 * Geht alle aktiven Burger-Pässe durch (Store 'paesse'):
 *   - abgelaufen      → Status 'abgelaufen', übrige Menüs verfallen, Topf im
 *                       Kundendatensatz wird entfernt
 *   - leer            → Status 'verbraucht'
 *   - 7 Tage vor Ablauf, noch Menüs übrig → Erinnerungsmail (einmal)
 *   - nur noch 1 Menü → Erinnerungsmail (einmal), mit Link zum Neukauf,
 *                       solange der Verkauf eingeschaltet ist
 * Maßgeblich für „übrig“ ist der Kundendatensatz (passMenus), siehe
 * lib/burger-pass.js. Eine Mail gilt erst als verschickt, wenn Brevo sie
 * angenommen hat; sonst versucht es der nächste Lauf erneut.
 * ----------------------------------------------------------------------------
 */

const bp = require('./lib/burger-pass');
const post = require('./lib/burger-pass-post');
const einstellungen = require('./lib/zahl-einstellungen');

const TAG_MS = 86400000;
const ms = (x) => { const t = new Date(x).getTime(); return Number.isFinite(t) ? t : 0; };

exports.handler = async () => {
  const jetzt = Date.now();
  const zahl = { geprueft: 0, abgelaufen: 0, verbraucht: 0, mailAblauf: 0, mailLetztes: 0, nachgebucht: 0, fehler: 0 };
  let kaufOffen = false;
  try { kaufOffen = !!(await einstellungen.lesen()).pass.aktiv; } catch (e) {}

  const ps = bp.store(bp.PASS_STORE);
  const cs = bp.store('customers');
  let blobs = [];
  try { ({ blobs } = await ps.list({ prefix: 'p:' })); } catch (e) {
    console.error('burger-pass-erinnerung list:', e && e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false }) };
  }

  for (const b of blobs) {
    try {
      const p = await ps.get(b.key, { type: 'json' });
      if (!p || p.status !== 'aktiv') continue;
      zahl.geprueft++;
      const ck = bp.kundenSchluessel(p.kaeufer && p.kaeufer.email);
      const cust = await cs.get(ck, { type: 'json' });
      let geaendert = false;

      // Gutschrift nachholen, falls das Ausstellen nach dem Anlegen abbrach
      if (!p.gutgeschrieben && cust && jetzt - ms(p.gekauftAm) > 10 * 60000) {
        if (bp.topfAnlegen(cust, p)) { await cs.setJSON(ck, cust); zahl.nachgebucht++; }
        p.gutgeschrieben = true; geaendert = true;
      }

      const topf = cust && Array.isArray(cust.passMenus) ? cust.passMenus.find((x) => x && x.pass === p.id) : null;
      const uebrig = topf ? Math.max(0, Math.floor(Number(topf.menus) || 0)) : (cust ? 0 : Number(p.menusUebrig) || 0);

      if (ms(p.gueltigBis) <= jetzt) {
        p.status = 'abgelaufen';
        p.verfallen = uebrig;
        p.menusUebrig = 0;
        if (cust && topf) { bp.aufraeumen(cust, jetzt); await cs.setJSON(ck, cust); }
        await ps.setJSON(b.key, p);
        zahl.abgelaufen++;
        continue;
      }
      if (uebrig <= 0) {
        p.status = 'verbraucht'; p.menusUebrig = 0;
        await ps.setJSON(b.key, p);
        zahl.verbraucht++;
        continue;
      }
      if (p.menusUebrig !== uebrig) { p.menusUebrig = uebrig; geaendert = true; }

      p.erinnert = p.erinnert || {};
      const bald = ms(p.gueltigBis) - jetzt <= 7 * TAG_MS;
      if (bald && !p.erinnert.ablauf) {
        if (await post.senden('ablauf', p, { uebrig, kaufOffen })) {
          p.erinnert.ablauf = new Date(jetzt).toISOString();
          if (uebrig === 1) p.erinnert.letztes = p.erinnert.ablauf;   // eine Mail reicht
          geaendert = true; zahl.mailAblauf++;
        }
      } else if (uebrig === 1 && !p.erinnert.letztes) {
        if (await post.senden('letztes', p, { uebrig, kaufOffen })) {
          p.erinnert.letztes = new Date(jetzt).toISOString();
          geaendert = true; zahl.mailLetztes++;
        }
      }
      if (geaendert) await ps.setJSON(b.key, p);
    } catch (e) {
      zahl.fehler++;
      console.error('burger-pass-erinnerung ' + b.key + ':', e && e.message);
    }
  }
  return { statusCode: 200, body: JSON.stringify({ ok: true, ...zahl }) };
};
