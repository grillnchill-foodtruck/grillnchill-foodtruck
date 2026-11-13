/**
 * seitenkopf.js
 * ----------------------------------------------------------------------------
 * ERZEUGT von werkzeug/seiten-bauen.js aus werkzeug/seitenkopf-vorlage.js.
 * Nicht von Hand ändern: Die Öffnungszeiten (HOURS, DAY_OVERRIDES, Feiertage)
 * kopiert der Build bei jedem Deploy aus index.html. So zeigt die Pille auf
 * den Unterseiten nie andere Zeiten als die Startseite.
 *
 * Kopf der Unterseiten (Halal, Liefergebiet, Catering, Firmen, Gutscheine):
 *  - Status-Pille wie auf der Startseite: „Offen bis 20:30“, „Öffnet Mo 12:00“
 *  - Menü (<details>): schließt bei Escape, bei Tipp daneben und nach Linkwahl
 *  - weicher Schatten unter der Leiste, sobald Inhalt darunter liegt
 *  - in der App (?app=1, iOS-Brücke, Vollbild) führen Links zur Startseite
 *    nach /?app=1…, damit man nicht in der Website-Ansicht landet
 * ----------------------------------------------------------------------------
 */
(function () {
  'use strict';

  /*%OEFFNUNGSZEITEN%*/

  var kopf = document.getElementById('seitenkopf');
  if (!kopf) return;

  // Übersetzung nur, wo i18n.js geladen ist (/firmen); sonst Deutsch
  function tx(k, de) {
    if (typeof window.t === 'function') {
      try { var v = window.t(k); if (v && v !== k) return v; } catch (e) {}
    }
    return de;
  }
  function tag(dayIdx) {
    try {
      var loc = document.documentElement.lang || 'de';
      var s = new Intl.DateTimeFormat(loc, { weekday: 'short' }).format(new Date(2024, 0, 7 + dayIdx)).replace(/\.$/, '');
      return s.length > 4 ? s.slice(0, 3) : s;
    } catch (e) { return ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][dayIdx]; }
  }

  /* ---- Status-Pille ------------------------------------------------------ */
  function status() {
    var el = document.getElementById('skStatus');
    if (!el) return;
    try {
      var now = new Date();
      var mins = now.getHours() * 60 + now.getMinutes();
      var offen = false, h = null;
      if (!getNRWHoliday(now)) {
        h = hoursFor(now);
        if (h && mins >= parseTime(h.open) && mins < parseTime(h.close)) offen = true;
      }
      var lang, kurz;
      if (offen) {
        lang = tx('nav.open_until', 'Offen bis {time}').replace('{time}', h.close);
        kurz = tx('nav.open_short', 'Offen');
      } else {
        var nx = findNextOpening(now);
        if (nx && nx.offset === 0) lang = tx('nav.opens', 'Öffnet {time}').replace('{time}', nx.open);
        else if (nx) lang = tx('nav.opens_day', 'Öffnet {day} {time}').replace('{day}', tag(nx.dayIdx)).replace('{time}', nx.open);
        else lang = tx('nav.closed', 'Geschlossen');
        kurz = tx('nav.closed_short', 'Zu');
      }
      el.classList.toggle('offen', offen);
      el.querySelector('.sk-status-lang').textContent = lang;
      el.querySelector('.sk-status-kurz').textContent = kurz;
      el.setAttribute('aria-label', lang + ', ' + tx('nav.hours_all', 'Alle Zeiten'));
      el.hidden = false;
    } catch (e) { el.hidden = true; }
  }
  // Titel mit Umlaut brauchen mehr Zeilenabstand (seitenkopf.css, .sk-luft).
  // Für Deutsch steht die Klasse schon im HTML, nach einem Sprachwechsel
  // (/firmen) kann sich das ändern.
  var AKZENT = /[\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u017F]/;
  function luft() {
    Array.prototype.forEach.call(document.querySelectorAll('main h1, main h2'), function (h) {
      h.classList.toggle('sk-luft', AKZENT.test(h.textContent));
    });
  }
  status();
  setInterval(status, 60000);
  // Nach jedem Sprachwechsel (i18n.js meldet „gnc-sprache“) Pille und Titel neu
  // Store-Badges in der Fußzeile gibt es je Sprache (/badges/app-store-en.svg …)
  function badges() {
    var l = document.documentElement.lang || 'de';
    if (!/^(de|en|tr|it|es|pt|fr|nl)$/.test(l)) l = 'de';
    Array.prototype.forEach.call(document.querySelectorAll('img[data-badge]'), function (i) {
      var art = i.getAttribute('data-badge');
      var ziel = '/badges/' + art + '-' + l + (art === 'app-store' ? '.svg' : '.png');
      if (i.getAttribute('src') !== ziel) i.setAttribute('src', ziel);
    });
  }
  document.addEventListener('gnc-sprache', function () { status(); luft(); badges(); });
  // /firmen übersetzt schon vor diesem Skript (defer); kam „gnc-sprache“ vorher,
  // stünden Badges und Titel sonst in der falschen Sprache (Jury R4, firmen d-07).
  luft(); badges();
  // Übersetzung starten (i18n.js lädt das Sprachpaket bei Bedarf nach).
  // /firmen ruft initI18n selbst auf, der zweite Aufruf ist dann wirkungslos.
  if (typeof window.initI18n === 'function') window.initI18n();

  /* ---- Schatten beim Scrollen -------------------------------------------- */
  var zuletzt = null;
  function scroll() {
    var s = (window.scrollY || 0) > 4;
    if (s !== zuletzt) { zuletzt = s; kopf.classList.toggle('sk-gescrollt', s); }
  }
  window.addEventListener('scroll', scroll, { passive: true });
  scroll();

  /* ---- Menü -------------------------------------------------------------- */
  var menu = kopf.querySelector('.sk-menu');
  if (menu) {
    var knopf = menu.querySelector('summary');
    var beschriften = function () {
      knopf.setAttribute('aria-label', menu.open ? tx('a11y.menu_close', 'Menü schließen') : tx('a11y.menu_open', 'Menü öffnen'));
    };
    menu.addEventListener('toggle', beschriften);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menu.open) { menu.open = false; knopf.focus(); }
    });
    document.addEventListener('click', function (e) {
      if (menu.open && !menu.contains(e.target)) menu.open = false;
    });
    menu.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('a')) menu.open = false;
    });
    beschriften();
  }

  /* ---- App-Ansicht ------------------------------------------------------- */
  var mh = window.webkit && window.webkit.messageHandlers;
  var inApp = /[?&]app=1/.test(location.search) || !!(mh && (mh.gncTabs || mh['apple-login']))
    || !!(window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  if (inApp) {
    document.documentElement.classList.add('sk-app');
    var mitApp = function (h) {
      if (!h || h.charAt(0) !== '/' || /[?&]app=1/.test(h)) return h;
      var i = h.indexOf('#');
      var pfad = i < 0 ? h : h.slice(0, i), anker = i < 0 ? '' : h.slice(i);
      return pfad + (pfad.indexOf('?') < 0 ? '?' : '&') + 'app=1' + anker;
    };
    // Startseite überall, Unterseiten nur im Kopf
    Array.prototype.forEach.call(document.querySelectorAll('a[href="/"], a[href^="/#"]'), function (a) {
      a.setAttribute('href', mitApp(a.getAttribute('href')));
    });
    Array.prototype.forEach.call(kopf.querySelectorAll('a[href^="/"]'), function (a) {
      a.setAttribute('href', mitApp(a.getAttribute('href')));
    });
  }
})();
