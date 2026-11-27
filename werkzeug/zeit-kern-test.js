#!/usr/bin/env node
/**
 * werkzeug/zeit-kern-test.js
 * Gemeinsamer Kern fürs Stempeln (zeit-kern.js): Warteschlange mit Netzfehlern, Rückgängig, Reihenfolge,
 * vorläufiger Stand, Texte. Ohne Browser: Speicher und Senden sind nachgebaut.
 *   node werkzeug/zeit-kern-test.js
 */
const path = require('path');
const K = require(path.join(__dirname, '..', 'zeit-kern.js'));

let n = 0, fehler = 0;
const ok = (name, b, info) => { n++; if (!b) fehler++; console.log((b ? '✅ ' : '❌ ') + name + (b || info === undefined ? '' : '   → ' + JSON.stringify(info))); };
const speicher = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
let uhr = Date.parse('2027-01-05T09:02:00.000Z');
let zaehler = 0;
const uuid = () => '00000000-0000-4000-8000-' + String(++zaehler).padStart(12, '0');
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

(async () => {
  /* ---- Warteschlange ---------------------------------------------------- */
  const sp = speicher();
  const gesendet = [];
  let antworten = [];   // je Senden die nächste Antwort, 'netz' wirft
  const senden = async (e) => {
    const a = antworten.shift() || { status: 200, daten: { ok: true } };
    if (a === 'netz') throw new Error('offline');
    gesendet.push(e.schluessel);
    return a;
  };
  const q = K.warteschlange({ speicher: sp, via: 'stempeluhr', senden, jetzt: () => uhr, uuid });
  const e1 = q.stempeln('p1', 'beginn');
  uhr += 60000;
  const e2 = q.stempeln('p2', 'beginn');
  ok('Stempel bekommt sofort Schlüssel (UUID v4) und Gerätezeit', UUID4.test(e1.schluessel) && e1.zeit === '2027-01-05T09:02:00.000Z' && e1.via === 'stempeluhr');
  ok('… und liegt im localStorage unter gnc_zeit_warteschlange', JSON.parse(sp.m.get('gnc_zeit_warteschlange')).length === 2);
  antworten = ['netz'];
  let r = await q.abarbeiten();
  ok('Ohne Netz: nichts weg, Lauf hält an', r.gestoppt === 'netz' && r.wartend === 2 && gesendet.length === 0);
  r = await q.abarbeiten();
  ok('Wieder online: beide raus, in der Reihenfolge der Gerätezeit', r.gestoppt === null && r.wartend === 0 && gesendet.join() === [e1.schluessel, e2.schluessel].join());
  ok('… mit den Antworten je Stempel', r.ergebnisse.length === 2 && r.ergebnisse[0].eintrag.schluessel === e1.schluessel && r.ergebnisse[0].status === 200);

  const e3 = q.stempeln('p1', 'ende');
  antworten = [{ status: 503, daten: { fehler: 'office_weg' } }];
  r = await q.abarbeiten();
  ok('503 office_weg: bleibt liegen', r.gestoppt === 'netz' && q.wartend().length === 1);
  antworten = [{ status: 409, daten: { fehler: 'zustand', stand: { zustand: 'frei' } } }];
  r = await q.abarbeiten();
  ok('409 zustand: weg aus der Schlange, Grund in den Ergebnissen', r.wartend === 0 && r.ergebnisse[0].status === 409 && r.ergebnisse[0].daten.fehler === 'zustand' && r.ergebnisse[0].eintrag.schluessel === e3.schluessel);
  q.stempeln('p1', 'beginn');
  antworten = [{ status: 401, daten: { fehler: 'unauthorized' } }];
  r = await q.abarbeiten();
  ok('401: bleibt liegen, Lauf meldet die Anmeldung', r.gestoppt === 'anmeldung' && r.wartend === 1);
  await q.abarbeiten();

  /* ---- Uhr geht vor (400 zukunft) ------------------------------------------ */
  const ez = q.stempeln('p1', 'ende');
  antworten = [{ status: 400, daten: { fehler: 'zukunft' } }];
  r = await q.abarbeiten();
  ok('400 zukunft: Stempel bleibt liegen, Lauf meldet die Uhr', r.gestoppt === 'uhr' && r.wartend === 1 && r.ergebnisse.length === 0 && q.wartend()[0].schluessel === ez.schluessel);
  r = await q.abarbeiten();
  ok('… sobald die Zeit aufgeholt hat, geht er beim nächsten Lauf durch', r.gestoppt === null && r.wartend === 0 && r.ergebnisse[0].eintrag.schluessel === ez.schluessel && gesendet[gesendet.length - 1] === ez.schluessel);
  const ee = q.stempeln('p1', 'beginn');
  antworten = [{ status: 400, daten: { fehler: 'eingabe' } }];
  r = await q.abarbeiten();
  ok('Anderer 400: Stempel wird verworfen, Grund in den Ergebnissen', r.gestoppt === null && r.wartend === 0 && r.ergebnisse[0].status === 400 && r.ergebnisse[0].eintrag.schluessel === ee.schluessel);
  q.stempeln('p1', 'ende');
  await q.abarbeiten();

  /* ---- Rückgängig ------------------------------------------------------- */
  const vorher = gesendet.length;
  const offline = q.stempeln('p1', 'pause_beginn');
  ok('Rückgängig vor dem Senden: Stempel einfach weg, nichts geht raus', q.rueckgaengig(offline.schluessel, 'p1').weg === true && q.wartend().length === 0 && gesendet.length === vorher);
  const online = q.stempeln('p1', 'pause_beginn');
  await q.abarbeiten();
  const rn = q.rueckgaengig(online.schluessel, 'p1');
  ok('Rückgängig nach dem Senden: Rücknahme mit Bezug in der Schlange', rn.typ === 'zuruecknehmen' && rn.bezug_schluessel === online.schluessel && rn.person_id === 'p1' && UUID4.test(rn.schluessel));
  await q.abarbeiten();
  ok('… und geht raus', q.wartend().length === 0 && gesendet[gesendet.length - 1] === rn.schluessel);

  /* ---- Zwei Seiten, ein Browser ------------------------------------------- */
  const handy = K.warteschlange({ speicher: sp, via: 'handy', senden, jetzt: () => uhr, uuid });
  handy.stempeln('p9', 'beginn');
  ok('iPad-Schlange fasst Handy-Stempel nicht an', q.wartend().length === 0 && handy.wartend().length === 1);
  await handy.abarbeiten();

  /* ---- Gleichzeitig abarbeiten ---------------------------------------------- */
  const z = gesendet.length;
  q.stempeln('p1', 'beginn');
  const [a, b] = await Promise.all([q.abarbeiten(), q.abarbeiten()]);
  ok('Zwei Aufrufe, ein Lauf: jeder Stempel genau einmal gesendet', gesendet.length === z + 1 && a === b);

  /* ---- Kaputter Speicher -------------------------------------------------- */
  const kaputt = speicher();
  kaputt.setItem('gnc_zeit_warteschlange', '{kaputt');
  ok('Kaputter Speicher: leere Schlange statt Absturz', K.warteschlange({ speicher: kaputt, via: 'handy', senden }).wartend().length === 0);

  /* ---- Vorläufiger Stand -------------------------------------------------- */
  const s = K.vorlaeufig({ zustand: 'frei' }, [{ typ: 'stempeln', art: 'beginn', zeit: '2027-01-05T09:02:00.000Z' }, { typ: 'stempeln', art: 'pause_beginn', zeit: '2027-01-05T13:10:00.000Z' }]);
  ok('Vorläufig: frei + Beginn + Pause = Pause seit 14:10, 2 wartend', s.zustand === 'pause' && s.seit === '2027-01-05T13:10:00.000Z' && s.beginn === '2027-01-05T09:02:00.000Z' && s.wartend === 2);
  ok('Vorläufig: Pause Ende zeigt wieder den Schichtbeginn', K.vorlaeufig(s, [{ typ: 'stempeln', art: 'pause_ende', zeit: '2027-01-05T13:40:00.000Z' }]).seit === '2027-01-05T09:02:00.000Z');

  /* ---- Texte -------------------------------------------------------------- */
  const heute = '2027-01-05';
  ok('Bestätigung wie in der Spec', K.bestaetigung('Ali', 'ende', '2027-01-05T21:03:00.000Z', { arbeitszeit_min: 472, gutschrift_min: 5 }) === 'Ali, Schicht beendet um 22:03. 7:52 gearbeitet, +5 Min Gutschrift.');
  ok('Bestätigung ohne Antwort (offline) und ohne Gutschrift', K.bestaetigung('Ali', 'ende', '2027-01-05T21:03:00.000Z') === 'Ali, Schicht beendet um 22:03.'
    && K.bestaetigung('Ali', 'ende', '2027-01-05T21:03:00.000Z', { arbeitszeit_min: 60, gutschrift_min: 0 }) === 'Ali, Schicht beendet um 22:03. 1:00 gearbeitet.');
  ok('Stand als Text', K.standText({ zustand: 'frei' }, heute) === 'frei' && K.standText({ zustand: 'im_dienst', seit: '2027-01-05T09:02:00.000Z' }, heute) === 'im Dienst seit 10:02'
    && K.standText({ zustand: 'pause', seit: '2027-01-05T13:10:00.000Z' }, heute) === 'in Pause seit 14:10'
    && K.standText({ zustand: 'im_dienst', seit: '2027-01-04T17:00:00.000Z' }, heute) === 'im Dienst seit gestern 18:00');
  ok('Vergessene Schicht als Hinweis', K.vergessenText({ zustand: 'frei', vergessen: { beginn: '2027-01-04T09:00:00.000Z' } }, heute) === 'Ende der Schicht von gestern fehlt. Kubi trägt es nach.');
  ok('Knöpfe je Stand', K.knoepfe('frei').map((k) => k.art).join() === 'beginn' && K.knoepfe('im_dienst').map((k) => k.art).join() === 'pause_beginn,ende'
    && K.knoepfe('pause').map((k) => k.art).join() === 'pause_ende,ende');
  ok('Wartend-Text wie in der Spec', K.wartendText(2) === 'Gespeichert, wird übertragen (2 wartend).');
  ok('Uhr-Text für zukunft', K.fehlerText('zukunft') === 'Die Uhr dieses Geräts geht vor. Der Stempel wartet und geht raus, sobald sie passt.');
  const alle = [K.fehlerText('zustand'), K.fehlerText('nicht_zuruecknehmbar'), K.fehlerText('x'), K.fehlerText('zukunft'), K.fehlerText('keine_person', 'Kubi muss dich im Dienstplan deinem Login zuordnen.'),
    ...K.knoepfe('pause').map((k) => k.text), K.wartendText(1)];
  ok('Keine Gedankenstriche in sichtbaren Texten', alle.every((t) => !/[–—]/.test(t)));

  console.log('\n' + (fehler ? '❌ ' + fehler + ' von ' + n + ' Prüfungen fehlgeschlagen' : '✅ Alle ' + n + ' Prüfungen grün'));
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.log('Absturz:', e && e.stack); process.exit(1); });
