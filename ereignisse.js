/**
 * ereignisse.js
 * ----------------------------------------------------------------------------
 * Ersatz für onclick="…" und Co., damit die Content-Security-Policy ohne
 * 'unsafe-inline' auskommt (Hashes und Kopfzeile: werkzeug/seiten-bauen.js).
 *
 * Im HTML steht statt  onclick="openCart()"  jetzt  data-on-click="openCart()".
 * Diese Datei hängt an jedes solche Element einen echten Listener, auch an
 * Elemente, die später per innerHTML dazukommen, und führt den Aufruf aus.
 *
 * Erlaubt ist eine kleine Sprache, kein JavaScript:
 *
 *   name(arg, …)               Funktion der Seite aufrufen
 *   event.preventDefault()     event.stopPropagation()
 *   return false               Standardaktion verhindern, wie beim alten onclick
 *   if (a === b) anweisung     Vergleich mit ===, !==, ==, !=
 *
 *   Werte: 'Text', "Text", Zahlen, true, false, null, undefined,
 *          this, event, this.feld, event.feld
 *   Mehrere Anweisungen mit ; trennen.
 *
 * Warum so eng: Wer HTML einschleust, kann damit höchstens eine vorhandene
 * Funktion der Seite per Klick auslösen. Eigener Code läuft nicht, eingebaute
 * Funktionen wie eval, open oder fetch sind gesperrt, und nichts lässt sich
 * auslesen.
 *
 * Aufgerufene Funktionen müssen am window hängen: function name() {} im
 * Seitenskript, nicht const name = () => {}.
 * ----------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var ARTEN = ['click', 'input', 'change', 'submit', 'keydown', 'error'];
  var AUSWAHL = ARTEN.map(function (a) { return '[data-on-' + a + ']'; }).join(',');

  /* ---- Zerlegen ------------------------------------------------------------ */
  function zerlegen(code) {
    var i = 0;
    var n = code.length;
    function fehler(was) { return new Error('data-on: ' + was + ' an Stelle ' + i + ' in "' + code + '"'); }
    function leer() { while (i < n && /\s/.test(code.charAt(i))) i++; }
    function wort(w) {
      leer();
      return code.substr(i, w.length) === w && !/[\w$]/.test(code.charAt(i + w.length));
    }
    function zeichen(z) { leer(); return code.charAt(i) === z; }
    function nimm(z) { if (!zeichen(z)) throw fehler(z + ' erwartet'); i++; }
    function name() {
      leer();
      var m = /^[A-Za-z_$][\w$]*/.exec(code.slice(i));
      if (!m) throw fehler('Name erwartet');
      i += m[0].length;
      return m[0];
    }
    function text(q) {
      var s = '';
      i++;
      while (i < n && code.charAt(i) !== q) {
        var c = code.charAt(i);
        if (c === '\\') {
          i++;
          c = code.charAt(i);
          s += c === 'n' ? '\n' : c === 't' ? '\t' : c;
        } else {
          s += c;
        }
        i++;
      }
      if (i >= n) throw fehler('Text nicht geschlossen');
      i++;
      return s;
    }
    function wert() {
      leer();
      var c = code.charAt(i);
      if (c === "'" || c === '"') return { w: text(c) };
      var zahl = /^-?\d+(\.\d+)?/.exec(code.slice(i));
      if (zahl) { i += zahl[0].length; return { w: Number(zahl[0]) }; }
      var nm = name();
      if (nm === 'true') return { w: true };
      if (nm === 'false') return { w: false };
      if (nm === 'null') return { w: null };
      if (nm === 'undefined') return { w: undefined };
      if (nm === 'this' || nm === 'event') {
        if (zeichen('.')) { i++; return { von: nm, feld: name() }; }
        return { von: nm };
      }
      throw fehler('unbekannter Wert ' + nm);
    }
    function anweisung() {
      if (wort('return')) { i += 6; return { art: 'zurueck', w: wert() }; }
      if (wort('if')) {
        i += 2;
        nimm('(');
        var a = wert();
        leer();
        var op = /^(===|!==|==|!=)/.exec(code.slice(i));
        if (!op) throw fehler('Vergleich erwartet');
        i += op[0].length;
        var b = wert();
        nimm(')');
        return { art: 'wenn', a: a, op: op[0], b: b, dann: anweisung() };
      }
      var fn = name();
      var feld = null;
      if (zeichen('.')) { i++; feld = name(); }
      nimm('(');
      var args = [];
      if (!zeichen(')')) {
        args.push(wert());
        while (zeichen(',')) { i++; args.push(wert()); }
      }
      nimm(')');
      return { art: 'ruf', fn: fn, feld: feld, args: args };
    }

    var liste = [];
    leer();
    while (i < n) {
      liste.push(anweisung());
      leer();
      if (i < n) { nimm(';'); leer(); }
    }
    return liste;
  }

  var zerlegt = new Map();
  function programm(code) {
    if (!zerlegt.has(code)) zerlegt.set(code, zerlegen(code));
    return zerlegt.get(code);
  }

  /* ---- Ausführen ----------------------------------------------------------- */
  var geprueft = new WeakMap();
  function seitenFunktion(name) {
    var f = window[name];
    if (typeof f !== 'function') return null;
    if (!geprueft.has(f)) geprueft.set(f, !/\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(f)));
    return geprueft.get(f) ? f : null;
  }

  function wertVon(w, el, ev) {
    if (!w.von) return w.w;
    var o = w.von === 'this' ? el : ev;
    return w.feld ? o[w.feld] : o;
  }

  function vergleich(a, el, ev) {
    var x = wertVon(a.a, el, ev);
    var y = wertVon(a.b, el, ev);
    if (a.op === '===') return x === y;
    if (a.op === '!==') return x !== y;
    if (a.op === '==') return x == y;   // eslint-disable-line eqeqeq
    return x != y;                      // eslint-disable-line eqeqeq
  }

  // Gibt { zurueck: wert } zurück, wenn die Anweisung "return" war
  function eine(a, el, ev) {
    if (a.art === 'wenn') return vergleich(a, el, ev) ? eine(a.dann, el, ev) : null;
    if (a.art === 'zurueck') return { zurueck: wertVon(a.w, el, ev) };
    var args = a.args.map(function (w) { return wertVon(w, el, ev); });
    if (a.feld) {
      if (a.fn === 'event' && (a.feld === 'preventDefault' || a.feld === 'stopPropagation')) { ev[a.feld](); return null; }
      throw new Error('data-on: ' + a.fn + '.' + a.feld + '() ist nicht erlaubt');
    }
    var f = seitenFunktion(a.fn);
    if (!f) throw new Error('data-on: ' + a.fn + ' ist keine Funktion der Seite');
    f.apply(undefined, args);   // wie ein gewöhnlicher Aufruf aus onclick heraus
    return null;
  }

  var HANDLER = {};
  ARTEN.forEach(function (art) {
    HANDLER[art] = function (ev) {
      var code = this.getAttribute('data-on-' + art);
      if (!code) return;
      var liste;
      try { liste = programm(code); } catch (e) { console.error(e.message); return; }
      for (var k = 0; k < liste.length; k++) {
        var r = eine(liste[k], this, ev);   // Fehler gehen wie früher in die Konsole
        if (r) {
          if (r.zurueck === false) ev.preventDefault();
          return;
        }
      }
    };
  });

  /* ---- Anbinden ------------------------------------------------------------ */
  // Dieselbe Funktion zweimal an dasselbe Element hängt der Browser nur einmal an.
  function binden(el) {
    for (var k = 0; k < ARTEN.length; k++) {
      if (el.hasAttribute('data-on-' + ARTEN[k])) el.addEventListener(ARTEN[k], HANDLER[ARTEN[k]]);
    }
  }
  function durchsuchen(wurzel) {
    if (wurzel.nodeType === 1 && wurzel.matches(AUSWAHL)) binden(wurzel);
    if (!wurzel.querySelectorAll) return;
    var liste = wurzel.querySelectorAll(AUSWAHL);
    for (var k = 0; k < liste.length; k++) binden(liste[k]);
  }

  // Steht im <head>: sieht jedes Element, sobald der Parser es einfügt, und
  // alles, was Skripte später einsetzen.
  new MutationObserver(function (aenderungen) {
    for (var a = 0; a < aenderungen.length; a++) {
      var m = aenderungen[a];
      if (m.type === 'attributes') binden(m.target);
      else for (var k = 0; k < m.addedNodes.length; k++) durchsuchen(m.addedNodes[k]);
    }
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ARTEN.map(function (a) { return 'data-on-' + a; }),
  });
  durchsuchen(document);
  document.addEventListener('DOMContentLoaded', function () { durchsuchen(document); });

  // Für werkzeug/csp-test.js
  window.gncEreignisse = { zerlegen: zerlegen };
})();
