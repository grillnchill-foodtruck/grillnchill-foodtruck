/* ============================================================================
   status-live.js
   Live-Karte auf der Kunden-Statusseite (status.html), solange die Lieferung
   unterwegs ist: Kubis Punkt, das Ziel und "Ankunft gegen 12:42".
   Daten: /.netlify/functions/lieferung-live?ref=…&k=… (gleicher
   Statusschlüssel wie die Seite selbst), alle 15 Sekunden.
   Ohne Live-Standort (nicht geteilt, verweigert, veraltet) nur die Ankunftszeit.

   status.html ruft nach jedem Zeichnen window.gncLiveSync(DATA) auf.
   Texte in 8 Sprachen stehen in i18n.js und i18n-xx.js (Schlüssel live.*).
   Deutsch steht unten als Rückfall und muss zu i18n.js passen.
   ========================================================================== */
(function () {
  'use strict';

  var URL_LIVE = '/.netlify/functions/lieferung-live';
  var TAKT_MS = 15000;
  var SPRACHEN = ['de', 'en', 'tr', 'it', 'es', 'pt', 'fr', 'nl'];
  var LOCALE = { de: 'de-DE', en: 'en-GB', tr: 'tr-TR', it: 'it-IT', es: 'es-ES', pt: 'pt-PT', fr: 'fr-FR', nl: 'nl-NL' };
  var DE = {
    'live.title': 'Live verfolgen',
    'live.badge': 'Live',
    'live.eta': 'Ankunft gegen {time}',
    'live.soon': 'Gleich bei dir',
    'live.moving': 'Kubi ist unterwegs zu dir',
    'live.updated': 'Standort von {time}',
    'live.no_pos': 'Der Live-Standort ist gerade nicht verfügbar. Die Ankunftszeit gilt weiter.',
    'live.map_label': 'Karte mit Kubis Standort und deiner Lieferadresse',
    'live.driver': 'Kubi',
    'live.dest': 'Deine Adresse',
    'live.osm': '© OpenStreetMap-Mitwirkende',
  };

  var REF = (location.pathname.split('/s/')[1] || '').split('/')[0].replace(/[^A-Za-z0-9-]/g, '');
  var KEY = new URLSearchParams(location.search).get('k') || '';

  function sprache() {
    try { var sv = localStorage.getItem('gnc_lang'); if (SPRACHEN.indexOf(sv) >= 0) return sv; } catch (e) {}
    var nv = (navigator.language || 'de').toLowerCase();
    for (var i = 0; i < SPRACHEN.length; i++) if (nv.indexOf(SPRACHEN[i]) === 0) return SPRACHEN[i];
    return 'de';
  }
  var LANG = sprache();
  var TX = null;
  function t(k) { return (TX && TX[k]) || DE[k] || k; }

  /* Sprachpaket der Hauptseite nachladen (nur die Datei der Sprache, nicht
     i18n.js). Die Pakete schreiben in I18N, PRODUCTS_I18N und TAGS_I18N. */
  function i18nObjekt() { try { return I18N; } catch (e) { return window.I18N; } }   // eslint-disable-line no-undef
  var spracheGeladen = false;
  function ladeSprache(fertig) {
    if (LANG === 'de' || spracheGeladen) { spracheGeladen = true; fertig(); return; }
    var vorhanden = i18nObjekt();
    if (vorhanden && vorhanden[LANG]) { TX = vorhanden[LANG]; spracheGeladen = true; fertig(); return; }
    if (typeof window.I18N === 'undefined' && !vorhanden) window.I18N = {};
    if (typeof window.PRODUCTS_I18N === 'undefined') window.PRODUCTS_I18N = {};
    if (typeof window.TAGS_I18N === 'undefined') window.TAGS_I18N = {};
    var s = document.createElement('script');
    s.src = '/i18n-' + LANG + '.js';
    s.onload = function () { var o = i18nObjekt(); if (o && o[LANG]) TX = o[LANG]; spracheGeladen = true; fertig(); };
    s.onerror = function () { spracheGeladen = true; fertig(); };
    document.head.appendChild(s);
  }

  function uhrzeit(iso) {
    try { return new Intl.DateTimeFormat(LOCALE[LANG] || 'de-DE', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Berlin' }).format(new Date(iso)); }
    catch (e) { return ''; }
  }

  /* ---------------- Karte ---------------- */
  var box = null, karte = null, timer = null, aktiv = false, laeuft = false, letzte = null;

  function baue() {
    box = document.getElementById('liveKarte');
    if (!box || box.getAttribute('data-gebaut')) return !!box;
    box.setAttribute('data-gebaut', '1');
    box.innerHTML = '<div class="lk-kopf"><div><div class="lbl" id="lkTitel"></div><div class="big" id="lkEta"></div></div>'
      + '<span class="lk-badge" id="lkBadge"><span class="lk-dot" aria-hidden="true"></span><span id="lkBadgeTxt"></span></span></div>'
      + '<div class="lk-karte" id="lkKarte" hidden></div>'
      + '<p class="lk-info" id="lkInfo" aria-live="polite"></p>';
    return true;
  }

  function texteSetzen() {
    document.getElementById('lkTitel').textContent = t('live.title');
    document.getElementById('lkBadgeTxt').textContent = t('live.badge');
  }

  function zeige(d) {
    if (!baue()) return;
    texteSetzen();
    box.hidden = false;
    var eta = document.getElementById('lkEta');
    if (d.ankunft) eta.textContent = Date.parse(d.ankunft) < Date.now() - 60000 ? t('live.soon') : t('live.eta').replace('{time}', uhrzeit(d.ankunft));
    else eta.textContent = t('live.moving');

    var kEl = document.getElementById('lkKarte');
    var info = document.getElementById('lkInfo');
    var badge = document.getElementById('lkBadge');
    if (d.pos && window.GNCKarte) {
      kEl.hidden = false;
      badge.hidden = false;
      if (!karte) karte = window.GNCKarte.erstelle(kEl, { attribution: t('live.osm'), label: t('live.map_label') });
      var m = [{ id: 'fahrer', art: 'fahrer', lat: d.pos.lat, lng: d.pos.lng, titel: t('live.driver') }];
      if (d.ziel) m.push({ id: 'ziel', art: 'ziel', lat: d.ziel.lat, lng: d.ziel.lng, titel: t('live.dest') });
      karte.marker(m);
      karte.einpassen(m, { rand: 46, maxZoom: 16, minZoom: 11 });
      info.textContent = t('live.updated').replace('{time}', uhrzeit(d.pos.at));
    } else {
      kEl.hidden = true;
      badge.hidden = true;
      info.textContent = t('live.no_pos');
    }
  }

  function verstecke() {
    aktiv = false;
    clearTimeout(timer); timer = null;
    if (box) box.hidden = true;
    if (karte) { karte.zerstoere(); karte = null; }
  }

  function hole() {
    if (!aktiv || laeuft || document.hidden) return;
    laeuft = true;
    fetch(URL_LIVE + '?ref=' + encodeURIComponent(REF) + '&k=' + encodeURIComponent(KEY), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) return;
        if (!d.aktiv) { verstecke(); return; }
        letzte = d;
        ladeSprache(function () { if (aktiv) zeige(d); });
      })
      .catch(function () { /* Netz weg: letzten Stand stehen lassen, die Seite meldet die Verbindung selbst */ })
      .then(function () {
        laeuft = false;
        if (aktiv) { clearTimeout(timer); timer = setTimeout(hole, TAKT_MS); }
      });
  }

  /* Aufruf aus status.html nach jedem Zeichnen */
  window.gncLiveSync = function (data) {
    var soll = !!(data && data.mode === 'delivery' && data.state === 'on_the_way' && REF && KEY);
    if (soll && !aktiv) { aktiv = true; hole(); }
    else if (!soll && aktiv) verstecke();
  };

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && aktiv) { clearTimeout(timer); timer = null; hole(); }
  });
  window.addEventListener('resize', function () { if (karte && letzte && letzte.pos) zeige(letzte); });
})();
