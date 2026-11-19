/**
 * feinschliff.js – Verhalten zu feinschliff.css (19.11.2026)
 * ----------------------------------------------------------------------------
 * 1. Sheets wegziehen: Menü-Baukasten, Dip-Auswahl, Rechtstexte, Konto und
 *    Gruppenbestellung sind auf dem Handy Bottom-Sheets. Ganz oben im Inhalt
 *    nach unten ziehen schiebt das Sheet mit dem Finger mit (1:1), beim
 *    Loslassen entscheiden Weg und Schwung: schließen oder zurückfedern.
 *    Greift man ein laufendes Zurückfedern, übernimmt die Geste den
 *    aktuellen Stand (unterbrechbar). Nach oben gibt es Gummiband-Widerstand.
 *    Feder und Gummiband teilt sich das mit dem Warenkorb (window.__gncMotion).
 * 2. Einmalcodes (autocomplete="one-time-code"): nur Ziffern, eingefügte Codes
 *    mit Leerzeichen werden gesäubert, bei 6 Ziffern bestätigt das Feld von
 *    selbst, Enter bestätigt ebenfalls.
 * ----------------------------------------------------------------------------
 */
(function () {
  'use strict';

  /* ---- 1. Sheets wegziehen --------------------------------------------- */
  var SHEETS = [
    { ov: 'upsellOverlay', sheet: '.upsell-modal', zu: 'closeUpsell' },
    { ov: 'dipOverlay', sheet: '.upsell-modal', zu: 'closeDipConfig' },
    { ov: 'modalOverlay', sheet: '.modal', zu: 'closeModal' },
    { ov: 'accountOverlay', sheet: ':scope > div', zu: 'closeAccountOverlay' },
    { ov: 'groupOverlay', sheet: ':scope > div', zu: 'closeGroupOverlay' },
  ];
  var schmal = window.matchMedia ? matchMedia('(max-width: 640px)') : { matches: false };
  var HYST = 10, FLICK_V = 700, FLICK_MIN = 40, VMAX = 4000;

  function sheetEinrichten(cfg) {
    var ov = document.getElementById(cfg.ov);
    if (!ov) return;
    var sheet = ov.querySelector(cfg.sheet);
    if (!sheet) return;
    var g = null, stopp = null, y = 0, grund = null;

    function M() { return window.__gncMotion || {}; }
    function hoehe() { return sheet.getBoundingClientRect().height || window.innerHeight; }
    function malen(wert) {
      y = wert;
      sheet.style.transform = wert ? 'translate3d(0,' + wert + 'px,0)' : '';
      // Der Schleier lichtet sich mit dem Weg, Rückmeldung während der Geste
      var anteil = Math.max(0, Math.min(1, wert / hoehe()));
      ov.style.transition = 'none';
      ov.style.opacity = wert > 0 ? String(1 - anteil * 0.85) : '';
    }
    function aufraeumen() {
      sheet.classList.remove('sheet-zieht');
      sheet.style.transform = '';
      ov.style.opacity = '';
      ov.style.transition = '';
      y = 0;
    }

    sheet.addEventListener('touchstart', function (e) {
      if (!schmal.matches || e.touches.length !== 1) return;
      if (stopp) { stopp(); stopp = null; }        // laufende Feder greifen
      var p = e.touches[0];
      g = { x: p.clientX, y: p.clientY, basis: y, scharf: false, aus: false, verlauf: [{ y: p.clientY, t: performance.now() }] };
    }, { passive: true });

    sheet.addEventListener('touchmove', function (e) {
      if (!g || g.aus) return;
      var p = e.touches[0], dx = p.clientX - g.x, dy = p.clientY - g.y;
      if (!g.scharf) {
        if (Math.abs(dx) < HYST && Math.abs(dy) < HYST) return;
        // Nur nach unten, nur wenn der Inhalt oben steht, nicht in Feldern
        var feld = e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"]');
        if (Math.abs(dx) > Math.abs(dy) || (dy < 0 && g.basis === 0) || sheet.scrollTop > 0 || feld) { g.aus = true; return; }
        g.scharf = true;
        g.y = p.clientY;                          // ab hier 1:1, ohne Sprung um die Hysterese
        sheet.classList.add('sheet-zieht');
        dy = 0;
      }
      e.preventDefault();
      var wert = g.basis + dy;
      if (wert < 0) wert = M().rubber ? -M().rubber(-wert, hoehe()) : wert * 0.3;
      malen(wert);
      var jetzt = performance.now(), letzter = g.verlauf[g.verlauf.length - 1];
      if (jetzt - letzter.t >= 25) { g.verlauf.push({ y: p.clientY, t: jetzt }); if (g.verlauf.length > 5) g.verlauf.shift(); }
    }, { passive: false });

    function ende() {
      if (!g) return;
      var geste = g; g = null;
      if (!geste.scharf) return;
      var a = geste.verlauf[0], b = geste.verlauf[geste.verlauf.length - 1];
      var v = b.t > a.t ? Math.max(-VMAX, Math.min(VMAX, (b.y - a.y) / (b.t - a.t) * 1000)) : 0;
      var h = hoehe();
      var zu = y > h * 0.33 || (v >= FLICK_V && y >= FLICK_MIN);
      var feder = M().spring;
      if (zu) {
        if (window.hapticTick) window.hapticTick(10);
        var fertig = function () {
          if (typeof window[cfg.zu] === 'function') window[cfg.zu]();
          // Erst aufräumen, wenn das Fenster zu ist, sonst blitzt es kurz auf
          setTimeout(aufraeumen, 260);
        };
        if (feder) stopp = feder(y, h, Math.max(v, 0), malen, fertig); else { malen(h); fertig(); }
      } else if (feder) {
        stopp = feder(y, 0, v, malen, function () { stopp = null; aufraeumen(); });
      } else { aufraeumen(); }
    }
    sheet.addEventListener('touchend', ende, { passive: true });
    sheet.addEventListener('touchcancel', ende, { passive: true });
  }

  function sheetsStart() { SHEETS.forEach(sheetEinrichten); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sheetsStart); else sheetsStart();

  /* ---- 2. Einmalcodes ---------------------------------------------------- */
  var CODE = 'input[autocomplete="one-time-code"]';
  function bestaetigenKnopf(feld) {
    for (var n = feld.nextElementSibling; n; n = n.nextElementSibling) {
      if (n.matches('button')) return n;
      var b = n.querySelector && n.querySelector('button');
      if (b) return b;
    }
    return null;
  }
  function bestaetigen(feld) {
    var k = bestaetigenKnopf(feld);
    if (k && !k.disabled && !k.classList.contains('is-busy')) k.click();
  }
  document.addEventListener('focusin', function (e) {
    var f = e.target;
    if (!f.matches || !f.matches(CODE)) return;
    f.setAttribute('enterkeyhint', 'go');
    f.setAttribute('autocapitalize', 'off');
    f.setAttribute('spellcheck', 'false');
    if (!f.getAttribute('pattern')) f.setAttribute('pattern', '[0-9]*');
    // Platz für eingefügte Codes wie „123 456“: Der Browser würde sie sonst
    // vor dem Säubern auf 6 Zeichen kürzen („123 45“)
    if (f.maxLength > 0 && f.maxLength < 12) f.maxLength = 12;
  });
  document.addEventListener('input', function (e) {
    var f = e.target;
    if (!f.matches || !f.matches(CODE)) return;
    var ziffern = f.value.replace(/\D/g, '').slice(0, 6);
    if (ziffern !== f.value) f.value = ziffern;
    if (ziffern.length === 6) {
      if (f.dataset.gncCode !== ziffern) {           // denselben Code nicht zweimal schicken
        f.dataset.gncCode = ziffern;
        setTimeout(function () { bestaetigen(f); }, 80);
      }
    } else {
      delete f.dataset.gncCode;
    }
  });
  document.addEventListener('keydown', function (e) {
    var f = e.target;
    if (e.key === 'Enter' && f.matches && f.matches(CODE)) { e.preventDefault(); bestaetigen(f); }
  });
})();
