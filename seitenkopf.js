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

  /* ---- Öffnungszeiten, kopiert aus index.html ---- */
  const HOURS = {
    0: null, // Sonntag
    1: { open: '12:00', close: '20:30' },
    2: { open: '12:00', close: '20:30' },
    3: { open: '12:00', close: '20:30' },
    4: { open: '12:00', close: '20:30' },
    5: { open: '12:00', close: '20:30', deliveryFrom: '14:30' }, // Freitag: Lieferung erst ab 14:30, Abholung ab Öffnung
    6: { open: '12:00', close: '20:30' },
  };

  // Einmalige Tages-Ausnahmen (lokales Datum YYYY-MM-TT). Überschreibt die regulären
  // Öffnungszeiten NUR für den genannten Tag und läuft danach automatisch ab.
  // pickupOnly:true → an diesem Tag ist ausschließlich Abholung möglich (Lieferung aus).
  const DAY_OVERRIDES = {
    '2026-06-27': { open: '17:00', close: '20:30', pickupOnly: true }, // Sa 27.06.: Ausnahme – erst ab 17 Uhr, nur Abholung
  };
  function dateKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // Öffnungszeiten für ein Datum unter Berücksichtigung der Ausnahmen
  function hoursFor(d) {
    const ov = DAY_OVERRIDES[dateKey(d)];
    if (ov) return { open: ov.open, close: ov.close };
    return HOURS[d.getDay()];
  }
  // Ist an diesem Datum nur Abholung erlaubt?
  function pickupOnlyFor(d) {
    const ov = DAY_OVERRIDES[dateKey(d)];
    return !!(ov && ov.pickupOnly);
  }
  // Frühester Lieferzeitpunkt ("HH:MM") an einem Datum – Tages-Ausnahmen ersetzen die Regel
  function deliveryFromFor(d) {
    const ov = DAY_OVERRIDES[dateKey(d)];
    if (ov) return ov.open;
    const h = HOURS[d.getDay()];
    return h ? (h.deliveryFrom || h.open) : null;
  }

  // Berechnet Ostersonntag (Gauß'sche Osterformel) für ein Jahr → {month, day}
  function getEasterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=März, 4=April
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return { month: month - 1, day }; // month 0-indexiert für JS Date
  }

  // Prüft, ob ein Date ein gesetzlicher Feiertag in NRW ist. Rückgabe: Feiertagsname oder null
  function getNRWHoliday(date) {
    const y = date.getFullYear();
    const mo = date.getMonth(); // 0-indexiert
    const d = date.getDate();
    const key = `${mo}-${d}`;

    // Feste Feiertage in NRW (gesetzlich)
    const fixed = {
      '0-1':   'Neujahr',
      '4-1':   'Tag der Arbeit',
      '9-3':   'Tag der Deutschen Einheit',
      '10-1':  'Allerheiligen',
      '11-25': '1. Weihnachtstag',
      '11-26': '2. Weihnachtstag',
    };
    if (fixed[key]) return fixed[key];

    // Bewegliche Feiertage (abhängig von Ostern)
    const easter = getEasterSunday(y);
    const easterDate = new Date(y, easter.month, easter.day);
    const offsets = {
      '-2': 'Karfreitag',
      '1':  'Ostermontag',
      '39': 'Christi Himmelfahrt',
      '50': 'Pfingstmontag',
      '60': 'Fronleichnam',
    };
    for (const [off, name] of Object.entries(offsets)) {
      const fd = new Date(easterDate);
      fd.setDate(fd.getDate() + parseInt(off));
      if (fd.getMonth() === mo && fd.getDate() === d) return name;
    }
    return null;
  }

  function parseTime(str) {
    const [h, m] = str.split(':').map(Number);
    return h * 60 + m;
  }

  function findNextOpening(now) {
    const day = now.getDay();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const todayH = hoursFor(now);
    if (todayH && !getNRWHoliday(now) && nowMin < parseTime(todayH.open)) {
      return { offset: 0, dayIdx: day, open: todayH.open };
    }
    for (let i = 1; i <= 9; i++) {
      const d = new Date(now); d.setDate(now.getDate() + i);
      const di = d.getDay();
      const dh = hoursFor(d);
      if (dh && !getNRWHoliday(d)) return { offset: i, dayIdx: di, open: dh.open };
    }
    return null;
  }

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
  document.addEventListener('gnc-sprache', function () { status(); luft(); });
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
