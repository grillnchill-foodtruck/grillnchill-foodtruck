/* ============================================================================
   zeit-kern.js
   Gemeinsamer Kern fürs Stempeln am iPad (cockpit.html mit zeit-stempeln.js) und am Handy (zeit.html mit
   zeit-handy.js): Warteschlange, vorläufiger Stand, Texte und Knöpfe. Ohne DOM, deshalb auch in Node testbar
   (werkzeug/zeit-kern-test.js). Server: netlify/functions/zeit.js.

   Warteschlange (localStorage gnc_zeit_warteschlange): Jeder Stempel bekommt sofort einen Schlüssel (UUID v4) und
   die Gerätezeit und wird gleich gesendet. Ohne Netz oder bei 503 bleibt er liegen und geht beim nächsten
   Abarbeiten raus (online, beim Öffnen, alle 60 Sekunden), streng in der Reihenfolge der Gerätezeit. via trennt
   iPad ('stempeluhr') und Handy ('handy'), falls beide im selben Browser laufen.
   Geht die Uhr des Geräts vor (400 zukunft), bleibt der Stempel liegen und der Lauf stoppt mit 'uhr'. Stempel sind
   Pflichtaufzeichnungen und dürfen nicht verloren gehen.
   ========================================================================== */
(function (wurzel) {
  'use strict';

  var SCHLUESSEL = 'gnc_zeit_warteschlange';
  var UHR = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' });
  var TAG = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' });
  var KURZ = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'Europe/Berlin' });

  var uhrzeit = function (iso) { return iso ? UHR.format(new Date(iso)) : ''; };
  var tagVon = function (iso) { return TAG.format(new Date(iso)); };
  // Minuten als Stunden:Minuten, 472 -> "7:52"
  var dauerText = function (min) { return Math.floor(min / 60) + ':' + String(min % 60).padStart(2, '0'); };
  var gestern = function (heute) { return new Date(Date.parse(heute + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10); };
  // "10:02", "gestern 18:00" oder "Mo., 4.1. 10:02"
  function wann(iso, heute) {
    var t = tagVon(iso);
    if (t === heute) return uhrzeit(iso);
    return (t === gestern(heute) ? 'gestern' : KURZ.format(new Date(iso))) + ' ' + uhrzeit(iso);
  }

  var KNOEPFE = {
    frei: [['beginn', 'Schicht beginnen']],
    im_dienst: [['pause_beginn', 'Pause beginnen'], ['ende', 'Schicht beenden']],
    pause: [['pause_ende', 'Pause beenden'], ['ende', 'Schicht beenden']],
  };
  function knoepfe(zustand) { return (KNOEPFE[zustand] || KNOEPFE.frei).map(function (k) { return { art: k[0], text: k[1] }; }); }

  function standText(stand, heute) {
    if (!stand) return 'Stand unbekannt';
    if (stand.zustand === 'im_dienst') return 'im Dienst seit ' + wann(stand.seit, heute);
    if (stand.zustand === 'pause') return 'in Pause seit ' + wann(stand.seit, heute);
    return 'frei';
  }
  // Hinweis zu einer vergessenen Schicht (Ende fehlt, Kubi trägt nach)
  function vergessenText(stand, heute) {
    return stand && stand.vergessen ? 'Ende der Schicht von ' + wann(stand.vergessen.beginn, heute).replace(/ \d{2}:\d{2}$/, '') + ' fehlt. Kubi trägt es nach.' : '';
  }

  function bestaetigung(name, art, zeit, daten) {
    var u = uhrzeit(zeit);
    if (art === 'beginn') return name + ', Schicht begonnen um ' + u + '.';
    if (art === 'pause_beginn') return name + ', Pause ab ' + u + '.';
    if (art === 'pause_ende') return name + ', Pause beendet um ' + u + '.';
    var text = name + ', Schicht beendet um ' + u + '.';
    if (daten && typeof daten.arbeitszeit_min === 'number') {
      text += ' ' + dauerText(daten.arbeitszeit_min) + ' gearbeitet' + (daten.gutschrift_min ? ', +' + daten.gutschrift_min + ' Min Gutschrift.' : '.');
    }
    return text;
  }

  var FEHLER = {
    zustand: 'Passt nicht zum Stand. Die Anzeige ist jetzt aktuell.',
    nicht_zuruecknehmbar: 'Rückgängig geht nicht mehr. Sag Kubi Bescheid.',
    fremde_person: 'Du kannst nur für dich selbst stempeln.',
    person_fehlt: 'Diese Person steht nicht mehr im Dienstplan.',
    too_many_requests: 'Gerade zu viele Anfragen. Versuch es gleich noch einmal.',
    zukunft: 'Die Uhr dieses Geräts geht vor. Der Stempel wartet und geht raus, sobald sie passt.',
  };
  function fehlerText(code, hint) {
    if (code === 'keine_person' && hint) return hint;
    return FEHLER[code] || 'Das hat nicht geklappt. Versuch es noch einmal.';
  }
  function wartendText(n) { return 'Gespeichert, wird übertragen (' + n + ' wartend).'; }

  // Letzter bekannter Stand plus wartende Stempel dieser Person
  function vorlaeufig(stand, eintraege) {
    var s = Object.assign({ zustand: 'frei', seit: null, beginn: null, vergessen: null }, stand || {});
    var n = 0;
    (eintraege || []).forEach(function (e) {
      n++;
      if (e.typ !== 'stempeln') return;
      if (e.art === 'beginn') s = Object.assign({}, s, { zustand: 'im_dienst', seit: e.zeit, beginn: e.zeit, vergessen: null });
      else if (e.art === 'pause_beginn') s = Object.assign({}, s, { zustand: 'pause', seit: e.zeit });
      else if (e.art === 'pause_ende') s = Object.assign({}, s, { zustand: 'im_dienst', seit: s.beginn || e.zeit });
      else if (e.art === 'ende') s = Object.assign({}, s, { zustand: 'frei', seit: null, beginn: null });
    });
    return Object.assign(s, { wartend: n });
  }

  /* o: { speicher (localStorage), via, senden(eintrag) -> Promise<{ status, daten }>, jetzt?, uuid? } */
  function warteschlange(o) {
    var speicher = o.speicher, via = o.via, senden = o.senden;
    var jetzt = o.jetzt || function () { return Date.now(); };
    var uuid = o.uuid || function () { return crypto.randomUUID(); };
    var laeuft = null, nochmal = false, unterwegs = null;

    function lesen() {
      try { var l = JSON.parse(speicher.getItem(SCHLUESSEL) || '[]'); return Array.isArray(l) ? l : []; } catch (e) { return []; }
    }
    function schreiben(l) { try { speicher.setItem(SCHLUESSEL, JSON.stringify(l)); } catch (e) {} }
    function reihenfolge(a, b) { return a.zeit < b.zeit ? -1 : a.zeit > b.zeit ? 1 : 0; }
    function neu(e) { var l = lesen(); l.push(e); schreiben(l); return e; }
    function entfernen(s) { schreiben(lesen().filter(function (e) { return e.schluessel !== s; })); }
    function wartend(personId) {
      return lesen().filter(function (e) { return e.via === via && (!personId || e.person_id === personId); }).sort(reihenfolge);
    }
    function stempeln(personId, art) {
      return neu({ typ: 'stempeln', via: via, schluessel: uuid(), person_id: personId, art: art, zeit: new Date(jetzt()).toISOString() });
    }
    // Noch nicht gesendet: einfach weg. Schon beim Office (oder gerade unterwegs): Rücknahme hinten anstellen.
    function rueckgaengig(bezug, personId) {
      var l = lesen();
      var i = l.findIndex(function (e) { return e.schluessel === bezug && e.via === via; });
      if (i >= 0 && unterwegs !== bezug) { l.splice(i, 1); schreiben(l); return { weg: true }; }
      return neu({ typ: 'zuruecknehmen', via: via, schluessel: uuid(), person_id: personId, bezug_schluessel: bezug, zeit: new Date(jetzt()).toISOString() });
    }
    async function lauf(ergebnisse) {
      var liste = wartend();
      for (var k = 0; k < liste.length; k++) {
        var e = liste[k];
        if (!lesen().some(function (x) { return x.schluessel === e.schluessel; })) continue;   // inzwischen rückgängig gemacht
        var r;
        unterwegs = e.schluessel;
        try { r = await senden(e); } catch (err) { r = null; }
        unterwegs = null;
        var status = (r && r.status) || 0;
        if (status === 200) { entfernen(e.schluessel); ergebnisse.push({ eintrag: e, status: status, daten: r.daten || {} }); continue; }
        if (status === 0 || status === 429 || status >= 500) return 'netz';
        if (status === 401) return 'anmeldung';
        // Uhr des Geräts geht vor: Stempel bleibt liegen, beim nächsten Lauf hat die Zeit aufgeholt.
        if (status === 400 && r.daten && r.daten.fehler === 'zukunft') return 'uhr';
        // 400, 403, 404, 409: Dieser Stempel kommt so nie durch. Weg damit, die Seite zeigt den Grund.
        entfernen(e.schluessel);
        ergebnisse.push({ eintrag: e, status: status, daten: r.daten || {} });
      }
      return null;
    }
    function abarbeiten() {
      if (laeuft) { nochmal = true; return laeuft; }
      laeuft = (async function () {
        var ergebnisse = [], gestoppt;
        do { nochmal = false; gestoppt = await lauf(ergebnisse); } while (nochmal && !gestoppt);
        laeuft = null;
        return { ergebnisse: ergebnisse, gestoppt: gestoppt, wartend: wartend().length };
      })();
      return laeuft;
    }
    return { stempeln: stempeln, rueckgaengig: rueckgaengig, wartend: wartend, abarbeiten: abarbeiten };
  }

  var api = { SCHLUESSEL: SCHLUESSEL, warteschlange: warteschlange, vorlaeufig: vorlaeufig, knoepfe: knoepfe, standText: standText,
    vergessenText: vergessenText, bestaetigung: bestaetigung, fehlerText: fehlerText, wartendText: wartendText, uhrzeit: uhrzeit, dauerText: dauerText, tagVon: tagVon };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else wurzel.GNCZeit = api;
})(typeof window !== 'undefined' ? window : globalThis);
