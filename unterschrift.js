/* unterschrift.js
   Unterschriftsfeld für Catering-Angebote (angebot.html) und Anzeige im Admin (admin.html).
   Linienzug in einem Feld von 1000 × 300, ganze Zahlen. Kein Tempo, kein Druck: keine biometrischen Daten.
   Gleiche Grenzen wie auf dem Server (netlify/functions/lib/unterschrift.js). */
(function () {
  'use strict';
  var BREITE = 1000, HOEHE = 300, MIN_ABSTAND = 4, MAX_PUNKTE = 1200, MAX_STRICHE = 60, MIN_PUNKTE = 8;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  // Anzeige als SVG, Farbe über currentColor
  function svg(u, label) {
    if (!u) return '';
    var kopf = '<svg viewBox="0 0 ' + BREITE + ' ' + HOEHE + '" width="100%" style="display:block;height:auto" role="img" aria-label="' + esc(label || 'Unterschrift') + '">';
    if (u.getippt) {
      return kopf + '<text x="30" y="195" font-size="110" font-style="italic" font-family="Georgia, \'Times New Roman\', serif" fill="currentColor">' + esc(u.getippt) + '</text></svg>';
    }
    var d = (u.striche || []).map(function (s) {
      var p = 'M' + s[0] + ' ' + s[1];
      if (s.length === 2) return p + 'L' + s[0] + ' ' + s[1];
      for (var i = 2; i < s.length; i += 2) p += 'L' + s[i] + ' ' + s[i + 1];
      return p;
    }).join('');
    return kopf + '<path d="' + d + '" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  // Zeichenfeld: Pointer Events (Finger, Stift, Maus), Linie folgt sofort, Bögen über die Mittelpunkte
  function feld(canvas, opts) {
    opts = opts || {};
    var striche = [], aktuell = null, punkte = 0;
    var ctx = canvas.getContext('2d');

    function zeichneStrich(s, f) {
      ctx.beginPath();
      ctx.moveTo(s[0] * f, s[1] * f);
      if (s.length === 2) { ctx.lineTo(s[0] * f + 0.1, s[1] * f); ctx.stroke(); return; }
      for (var i = 2; i < s.length - 2; i += 2) {
        ctx.quadraticCurveTo(s[i] * f, s[i + 1] * f, (s[i] + s[i + 2]) / 2 * f, (s[i + 1] + s[i + 3]) / 2 * f);
      }
      ctx.lineTo(s[s.length - 2] * f, s[s.length - 1] * f);
      ctx.stroke();
    }
    function zeichneAlles() {
      var f = canvas.width / BREITE;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.lineWidth = 2.4 * (window.devicePixelRatio || 1);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = getComputedStyle(canvas).color;
      striche.forEach(function (s) { zeichneStrich(s, f); });
    }
    function groesse() {
      var r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      zeichneAlles();
    }
    function punkt(ev) {
      var r = canvas.getBoundingClientRect();
      var x = Math.round((ev.clientX - r.left) / r.width * BREITE), y = Math.round((ev.clientY - r.top) / r.height * HOEHE);
      return [Math.max(0, Math.min(BREITE, x)), Math.max(0, Math.min(HOEHE, y))];
    }
    function unten(ev) {
      if (ev.pointerType === 'mouse' && ev.button !== 0) return;
      if (striche.length >= MAX_STRICHE || punkte >= MAX_PUNKTE) return;
      ev.preventDefault();
      try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* ohne Capture weiter */ }
      var p = punkt(ev);
      aktuell = [p[0], p[1]];
      striche.push(aktuell);
      punkte++;
      zeichneAlles();
      if (opts.beiAenderung) opts.beiAenderung();
    }
    function bewegen(ev) {
      if (!aktuell || punkte >= MAX_PUNKTE) return;
      var p = punkt(ev), lx = aktuell[aktuell.length - 2], ly = aktuell[aktuell.length - 1];
      if (Math.abs(p[0] - lx) + Math.abs(p[1] - ly) < MIN_ABSTAND) return;
      aktuell.push(p[0], p[1]);
      punkte++;
      zeichneAlles();
    }
    function ende() { aktuell = null; }

    canvas.addEventListener('pointerdown', unten);
    canvas.addEventListener('pointermove', bewegen);
    canvas.addEventListener('pointerup', ende);
    canvas.addEventListener('pointercancel', ende);
    window.addEventListener('resize', groesse);
    groesse();

    return {
      // null, solange es keine Unterschrift ist (zu wenig Punkte oder winzig): gleiche Regel wie der Server
      daten: function () {
        if (punkte < MIN_PUNKTE) return null;
        var minX = BREITE, maxX = 0, minY = HOEHE, maxY = 0;
        striche.forEach(function (s) {
          for (var i = 0; i < s.length; i += 2) {
            minX = Math.min(minX, s[i]); maxX = Math.max(maxX, s[i]); minY = Math.min(minY, s[i + 1]); maxY = Math.max(maxY, s[i + 1]);
          }
        });
        if (maxX - minX < 60 && maxY - minY < 30) return null;
        return { striche: striche.map(function (s) { return s.slice(); }) };
      },
      striche: function () { return striche; },
      setzen: function (s) {
        striche = (s || []).map(function (x) { return x.slice(); });
        punkte = striche.reduce(function (n, x) { return n + x.length / 2; }, 0);
        zeichneAlles();
      },
      leeren: function () {
        striche = []; punkte = 0; aktuell = null;
        zeichneAlles();
        if (opts.beiAenderung) opts.beiAenderung();
      },
      abbauen: function () { window.removeEventListener('resize', groesse); },
    };
  }

  window.GNCUnterschrift = { svg: svg, feld: feld };
})();
