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
  ok('Uhr-Text für zukunft', K.fehlerText('zukunft') === 'Die Uhr dieses Geräts geht vor. Der Stempel wartet und geht raus, sobald die echte Uhrzeit ihn eingeholt hat.');
  const alle = [K.fehlerText('zustand'), K.fehlerText('nicht_zuruecknehmbar'), K.fehlerText('x'), K.fehlerText('zukunft'), K.fehlerText('schluessel_anders'), K.fehlerText('person_fehlt'), K.fehlerText('speicher'), K.fehlerText('too_many_requests'), K.fehlerText('nicht_zuruecknehmbar', 'abgelehnt'), K.fehlerText('keine_person', 'Kubi muss dich im Dienstplan deinem Login zuordnen.'),
    ...K.knoepfe('pause').map((k) => k.text), K.wartendText(1)];
  ok('Keine Gedankenstriche in sichtbaren Texten', alle.every((t) => !/[–—]/.test(t)));


  /* ---- Nachbesserung: nichts geht still verloren ------------------------------ */
  const frisch = (extra) => {
    const o = Object.assign({ speicher: speicher(), via: 'stempeluhr', jetzt: () => uhr, uuid }, extra);
    o.q = K.warteschlange(o);
    return o;
  };
  const antwortFolge = (liste, log) => async (e) => { const a = liste.shift() || { status: 200, daten: { ok: true } }; if (a === 'netz') throw new Error('x'); log.push(e.schluessel); return a; };

  // 1. Antworten
  for (const [name, a] of [['HTML-404 ohne JSON', { status: 404, daten: {} }], ['204', { status: 204, daten: {} }], ['408', { status: 408, daten: {} }], ['413 ohne JSON', { status: 413 }], ['429 mit error', { status: 429, daten: { error: 'too_many_requests' } }], ['502', { status: 502, daten: {} }]]) {
    const log = [], o = frisch({ senden: antwortFolge([a], log) });
    const e = o.q.stempeln('p1', 'beginn');
    const rr = await o.q.abarbeiten();
    ok(name + ': bleibt liegen, Lauf stoppt mit netz', rr.gestoppt === 'netz' && o.q.wartend().length === 1 && o.q.wartend()[0].schluessel === e.schluessel && rr.ergebnisse.length === 0 && o.q.abgelehnt().length === 0);
  }
  {
    const log = [], o = frisch({ senden: antwortFolge([{ status: 409, daten: { fehler: 'zustand' } }, { status: 200, daten: {} }], log) });
    const a1 = o.q.stempeln('p1', 'beginn'); uhr += 1000; const a2 = o.q.stempeln('p1', 'ende');
    const rr = await o.q.abarbeiten();
    ok('409 zustand hält die folgenden Einträge nicht an', rr.gestoppt === null && log.length === 2 && rr.ergebnisse.length === 2 && rr.ergebnisse[0].status === 409 && rr.wartend === 0 && o.q.abgelehnt().length === 0);
  }
  for (const code of ['eingabe', 'aktion', 'art', 'schluessel', 'bezug', 'zeit', 'constructor', 'toString', '__proto__']) {
    const o = frisch({ senden: antwortFolge([{ status: 400, daten: { fehler: code } }], []) });
    o.q.stempeln('p1', 'beginn');
    const rr = await o.q.abarbeiten();
    ok('Code ' + code + ' wird nicht verworfen, sondern abgelehnt', rr.wartend === 0 && o.q.abgelehnt().length === 1 && o.q.abgelehnt()[0].fehler === code && rr.ergebnisse[0].abgelehnt === true);
  }
  for (const code of ['zustand', 'nicht_zuruecknehmbar', 'schluessel_anders']) {
    const o = frisch({ senden: antwortFolge([{ status: 400, daten: { fehler: code } }], []) });
    o.q.stempeln('p1', 'beginn');
    const rr = await o.q.abarbeiten();
    ok('Endgültiger Code ' + code + ': aus der Schlange, Grund im Ergebnis, nicht in abgelehnt', rr.wartend === 0 && rr.ergebnisse[0].daten.fehler === code && o.q.abgelehnt().length === 0);
  }
  {
    const log = [], o = frisch({ senden: antwortFolge([{ status: 403, daten: { fehler: 'person_fehlt' } }, { status: 200, daten: { ok: true } }], log) });
    const a1 = o.q.stempeln('p1', 'beginn'); uhr += 1000; o.q.stempeln('p2', 'beginn');
    const rr = await o.q.abarbeiten();
    const ab = o.q.abgelehnt();
    ok('person_fehlt wandert nach abgelehnt, Lauf geht weiter', rr.gestoppt === null && rr.wartend === 0 && ab.length === 1 && ab[0].schluessel === a1.schluessel && ab[0].status === 403 && ab[0].fehler === 'person_fehlt' && typeof ab[0].am === 'string' && log.length === 2);
    ok('… mit Grund in den Ergebnissen und demselben Speicherschlüssel', rr.ergebnisse[0].daten.fehler === 'person_fehlt' && rr.ergebnisse[0].eintrag.schluessel === a1.schluessel && JSON.parse(o.speicher.m.get('gnc_zeit_warteschlange')).filter((x) => x.abgelehnt).length === 1 && !o.speicher.m.has('gnc_zeit_abgelehnt'));
    const log2 = log.length;
    const r2 = await o.q.erneut(a1.schluessel);
    ok('erneut holt ihn zurück, sendet mit Schlüssel und Gerätezeit, 200 geht durch', o.q.abgelehnt().length === 0 && o.q.wartend().length === 0 && log.length === log2 + 1 && log[log.length - 1] === a1.schluessel && r2.ergebnisse[0].status === 200 && r2.ergebnisse[0].eintrag.zeit === a1.zeit);
    ok('erneut mit unbekanntem Schlüssel ist harmlos', (await o.q.erneut('gibts-nicht')) === null);
  }
  {
    const o = frisch({ senden: antwortFolge([{ status: 422, daten: { fehler: 'voellig_neu' } }], []) });
    o.q.stempeln('p1', 'beginn');
    await o.q.abarbeiten();
    ok('Unbekannter Fehlercode wandert nach abgelehnt', o.q.abgelehnt().length === 1 && o.q.wartend().length === 0);
  }

  // 2. Schreibfehler
  {
    const log = [];
    const sp2 = speicher(); sp2.setItem = () => { throw new Error('QuotaExceededError'); };
    const o = frisch({ speicher: sp2, senden: antwortFolge([], log) });
    const e = o.q.stempeln('p1', 'beginn');
    ok('Speicher voll: stempeln meldet gespeichert false', e.gespeichert === false && UUID4.test(e.schluessel));
    ok('… der Stempel liegt trotzdem in der Schlange der Seite', o.q.wartend().length === 1);
    const rr = await o.q.abarbeiten();
    ok('… und wird trotzdem gesendet', log.length === 1 && log[0] === e.schluessel && rr.wartend === 0 && rr.ergebnisse.length === 1);
    ok('Bei Erfolg meldet stempeln gespeichert true', frisch({ senden: antwortFolge([], []) }).q.stempeln('p1', 'beginn').gespeichert === true);
    ok('Speicher-Text', /speichern/.test(K.fehlerText('speicher')) && /Seite offen/.test(K.fehlerText('speicher')));
  }
  {
    const log = [], sp2 = speicher();
    const o = frisch({ speicher: sp2, senden: async (e) => { log.push(e.schluessel); sp2.setItem = () => { throw new Error('voll'); }; return { status: 200, daten: {} }; } });
    o.q.stempeln('p1', 'beginn');
    const r1 = await o.q.abarbeiten();
    const r2 = await o.q.abarbeiten();
    ok('Entfernen scheitert nach 200: nicht erneut gesendet, nicht erneut gemeldet', log.length === 1 && r1.ergebnisse.length === 1 && r2.ergebnisse.length === 0 && o.q.wartend().length === 0);
  }
  {
    const sp2 = speicher(); let aus = false;
    const orig = sp2.setItem; sp2.setItem = (k, v) => { if (aus) throw new Error('voll'); orig(k, v); };
    const o = frisch({ speicher: sp2, senden: antwortFolge([], []) });
    const e = o.q.stempeln('p1', 'beginn');
    aus = true;
    const rn = o.q.rueckgaengig(e.schluessel, 'p1');
    ok('Rückgängig ohne Schreiberfolg: kein weg true, Rücknahme wird angestellt', rn.weg !== true && rn.typ === 'zuruecknehmen' && rn.bezug_schluessel === e.schluessel);
    ok('… und der Stempel bleibt in der Schlange', o.q.wartend().length === 2);
  }
  {
    const sp2 = speicher(); sp2.getItem = () => { throw new Error('gesperrt'); };
    const log = [], o = frisch({ speicher: sp2, senden: antwortFolge([], log) });
    o.q.stempeln('p1', 'beginn');
    ok('Speicher nicht lesbar: Kopie im Speicher der Seite hält den Stempel', o.q.wartend().length === 1 && (await o.q.abarbeiten()).ergebnisse.length === 1 && log.length === 1);
  }

  // 3. Robustheit
  {
    const sp2 = speicher();
    sp2.setItem('gnc_zeit_warteschlange', JSON.stringify([null, 5, 'x', { zeit: 'ohne schluessel' }, { typ: 'stempeln', via: 'stempeluhr', schluessel: 'ok-1', person_id: 'p1', art: 'beginn', zeit: '2027-01-05T09:00:00.000Z' }]));
    ok('Kaputte Elemente fallen weg, gute bleiben', K.warteschlange({ speicher: sp2, via: 'stempeluhr', senden }).wartend().length === 1);
  }
  {
    let boese = true;
    const log = [], o = frisch({ senden: async (e) => { if (boese) return { get status() { throw new Error('kaputt'); } }; log.push(e.schluessel); return { status: 200, daten: {} }; } });
    o.q.stempeln('p1', 'beginn');
    const alt = console.error; console.error = () => {};
    const r1 = await o.q.abarbeiten();
    console.error = alt;
    boese = false;
    const rr = await o.q.abarbeiten();
    ok('Fehler in einem Lauf blockiert weitere Läufe nicht', r1.gestoppt === 'netz' && log.length === 1 && rr.wartend === 0);
  }

  // 4. Reihenfolge per Zähler
  {
    const log = [], o = frisch({ senden: antwortFolge([], log) });
    const zeiten = ['2027-01-05T12:00:00.000Z', '2027-01-05T11:00:00.000Z', '2027-01-05T10:00:00.000Z'];
    const es = [];
    for (let i = 0; i < 3; i++) { uhr = Date.parse(zeiten[i]); es.push(o.q.stempeln('p1', ['beginn', 'pause_beginn', 'pause_ende'][i])); }
    await o.q.abarbeiten();
    ok('Absteigende Gerätezeit: Einfüge-Reihenfolge geht raus', log.join() === es.map((e) => e.schluessel).join() && es[0].nr < es[1].nr && es[1].nr < es[2].nr);
    uhr = Date.parse('2027-01-05T09:02:00.000Z');
  }
  {
    const sp2 = speicher();
    sp2.setItem('gnc_zeit_warteschlange', JSON.stringify([{ schluessel: 'neu', via: 'stempeluhr', zeit: '2027-01-05T10:00:00.000Z', nr: 3 }, { schluessel: 'alt2', via: 'stempeluhr', zeit: '2027-01-05T09:00:00.000Z' }, { schluessel: 'alt1', via: 'stempeluhr', zeit: '2027-01-05T08:00:00.000Z' },
      { schluessel: 'ab', via: 'stempeluhr', nr: 7, zeit: '2027-01-05T07:00:00.000Z', abgelehnt: { status: 404, fehler: 'person_fehlt', am: '2027-01-05T07:01:00.000Z' } }]));
    const q2 = K.warteschlange({ speicher: sp2, via: 'stempeluhr', senden, jetzt: () => uhr, uuid });
    const n8 = q2.stempeln('p1', 'beginn');
    ok('Alte Einträge ohne nr zählen 0 und behalten Zeitreihenfolge; neue nr = größte im Array (auch bei abgelehnten) plus 1', q2.wartend().map((e) => e.schluessel).slice(0, 3).join() === 'alt1,alt2,neu' && q2.abgelehnt().length === 1 && q2.abgelehnt()[0].fehler === 'person_fehlt' && q2.abgelehnt()[0].status === 404 && !('abgelehnt' in q2.abgelehnt()[0]) && n8.nr === 8);
  }

  // Rückgängig während des Sendens
  {
    const log = []; let q3;
    const o = frisch({ senden: async (e) => { log.push(e.typ); if (e.typ === 'stempeln') q3.rueckgaengig(e.schluessel, 'p1'); return { status: 200, daten: {} }; } });
    q3 = o.q;
    q3.stempeln('p1', 'beginn');
    const rr = await q3.abarbeiten();
    ok('Rückgängig während des Sendens: Rücknahme angestellt und nach dem Stempel gesendet', log.join() === 'stempeln,zuruecknehmen' && rr.wartend === 0);
  }

  // 5. Vorläufiger Stand
  {
    const paar = K.vorlaeufig({ zustand: 'frei' }, [{ typ: 'stempeln', schluessel: 'a', art: 'beginn', zeit: '2027-01-05T09:00:00.000Z' }, { typ: 'zuruecknehmen', schluessel: 'b', bezug_schluessel: 'a', zeit: '2027-01-05T09:01:00.000Z' }]);
    ok('Vorläufig: Stempel samt wartender Rücknahme zählt nicht', paar.zustand === 'frei' && paar.seit === null);
    const jetzt = Date.parse('2027-01-06T04:00:00.000Z');
    const alt = K.vorlaeufig({ zustand: 'im_dienst', seit: '2027-01-05T09:00:00.000Z', beginn: '2027-01-05T09:00:00.000Z' }, [], jetzt);
    ok('Vorläufig: offener Beginn über 16 Stunden gilt als vergessen', alt.zustand === 'frei' && alt.vergessen && alt.vergessen.beginn === '2027-01-05T09:00:00.000Z');
    const knapp = K.vorlaeufig({ zustand: 'im_dienst', seit: '2027-01-05T13:00:00.000Z', beginn: '2027-01-05T13:00:00.000Z' }, [], jetzt);
    ok('… knapp darunter bleibt im Dienst', knapp.zustand === 'im_dienst');
    const wart = K.vorlaeufig({ zustand: 'frei' }, [{ typ: 'stempeln', art: 'beginn', zeit: '2027-01-05T08:00:00.000Z' }], jetzt);
    ok('… auch bei wartendem Beginn', wart.zustand === 'frei' && !!wart.vergessen);
    ok('Ohne jetzt bleibt das bisherige Verhalten', K.vorlaeufig({ zustand: 'im_dienst', seit: 'a', beginn: '2027-01-05T09:00:00.000Z' }, []).zustand === 'im_dienst');
  }

  // 6. Texte
  ok('Texte: schluessel_anders, person_fehlt, nicht_zuruecknehmbar', K.fehlerText('schluessel_anders') === 'Dieser Stempel ist schon gespeichert.'
    && /nicht gespeichert/.test(K.fehlerText('person_fehlt')) && /Kubi/.test(K.fehlerText('person_fehlt')) && /Dienstplan/.test(K.fehlerText('person_fehlt'))
    && /Sag Kubi Bescheid/.test(K.fehlerText('nicht_zuruecknehmbar')) && !/Kubi/.test(K.fehlerText('nicht_zuruecknehmbar', 'abgelehnt')));

  // 7. UUID
  {
    const fake = { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = 255; return a; } };
    const u = K.uuidV4(fake);
    ok('UUID ohne randomUUID: v4 aus getRandomValues', UUID4.test(u));
    const fake0 = { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = i * 17 + 3; return a; } };
    ok('… Version- und Variant-Bits stimmen bei anderen Zufallswerten', UUID4.test(K.uuidV4(fake0)) && K.uuidV4({ randomUUID: () => 'x' }) === 'x');
  }

  /* ---- Zweite Nachbesserung ------------------------------------------------- */
  const vollMitM = (nurKey) => { const sp2 = speicher(); const set = sp2.setItem; sp2.setItem = (k, v) => { if (!nurKey || k === nurKey) throw new Error('QuotaExceededError'); set(k, v); }; return sp2; };
  // 1
  {
    const log = [];
    const o = frisch({ speicher: vollMitM(), senden: async (e) => { log.push(e.typ + ':' + e.person_id); return { status: 200, daten: {} }; } });
    o.q.stempeln('pA', 'beginn'); uhr += 1000;
    const b = o.q.stempeln('pB', 'beginn'); uhr += 1000;
    o.q.rueckgaengig(b.schluessel, 'pB');
    ok('Speicher voll, B macht rückgängig: Stempel von A bleibt in wartend', o.q.wartend().some((e) => e.person_id === 'pA' && e.typ === 'stempeln'));
    await o.q.abarbeiten();
    ok('… und wird gesendet', log[0] === 'stempeln:pA');
  }
  // 2
  {
    const log = []; let antw = [{ status: 404, daten: { fehler: 'person_fehlt' } }];
    const o = frisch({ senden: async (e) => { log.push(e.typ); return antw.shift() || { status: 200, daten: {} }; } });
    const e = o.q.stempeln('p1', 'beginn');
    await o.q.abarbeiten();
    const r2 = o.q.rueckgaengig(e.schluessel, 'p1');
    await o.q.abarbeiten();
    await o.q.erneut(e.schluessel);
    ok('Rückgängig auf abgelehnt: weg, keine Rücknahme, nichts geht mehr raus', r2.weg === true && o.q.abgelehnt().length === 0 && o.q.wartend().length === 0 && log.join() === 'stempeln');
  }
  // 3: ein gemeinsames Kontingent wie beim echten localStorage: X wird abgelehnt, Y geht im selben Lauf durch, Neuladen
  {
    const m = new Map(); const kont = { grenze: 0 };
    const groesse = () => { let n = 0; for (const [k, v] of m) n += k.length + v.length; return n; };
    const sp2 = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem(k, v) { const alt = m.get(k); m.set(k, String(v)); if (groesse() > kont.grenze) { if (alt === undefined) m.delete(k); else m.set(k, alt); throw new Error('QuotaExceededError'); } } };
    kont.grenze = 1e9;
    const q0 = K.warteschlange({ speicher: sp2, via: 'stempeluhr', uuid, jetzt: () => uhr, senden: async () => ({ status: 0 }) });
    const x = q0.stempeln('pX', 'beginn'); uhr += 1000; q0.stempeln('pY', 'beginn');
    kont.grenze = groesse() + 20;
    const q = K.warteschlange({ speicher: sp2, via: 'stempeluhr', uuid, jetzt: () => uhr, senden: async (e) => (e.person_id === 'pX' ? { status: 404, daten: { fehler: 'person_fehlt' } } : { status: 200, daten: {} }) });
    const rr = await q.abarbeiten();
    const q2 = K.warteschlange({ speicher: sp2, via: 'stempeluhr', uuid, jetzt: () => uhr, senden: async () => ({ status: 200, daten: {} }) });
    ok('Gemeinsames Kontingent: abgelehntes X ist nach dem Neuladen nicht verschwunden', rr.ergebnisse.length === 2 && q.abgelehnt().length === 1
      && q2.wartend().concat(q2.abgelehnt()).some((e) => e.schluessel === x.schluessel));
  }
  {
    const o2 = frisch({ speicher: speicher(), senden: antwortFolge([{ status: 404, daten: { fehler: 'person_fehlt' } }], []) });
    const e = o2.q.stempeln('p1', 'beginn'); await o2.q.abarbeiten();
    const sp3 = o2.speicher; sp3.setItem = () => { throw new Error('voll'); };
    o2.q.erneut(e.schluessel);
    const q3 = K.warteschlange({ speicher: sp3, via: 'stempeluhr', senden, jetzt: () => uhr, uuid });
    ok('erneut bei vollem Speicher: nach Neuladen weiter in abgelehnt', q3.abgelehnt().length === 1);
  }
  // 4
  {
    const log = [];
    const o = frisch({ senden: async (e) => { const echt = Date.parse('2027-01-05T10:00:00.000Z'); if (Date.parse(e.zeit) - echt > 120000) return { status: 400, daten: { fehler: 'zukunft' } }; log.push(e.person_id); return { status: 200, daten: {} }; } });
    uhr = Date.parse('2027-01-06T10:00:00.000Z'); o.q.stempeln('pA', 'beginn');
    uhr = Date.parse('2027-01-05T10:00:00.000Z'); o.q.stempeln('pB', 'beginn');
    const rr = await o.q.abarbeiten();
    ok('Uhr korrigiert: alter Stempel nach abgelehnt (zukunft), neuer geht raus', rr.gestoppt === null && log.join() === 'pB' && o.q.abgelehnt().length === 1 && o.q.abgelehnt()[0].fehler === 'zukunft' && rr.wartend === 0);
    uhr = Date.parse('2027-01-05T09:02:00.000Z');
  }
  {
    const o = frisch({ senden: antwortFolge([{ status: 400, daten: { fehler: 'zukunft' } }], []) });
    uhr += 60000; o.q.stempeln('p1', 'beginn'); uhr -= 60000;
    const rr = await o.q.abarbeiten();
    ok('Uhr geht nur eine Minute vor: bleibt liegen, uhr', rr.gestoppt === 'uhr' && o.q.wartend().length === 1 && o.q.abgelehnt().length === 0);
  }
  // 5
  {
    const gemeldet = []; const alt = console.error; console.error = (...a) => gemeldet.push(a.join(' '));
    let boese = true;
    const o = frisch({ senden: async () => { if (boese) return { get status() { throw new Error('kaputt'); } }; return { status: 200, daten: {} }; } });
    const e = o.q.stempeln('p1', 'beginn');
    const rr = await o.q.abarbeiten();
    console.error = alt;
    ok('Fehler im Lauf: gestoppt netz, Eintrag bleibt, console.error mit Schlüssel', rr.gestoppt === 'netz' && o.q.wartend().length === 1 && gemeldet.length === 1 && gemeldet[0].includes(e.schluessel) && !gemeldet[0].includes('p1'));
    const o3 = frisch({ senden: async () => { throw new Error('offline'); } });
    o3.q.stempeln('p1', 'beginn');
    const r3 = await o3.q.abarbeiten();
    ok('senden wirft: gestoppt netz, Eintrag bleibt', r3.gestoppt === 'netz' && o3.q.wartend().length === 1);
  }
  // 7
  {
    const v = K.vorlaeufig({ zustand: 'im_dienst', seit: '2027-01-05T09:00:00.000Z', beginn: '2027-01-05T09:00:00.000Z' }, [], Date.parse('2027-01-06T04:00:00.000Z'));
    ok('Vergessen wie im Office: frei, beginn null, vergessen mit Beginn und Berliner Tag', v.zustand === 'frei' && v.beginn === null && v.seit === null && v.vergessen.beginn === '2027-01-05T09:00:00.000Z' && v.vergessen.tag === '2027-01-05');
  }
  // 8
  {
    const o = frisch({ senden: antwortFolge([{ status: 404, daten: { fehler: 'person_fehlt' } }], []) });
    const e = o.q.stempeln('p1', 'beginn'); await o.q.abarbeiten();
    const nein = o.q.verwerfen('gibts-nicht');
    const ja = o.q.verwerfen(e.schluessel);
    ok('verwerfen entfernt endgültig aus abgelehnt, Unbekanntes false', nein === false && ja === true && o.q.abgelehnt().length === 0 && JSON.parse(o.speicher.m.get('gnc_zeit_warteschlange')).length === 0);
  }

  console.log('\n' + (fehler ? '❌ ' + fehler + ' von ' + n + ' Prüfungen fehlgeschlagen' : '✅ Alle ' + n + ' Prüfungen grün'));
  process.exit(fehler ? 1 : 0);
})().catch((e) => { console.log('Absturz:', e && e.stack); process.exit(1); });
