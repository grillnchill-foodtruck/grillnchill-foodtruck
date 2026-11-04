/**
 * app-leiste.js
 * ----------------------------------------------------------------------------
 * Rückweg in die App-Ansicht für Unterseiten, die die App in ihrer eigenen
 * Web-Ansicht öffnet (Statusseite, Team-Seiten).
 *
 * Die iOS-App blendet ihre Glas-Leiste bei jedem Seitenwechsel aus. Erst eine
 * Seite, die sie mit „configure“ anmeldet, holt sie zurück. Ohne das sitzt man
 * auf der Unterseite fest, und ein Link auf „/“ (ohne ?app=1) öffnet die
 * Website-Ansicht statt der App. Die Startseite merkt sich ihre Tabs in
 * localStorage gnc_ntb_tabs, hier erscheint dieselbe Leiste.
 *
 *   GNCAppLeiste.start({
 *     zurueck: ['id', …],   Links, die in der App erscheinen und nach /?app=1 führen
 *     marke:   ['id', …],   Logo-Links: in der App nach /?app=1 statt /
 *     text:    'Zurück',    Beschriftung für [data-text] im Zurück-Link
 *     tabs:    [ … ],       Ersatz, falls die Startseite noch keine Tabs gemerkt hat
 *     verdeckt: '.a, .b',   solange so ein Element da ist, weicht die Leiste
 *                           (Menü, Dialoge, Speichern-Leiste am unteren Rand)
 *     modus:   'team',      Team-Leiste statt Kunden-Leiste (siehe TEAM)
 *     selected: 'cockpit',  markierter Tab der Team-Leiste
 *     lokal:   fn(id),      true = Tab auf der Seite selbst erledigt (kein Seitenwechsel)
 *     vorWechsel: fn(id),   false = Wechsel abbrechen (z. B. Fahrt mit Live-Standort)
 *   })  -> { waehle(id) }   markierten Tab nachträglich setzen
 *
 * Team-Leiste (Admin, Cockpit, Fahrer, Dienstplan, Firmen): Heute, Bestellungen,
 * Cockpit, Fahrer, Mehr. „Mehr“ öffnet das Admin-Menü mit allen Bereichen, den
 * übrigen Werkzeugen und dem Weg zur Kunden-App. So bleibt man im Team-Bereich,
 * statt mit jedem Tipp in der Kunden-Ansicht zu landen.
 *
 * Erkennt die App an ?app=1, an der iOS-Brücke oder am Vollbild der Android-App.
 * Im normalen Browser ändert sich nichts.
 * ----------------------------------------------------------------------------
 */
(function () {
  'use strict';
  var mh = window.webkit && window.webkit.messageHandlers;
  var ios = !!(mh && (mh.gncTabs || mh['apple-login']));
  var inApp = /[?&]app=1/.test(location.search) || ios
    || !!(window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  var START = inApp ? '/?app=1' : '/';
  var ERSATZ = [
    { id: 'home', label: 'Start', symbol: 'house' },
    { id: 'menu', label: 'Menü', symbol: 'fork.knife' },
    { id: 'catering', label: 'Catering', symbol: 'box.truck' },
    { id: 'location', label: 'Standort', symbol: 'mappin.and.ellipse' },
    { id: 'account', label: 'Konto', symbol: 'person.crop.circle' },
  ];
  // Tab der Glas-Leiste -> Ziel auf der Startseite (#konto öffnet dort das Konto)
  var ZIEL = { menu: '#menu', catering: '#catering', location: '#location', account: '#konto' };
  var TEAM = [
    { id: 'heute', label: 'Heute', symbol: 'flame' },
    { id: 'orders', label: 'Bestellungen', symbol: 'list.bullet.rectangle' },
    { id: 'cockpit', label: 'Cockpit', symbol: 'gauge.with.dots.needle.67percent' },
    { id: 'fahrer', label: 'Fahrer', symbol: 'car' },
    { id: 'mehr', label: 'Mehr', symbol: 'ellipsis', action: true },
  ];
  var TEAM_ZIEL = {
    heute: '/admin.html?tab=today&app=1', orders: '/admin.html?tab=orders&app=1',
    cockpit: '/cockpit.html?app=1', fahrer: '/fahrer?app=1', mehr: '/admin.html?menu=1&app=1',
  };
  var LEER = { waehle: function () {} };

  function ids(x) { return Array.isArray(x) ? x : (x ? [x] : []); }

  function start(o) {
    o = o || {};
    if (!inApp) return LEER;
    ids(o.marke).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.href = START;
    });
    ids(o.zurueck).forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.href = START;
      el.hidden = false;
      var t = o.text && el.querySelector('[data-text]');
      if (t) t.textContent = o.text;
    });
    var h = mh && mh.gncTabs;
    if (!h) return LEER;
    function post(m) { try { h.postMessage(m); } catch (e) {} }
    var team = o.modus === 'team';
    var tabs = null;
    if (team) tabs = TEAM;
    else {
      try { tabs = JSON.parse(localStorage.getItem('gnc_ntb_tabs') || 'null'); } catch (e) {}
      if (!Array.isArray(tabs) || !tabs.length) tabs = o.tabs || ERSATZ;
    }
    var gewaehlt = o.selected || '';
    function melden() { post({ type: 'configure', tabs: tabs, selected: gewaehlt }); }
    var aktiv = false, zuletzt = null, raf = 0;
    function sync() {
      if (!aktiv) return;
      var weg = !!(o.verdeckt && document.querySelector(o.verdeckt));
      if (weg === zuletzt) return;
      zuletzt = weg;
      post({ type: 'hidden', hidden: weg });
    }
    // Antwort der App: true ab iOS 26, dann Leiste zeigen und unten Platz lassen
    window.gncNativeTabsActive = function (on) {
      aktiv = !!on;
      document.documentElement.classList.toggle('native-tabbar', aktiv);
      zuletzt = null;
      sync();
    };
    if (o.verdeckt) {
      new MutationObserver(function () {
        if (raf) return;
        raf = requestAnimationFrame(function () { raf = 0; sync(); });
      }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-hidden'] });
    }
    window.gncNativeTabSelect = function (id) {
      id = String(id);
      // Abgebrochen: die App zeigt wieder den bisherigen Tab
      if (o.vorWechsel && o.vorWechsel(id) === false) { melden(); return; }
      if (o.lokal && o.lokal(id) === true) return;
      var ziel = team ? TEAM_ZIEL[id] : '/?app=1' + (ZIEL[id] || '');
      if (ziel) location.href = ziel;
    };
    melden();
    return { waehle: function (id) { if ((id || '') === gewaehlt) return; gewaehlt = id || ''; melden(); } };
  }

  window.GNCAppLeiste = { inApp: inApp, start: start, START: START };
})();
