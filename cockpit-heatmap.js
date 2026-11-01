/* ============================================================================
   cockpit-heatmap.js
   Liefer-Heatmap im Cockpit (cockpit.html), nur für den Inhaber.
   Server: /.netlify/functions/liefer-heatmap (gibt nur Rasterzellen ab 3
   Bestellungen zurück, nie Adressen). Karte: karte.js.

   Das Cockpit meldet nach jedem Laden per Ereignis 'gnc-cockpit', ob der
   Inhaber angemeldet ist ({ owner, cred }). Nur dann erscheint die Karte.
   Fehlen noch Koordinaten, fragt die Seite in kurzen Abständen nach, bis
   alles verortet ist (der Server verortet je Aufruf höchstens 5 Adressen).
   ========================================================================== */
(function () {
  'use strict';

  var URL_HEAT = '/.netlify/functions/liefer-heatmap';
  var NEU_MS = 10 * 60 * 1000;
  var $ = function (id) { return document.getElementById(id); };
  var fmtZahl = new Intl.NumberFormat('de-DE');

  var st = { cred: '', tage: 30, karte: null, laedt: false, timer: null, geladen: 0, eingepasst: '', runden: 0 };

  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function verstecke() {
    st.cred = '';
    clearTimeout(st.timer); st.timer = null;
    var c = $('cardHeat');
    if (c) c.hidden = true;
    if (st.karte) { st.karte.zerstoere(); st.karte = null; }
    st.eingepasst = '';
    st.geladen = 0;
    if ($('heatListe')) $('heatListe').textContent = '';
  }

  function zeige() {
    $('cardHeat').hidden = false;
    if (!st.karte && window.GNCKarte) {
      st.karte = window.GNCKarte.erstelle($('heatKarte'), { ziehen: true, zoomKnoepfe: true, label: 'Wärmekarte der Lieferungen rund um den Truck' });
    }
  }

  async function laden() {
    if (!st.cred || st.laedt) return;
    st.laedt = true;
    clearTimeout(st.timer); st.timer = null;
    var mit = st.cred, tage = st.tage;
    var weiter = false;
    try {
      var res = await fetch(URL_HEAT, {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: mit, tage: tage }),
      });
      if (mit !== st.cred || tage !== st.tage) return;
      if (res.status === 403 || res.status === 401) { verstecke(); return; }   // Abmelden regelt das Cockpit
      var d = await res.json().catch(function () { return null; });
      if (!res.ok || !d || !d.ok) throw new Error('lesefehler');
      st.geladen = Date.now();
      male(d);
      weiter = d.offen > 0 && st.runden < 60;
      st.runden = weiter ? st.runden + 1 : 0;
    } catch (e) {
      $('heatInfo').textContent = 'Heatmap gerade nicht geladen. Neuer Versuch beim nächsten Auffrischen.';
    } finally {
      st.laedt = false;
      if (weiter && st.cred) st.timer = setTimeout(laden, 1500);
    }
  }

  function male(d) {
    zeige();
    var k = st.karte;
    if (k) {
      k.zellen(d.zellen || [], d.zelle || {});
      k.marker([{ id: 'truck', art: 'truck', lat: d.truck.lat, lng: d.truck.lng, titel: 'Truck, Gütersloher Str. 122' }]);
      // Einpassen beim ersten Bild je Zeitraum und noch einmal, wenn alles
      // verortet ist. Sonst nicht: die Karte soll nicht unter dem Finger springen.
      var ziel = st.tage + (d.offen > 0 ? ':teil' : ':voll');
      if (st.eingepasst !== ziel && st.eingepasst !== st.tage + ':voll') {
        var punkte = (d.zellen || []).map(function (z) { return { lat: z.lat, lng: z.lng }; }).concat([d.truck]);
        k.einpassen(punkte, { rand: 36, maxZoom: 14, minZoom: 10 });
        st.eingepasst = ziel;
      }
    }
    var info = fmtZahl.format(d.lieferungen) + (d.lieferungen === 1 ? ' Lieferung' : ' Lieferungen') + ' in ' + d.tage + ' Tagen, '
      + fmtZahl.format(d.verortet) + ' auf der Karte.';
    if (d.offen > 0) info += ' Noch ' + d.offen + (d.offen === 1 ? ' Adresse wird' : ' Adressen werden') + ' verortet.';
    if (d.nichtGefunden > 0) info += ' ' + d.nichtGefunden + (d.nichtGefunden === 1 ? ' Adresse' : ' Adressen') + ' nicht gefunden.';
    if (d.zellen && !d.zellen.length && !d.offen) info += ' Noch kein Feld mit 3 oder mehr Bestellungen.';
    $('heatInfo').textContent = info;

    var ol = $('heatListe');
    var g = d.gebiete || [];
    if (!g.length) { ol.innerHTML = '<li class="leer">Noch keine Gegend mit 3 oder mehr Lieferungen.</li>'; return; }
    ol.innerHTML = g.map(function (x) {
      return '<li><span class="ort"><span class="plz">' + esc(x.plz) + '</span>' + esc(x.stadtteil || '') + '</span>'
        + '<span class="anz">' + esc(x.n) + ' <small>' + (x.n === 1 ? 'Lieferung' : 'Lieferungen') + '</small></span></li>';
    }).join('');
  }

  /* Zeitraum 30 / 90 Tage */
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('#heatTage button[data-tage]');
    if (!b) return;
    var t = Number(b.getAttribute('data-tage')) === 90 ? 90 : 30;
    if (t === st.tage) return;
    st.tage = t;
    st.runden = 0;
    document.querySelectorAll('#heatTage button').forEach(function (x) { x.setAttribute('aria-checked', x === b ? 'true' : 'false'); });
    $('heatInfo').textContent = 'Wird geladen';
    laden();
  });
  document.addEventListener('keydown', function (e) {
    if (!e.target.closest || !e.target.closest('#heatTage') || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    var b = document.querySelector('#heatTage button[data-tage="' + (e.key === 'ArrowRight' ? 90 : 30) + '"]');
    if (b) { e.preventDefault(); b.focus(); b.click(); }
  });

  /* Meldung vom Cockpit nach jedem Laden */
  document.addEventListener('gnc-cockpit', function (e) {
    var d = (e && e.detail) || {};
    if (!d.owner || !d.cred) { verstecke(); return; }
    var neu = d.cred !== st.cred;
    st.cred = d.cred;
    zeige();
    if (neu || Date.now() - st.geladen > NEU_MS) laden();
  });
})();
