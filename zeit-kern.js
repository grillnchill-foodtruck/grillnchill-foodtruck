/* ============================================================================
   zeit-kern.js
   Gemeinsamer Kern fürs Stempeln am iPad (cockpit.html mit zeit-stempeln.js) und am Handy (zeit.html mit
   zeit-handy.js): Warteschlange, vorläufiger Stand, Texte und Knöpfe. Ohne DOM, deshalb auch in Node testbar
   (werkzeug/zeit-kern-test.js). Server: netlify/functions/zeit.js.

   Warteschlange (localStorage gnc_zeit_warteschlange): Jeder Stempel bekommt sofort einen Schlüssel (UUID v4), die
   Gerätezeit und einen Zähler (nr) und wird gleich gesendet. Gesendet wird in der Reihenfolge des Zählers, dann der
   Gerätezeit: Auf einem Gerät ist die Einfüge-Reihenfolge die echte, auch wenn die Uhr springt. via trennt iPad
   ('stempeluhr') und Handy ('handy'), falls beide im selben Browser laufen.
   Verloren geht nichts (MiLoG § 17). Was mit einer Antwort passiert:
     200                      raus aus der Schlange
     Status 0, 429, 5xx oder jeder Status ohne Fehlercode (z. B. HTML-404)   bleibt liegen, Lauf stoppt mit 'netz'
     401                      bleibt liegen, Lauf stoppt mit 'anmeldung'
     400 zukunft              bleibt liegen, Lauf stoppt mit 'uhr'
     400 zukunft, Uhr schon korrigiert (Stempel liegt mehr als 2 Minuten nach der Gerätezeit)   wie ein anderer Code: abgelehnt
     endgültige Codes (nur zustand, nicht_zuruecknehmbar, schluessel_anders)
                              raus aus der Schlange, Grund in den Ergebnissen, Lauf geht weiter
     jeder andere Fehlercode  bleibt im selben Array (gleicher Schlüssel), markiert mit abgelehnt { status, fehler, am }. Die Seite
                              zeigt sie mit Grund und "Nochmal senden" (erneut). Lauf geht weiter.
   Fehlercode = daten.fehler || daten.error. Scheitert das Schreiben in den localStorage, hält die Seite eine Kopie im
   Speicher: Der Stempel wird trotzdem gesendet, stempeln meldet gespeichert: false.
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
    schluessel_anders: 'Dieser Stempel ist schon gespeichert.',
    fremde_person: 'Du kannst nur für dich selbst stempeln.',
    person_fehlt: 'Dieser Stempel wurde nicht gespeichert. Bitte Kubi, im Dienstplan zu prüfen, ob du dort noch eingetragen bist.',
    too_many_requests: 'Gerade zu viele Anfragen. Versuch es gleich noch einmal.',
    zukunft: 'Die Uhr dieses Geräts geht vor. Der Stempel wartet und geht raus, sobald die echte Uhrzeit ihn eingeholt hat.',
    speicher: 'Dieses Gerät kann gerade nichts speichern. Der Stempel geht raus, solange die Seite offen bleibt.',
  };
  // hint: Text für keine_person; bei nicht_zuruecknehmbar 'abgelehnt' (der Stempel war ohnehin abgelehnt, also kein Hinweis auf Kubi)
  function fehlerText(code, hint) {
    if (code === 'keine_person' && hint) return hint;
    if (code === 'nicht_zuruecknehmbar' && hint === 'abgelehnt') return 'Rückgängig geht nicht mehr. Der Stempel war ohnehin abgelehnt.';
    return FEHLER[code] || 'Das hat nicht geklappt. Versuch es noch einmal.';
  }
  function wartendText(n) { return 'Gespeichert, wird übertragen (' + n + ' wartend).'; }

  // Eine offene Schicht über 16 Stunden gilt als vergessen (wie im Office, functions/_lib/zeit.js)
  var VERGESSEN_MS = 16 * 60 * 60 * 1000;
  function alsMs(t) { return typeof t === 'number' ? t : Date.parse(t instanceof Date ? t.toISOString() : t); }

  // Letzter bekannter Stand plus wartende Stempel dieser Person. jetzt (ms, Date oder ISO) ist optional.
  function vorlaeufig(stand, eintraege, jetzt) {
    var s = Object.assign({ zustand: 'frei', seit: null, beginn: null, vergessen: null }, stand || {});
    var liste = eintraege || [];
    var zurueck = {}, rueck = false;
    liste.forEach(function (e) { if (e && e.typ === 'zuruecknehmen' && e.bezug_schluessel) { zurueck[e.bezug_schluessel] = true; rueck = true; } });
    liste.forEach(function (e) {
      if (e.typ !== 'stempeln' || zurueck[e.schluessel]) return;   // Stempel samt wartender Rücknahme zählt nicht
      if (e.art === 'beginn') s = Object.assign({}, s, { zustand: 'im_dienst', seit: e.zeit, beginn: e.zeit, vergessen: null });
      else if (e.art === 'pause_beginn') s = Object.assign({}, s, { zustand: 'pause', seit: e.zeit });
      else if (e.art === 'pause_ende') s = Object.assign({}, s, { zustand: 'im_dienst', seit: s.beginn || e.zeit });
      else if (e.art === 'ende') s = Object.assign({}, s, { zustand: 'frei', seit: null, beginn: null });
    });
    if (jetzt != null && s.zustand !== 'frei' && s.beginn && alsMs(jetzt) - Date.parse(s.beginn) >= VERGESSEN_MS) {
      s = Object.assign({}, s, { zustand: 'frei', seit: null, beginn: null, vergessen: { beginn: s.beginn, tag: tagVon(s.beginn) } });
    }
    // rueckgaengig: Eine Rücknahme wartet (auch für einen schon übertragenen Stempel, dessen Wirkung im Stand steckt). Die Seiten zeigen den Hinweis.
    return Object.assign(s, { wartend: liste.length, rueckgaengig: rueck });
  }

  // UUID v4; ohne crypto.randomUUID (vor iOS/iPadOS 15.4) aus getRandomValues
  function uuidV4(c) {
    c = c || (typeof crypto !== 'undefined' ? crypto : null);
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    var b = new Uint8Array(16);
    if (c && c.getRandomValues) c.getRandomValues(b);
    else for (var i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  var ENDGUELTIG = { zustand: 1, nicht_zuruecknehmbar: 1, schluessel_anders: 1 };
  var istEndgueltig = function (code) { return Object.prototype.hasOwnProperty.call(ENDGUELTIG, code); };
  var UHR_TOLERANZ_MS = 2 * 60 * 1000;
  /* o: { speicher (localStorage), via, senden(eintrag) -> Promise<{ status, daten }>, jetzt?, uuid? }
     Schnittstelle: stempeln, rueckgaengig, wartend, abgelehnt, erneut, verwerfen, abarbeiten.
     Alles liegt in EINEM Array unter einem Schlüssel; ein abgelehnter Eintrag trägt das Feld abgelehnt { status, fehler, am }.
     So braucht jede Änderung genau einen Schreibvorgang und nichts fällt zwischen zwei Speicherorte. */
  function warteschlange(o) {
    var speicher = o.speicher, via = o.via, senden = o.senden;
    var jetzt = o.jetzt || function () { return Date.now(); };
    var uuid = o.uuid || function () { return uuidV4(); };
    var laeuft = null, laufPerson = null, nochmal = false, unterwegs = null, letzter = null;
    // Kopie im Speicher der Seite. Maßgeblich, solange der localStorage nicht lesbar oder nicht beschreibbar ist.
    var kopie = { liste: [], massgeblich: false };

    function lesen() {
      if (kopie.massgeblich) return kopie.liste.slice();
      try {
        var l = JSON.parse(speicher.getItem(SCHLUESSEL) || '[]');
        if (!Array.isArray(l)) return kopie.liste.slice();
        var da = {};
        kopie.liste = l.filter(function (e) {
          if (!e || typeof e !== 'object' || typeof e.schluessel !== 'string' || da[e.schluessel]) return false;
          da[e.schluessel] = true; return true;
        });
        return kopie.liste.slice();
      } catch (e) { return kopie.liste.slice(); }
    }
    // true, wenn der localStorage den Stand hält. Sonst gilt die Kopie, bis ein Schreiben klappt.
    function schreiben(l) {
      kopie.liste = l.slice();
      try { speicher.setItem(SCHLUESSEL, JSON.stringify(l)); kopie.massgeblich = false; return true; } catch (e) { kopie.massgeblich = true; return false; }
    }
    function reihenfolge(a, b) {
      var x = a.nr || 0, y = b.nr || 0;
      if (x !== y) return x - y;
      return a.zeit < b.zeit ? -1 : a.zeit > b.zeit ? 1 : 0;
    }
    function naechsteNr() {
      var m = 0;
      lesen().forEach(function (e) { if ((e.nr || 0) > m) m = e.nr; });
      return m + 1;
    }
    function neu(e) {
      e.nr = naechsteNr();
      var l = lesen(); l.push(e);
      var gespeichert = schreiben(l);
      return Object.assign({}, e, { gespeichert: gespeichert });
    }
    function ohneSchluessel(l, s) { return l.filter(function (e) { return e.schluessel !== s; }); }
    function entfernen(s) { return schreiben(ohneSchluessel(lesen(), s)); }
    // Zurück auf den alten Stand, wenn ein Schreiben nicht klappte (die Kopie bleibt maßgeblich)
    function zurueck(l) { kopie.liste = l.slice(); return false; }
    function eigene(e) { return e.via === via; }
    function wartend(personId) {
      return lesen().filter(function (e) { return eigene(e) && !e.abgelehnt && (!personId || e.person_id === personId); }).sort(reihenfolge);
    }
    // Eintrag plus status, fehler, am
    function abgelehnt() {
      return lesen().filter(function (e) { return eigene(e) && e.abgelehnt; }).sort(reihenfolge).map(function (e) {
        var r = Object.assign({}, e, e.abgelehnt); delete r.abgelehnt; return r;
      });
    }
    function stempeln(personId, art) {
      return neu({ typ: 'stempeln', via: via, schluessel: uuid(), person_id: personId, art: art, zeit: new Date(jetzt()).toISOString() });
    }
    // Nie versucht zu senden: einfach weg (nur wenn das Schreiben klappt). Schon versucht (versucht: true, auch wenn die
    // Antwort verloren ging), gerade unterwegs oder nicht sicher gelöscht: Rücknahme hinten anstellen, der Lauf sendet
    // erst den Stempel (gleicher Schlüssel, gleiches Ergebnis), dann die Rücknahme. Schon abgelehnt: entfernen, keine Rücknahme.
    function rueckgaengig(bezug, personId) {
      var l = lesen();
      var e = l.filter(function (x) { return x.schluessel === bezug && eigene(x); })[0];
      if (e && e.abgelehnt) {
        if (schreiben(ohneSchluessel(l, bezug))) return { weg: true };
        zurueck(l);
        return { weg: false, grund: 'speicher' };
      }
      if (e && unterwegs !== bezug && !e.versucht) {
        if (schreiben(ohneSchluessel(l, bezug))) return { weg: true };
        zurueck(l);   // Löschen nicht sicher: alten Stand halten
      }
      return neu({ typ: 'zuruecknehmen', via: via, schluessel: uuid(), person_id: personId, bezug_schluessel: bezug, zeit: new Date(jetzt()).toISOString() });
    }
    // Endgültig aus "abgelehnt" entfernen (z. B. weil Kubi die Zeit im Office nachgetragen hat). true, wenn gelöscht.
    function verwerfen(schluessel) {
      var l = lesen();
      if (!l.some(function (e) { return e.schluessel === schluessel && eigene(e) && e.abgelehnt; })) return false;
      if (schreiben(ohneSchluessel(l, schluessel))) return true;
      return zurueck(l);
    }
    // Abgelehnten Eintrag wieder in die Warteschlange (Schlüssel, Gerätezeit und nr bleiben) und senden. Promise: Ergebnis von abarbeiten, null wenn unbekannt.
    function erneut(schluessel, opt) {
      var l = lesen(), gefunden = false;
      var neuL = l.map(function (e) {
        if (e.schluessel !== schluessel || !eigene(e) || !e.abgelehnt) return e;
        if (opt && opt.person && e.person_id !== opt.person) return e;   // fremder Eintrag bleibt abgelehnt
        gefunden = true; var r = Object.assign({}, e); delete r.abgelehnt; return r;
      });
      if (!gefunden) return Promise.resolve(null);
      schreiben(neuL);
      return abarbeiten(opt);
    }
    function ablehnen(e, status, code, hint) {
      var a = { status: status, fehler: code, am: new Date(jetzt()).toISOString() };
      if (hint) a.hint = hint;
      schreiben(lesen().map(function (x) {
        return x.schluessel === e.schluessel ? Object.assign({}, x, { abgelehnt: a }) : x;
      }));
    }
    async function lauf(ergebnisse, person) {
      var gesehen = {};
      for (;;) {
        // Immer den nächsten noch nicht versuchten Eintrag frisch aus der Schlange: Was während des Sendens
        // dazukommt (Rücknahme), geht im selben Lauf raus. Rückgängig gemachte Einträge sind schon weg.
        var e = wartend(person).filter(function (x) { return !gesehen[x.schluessel]; })[0];
        if (!e) break;
        gesehen[e.schluessel] = true;
        // Vor dem ersten Senden markieren (ein Schreibvorgang): Ging die Antwort verloren, weiß rueckgaengig, dass das Office ihn haben kann.
        if (!e.versucht) {
          schreiben(lesen().map(function (x) { return x.schluessel === e.schluessel ? Object.assign({}, x, { versucht: true }) : x; }));
        }
        var r;
        unterwegs = e.schluessel; letzter = e.schluessel;
        try { r = await senden(e); } catch (err) { r = null; } finally { unterwegs = null; }
        var status = (r && r.status) || 0;
        var daten = (r && r.daten) || {};
        var code = daten.fehler || daten.error;
        if (status === 200) { entfernen(e.schluessel); ergebnisse.push({ eintrag: e, status: status, daten: daten }); continue; }
        if (status === 0 || status === 429 || status >= 500) return 'netz';
        if (status === 401) return 'anmeldung';
        // Uhr des Geräts geht vor: Stempel bleibt liegen, beim nächsten Lauf hat die Zeit aufgeholt.
        if (status === 400 && code === 'zukunft') {
          // Uhr inzwischen korrigiert: Der Stempel liegt weit nach der Gerätezeit und käme nie durch. Nicht den Rest blockieren.
          if (Date.parse(e.zeit) - jetzt() > UHR_TOLERANZ_MS) {
            ablehnen(e, status, code);
            ergebnisse.push({ eintrag: e, status: status, daten: daten, abgelehnt: true });
            continue;
          }
          return 'uhr';
        }
        // Keine Antwort des Servers (HTML-404 der Sammelregel, 204, 408, 413 ohne JSON): bleibt liegen.
        if (!code) return 'netz';
        if (istEndgueltig(code)) { entfernen(e.schluessel); ergebnisse.push({ eintrag: e, status: status, daten: daten }); continue; }
        // Unbekannter Grund: nicht wegwerfen. Der Eintrag bleibt im selben Array und trägt das Feld abgelehnt.
        ablehnen(e, status, code, typeof daten.hint === 'string' ? daten.hint : '');
        ergebnisse.push({ eintrag: e, status: status, daten: daten, abgelehnt: true });
      }
      return null;
    }
    // opt.person: nur wartende Einträge dieser person_id senden, die anderen bleiben unberührt liegen (geteiltes Handy).
    // Ohne Option alle. Läuft schon ein Lauf für eine andere Person, folgt dieser danach.
    function abarbeiten(opt) {
      var person = (opt && opt.person) || null;
      if (laeuft && laufPerson !== person) { return laeuft.then(function () { return abarbeiten(opt); }); }
      if (laeuft) { nochmal = true; return laeuft; }
      laufPerson = person;
      laeuft = (async function () {
        var ergebnisse = [], gestoppt;
        letzter = null;
        try {
          do { nochmal = false; gestoppt = await lauf(ergebnisse, person); } while (nochmal && !gestoppt);
        } catch (err) {
          // Alles bleibt liegen, der nächste Lauf versucht es wieder. Nur der Schlüssel ins Log, keine Personendaten.
          if (typeof console !== 'undefined' && console.error) console.error('zeit-kern: Lauf abgebrochen bei ' + letzter + ': ' + (err && err.message));
          gestoppt = 'netz';
        }   // unerwarteter Fehler: alles bleibt liegen, der nächste Lauf versucht es wieder
        finally { laeuft = null; laufPerson = null; unterwegs = null; }
        return { ergebnisse: ergebnisse, gestoppt: gestoppt, wartend: wartend().length };
      })();
      return laeuft;
    }
    return { stempeln: stempeln, rueckgaengig: rueckgaengig, wartend: wartend, abgelehnt: abgelehnt, erneut: erneut, verwerfen: verwerfen, abarbeiten: abarbeiten };
  }

  var api = { SCHLUESSEL: SCHLUESSEL, uuidV4: uuidV4, warteschlange: warteschlange, vorlaeufig: vorlaeufig, knoepfe: knoepfe, standText: standText,
    vergessenText: vergessenText, bestaetigung: bestaetigung, fehlerText: fehlerText, wartendText: wartendText, uhrzeit: uhrzeit, dauerText: dauerText, tagVon: tagVon };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else wurzel.GNCZeit = api;
})(typeof window !== 'undefined' ? window : globalThis);
