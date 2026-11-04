/**
 * app-leiste.js
 * ----------------------------------------------------------------------------
 * Rückweg in die App-Ansicht für Unterseiten, die die App in ihrer eigenen
 * Web-Ansicht öffnet (Statusseite, Cockpit).
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
 *   })
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

  function ids(x) { return Array.isArray(x) ? x : (x ? [x] : []); }

  function start(o) {
    o = o || {};
    if (!inApp) return;
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
    if (!h) return;
    function post(m) { try { h.postMessage(m); } catch (e) {} }
    var tabs = null;
    try { tabs = JSON.parse(localStorage.getItem('gnc_ntb_tabs') || 'null'); } catch (e) {}
    if (!Array.isArray(tabs) || !tabs.length) tabs = o.tabs || ERSATZ;
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
      location.href = '/?app=1' + (ZIEL[String(id)] || '');
    };
    post({ type: 'configure', tabs: tabs, selected: '' });
  }

  window.GNCAppLeiste = { inApp: inApp, start: start, START: START };
})();
