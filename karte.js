/* ============================================================================
   karte.js
   Kleine Kachelkarte ohne Bibliothek: OpenStreetMap-Rasterkacheln als <img>,
   Web-Mercator-Rechnung, Marker per CSS, Wärmezellen auf einem Canvas.
   Genutzt von status.html (Live-Lieferung) und cockpit.html (Liefer-Heatmap).

     var k = GNCKarte.erstelle(element, {
       ziehen: false,          // Verschieben mit Finger/Maus
       zoomKnoepfe: false,     // Knöpfe + und -
       attribution: '© OpenStreetMap-Mitwirkende',
       label: 'Karte …',       // aria-label
       dunkel: true            // Kacheln abgedunkelt (dunkles CI)
     });
     k.marker([{ id, lat, lng, art: 'fahrer'|'ziel'|'truck', titel }]);
     k.zellen([{ lat, lng, n }], { dLat, dLng });
     k.einpassen([{lat,lng}, …], { rand: 40, maxZoom: 16 });
     k.zerstoere();

   Kacheln kommen von tile.openstreetmap.org (CSP img-src in
   werkzeug/seiten-bauen.js). Nutzungsregeln der OSMF: Attribution sichtbar,
   kein Vorladen, normale Browser-Anfragen mit Referer.
   ========================================================================== */
(function () {
  'use strict';

  var KACHEL = 'https://tile.openstreetmap.org/';
  var G = 256;
  var MIN_Z = 3, MAX_Z = 18;

  var STIL = '\
.gk{position:relative;overflow:hidden;background:#1a1712;border-radius:12px;isolation:isolate;-webkit-user-select:none;user-select:none}\
.gk-kacheln,.gk-marker{position:absolute;inset:0}\
.gk-k{position:absolute;width:256px;height:256px;max-width:none;opacity:0;transition:opacity .25s ease;pointer-events:none}\
.gk-k.da{opacity:1}\
.gk.dunkel .gk-k{filter:invert(.9) hue-rotate(180deg) saturate(.45) brightness(.92) contrast(.92)}\
.gk-heat{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;filter:blur(3px)}\
.gk.zieht{cursor:grabbing}\
.gk.ziehbar{cursor:grab;touch-action:none}\
.gk-m{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none}\
.gk-m>span{position:absolute;display:grid;place-items:center;transform:translate(-50%,-50%)}\
.gk-m-fahrer>span{width:22px;height:22px;border-radius:50%;background:#E85A24;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.5)}\
.gk-m-fahrer>span::after{content:"";position:absolute;inset:-9px;border-radius:50%;border:2px solid rgba(232,90,36,.7);animation:gkPuls 1.8s ease-out infinite}\
@keyframes gkPuls{0%{transform:scale(.55);opacity:1}100%{transform:scale(1.35);opacity:0}}\
.gk-m-ziel>span{width:30px;height:30px;border-radius:50%;background:#F5E9D0;color:#140D06;border:2px solid #140D06;box-shadow:0 2px 8px rgba(0,0,0,.5)}\
.gk-m-ziel svg,.gk-m-truck svg{width:16px;height:16px}\
.gk-m-truck>span{width:28px;height:28px;border-radius:8px;background:#140D06;color:#FF7A3D;border:2px solid #FF7A3D;box-shadow:0 2px 8px rgba(0,0,0,.5)}\
.gk-attr{position:absolute;right:6px;bottom:6px;z-index:3;display:inline-flex;align-items:center;min-height:24px;padding:2px 9px;border:1px solid rgba(245,233,208,.35);border-radius:999px;background:rgba(12,11,9,.82);color:#F5E9D0;font:600 11px/1.3 Inter,-apple-system,BlinkMacSystemFont,sans-serif;text-decoration:none;white-space:nowrap}\
.gk-attr:hover{border-color:#FF7A3D;color:#F5E9D0}\
.gk-zoom{position:absolute;left:8px;top:8px;z-index:3;display:flex;flex-direction:column;gap:6px}\
.gk-zoom button{width:44px;height:44px;display:grid;place-items:center;border-radius:10px;border:1px solid #4A3E30;background:rgba(23,20,15,.92);color:#F5E9D0;cursor:pointer;padding:0}\
.gk-zoom button:hover{border-color:#FF7A3D}\
.gk-zoom svg{width:18px;height:18px}\
.gk button:focus-visible,.gk a:focus-visible{outline:2px solid #FF7A3D;outline-offset:2px}\
@media (prefers-reduced-motion:reduce){.gk-k{transition:none}.gk-m-fahrer>span::after{animation:none;opacity:.6;transform:scale(1.05)}}\
';
  var SVG_HAUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/></svg>';
  var SVG_TRUCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h11v10H3z"/><path d="M14 10h4l3 3v3h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/></svg>';
  var SVG_PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  var SVG_MINUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>';

  function stilEinbauen() {
    if (document.getElementById('gkStil')) return;
    var s = document.createElement('style');
    s.id = 'gkStil';
    s.textContent = STIL;
    document.head.appendChild(s);
  }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* Web Mercator: Grad <-> Weltpixel bei Zoom z */
  function welt(lat, lng, z) {
    var s = G * Math.pow(2, z);
    var r = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180;
    return { x: (lng + 180) / 360 * s, y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * s };
  }
  function grad(x, y, z) {
    var s = G * Math.pow(2, z);
    return { lng: x / s * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / s))) * 180 / Math.PI };
  }

  function erstelle(el, opt) {
    opt = opt || {};
    stilEinbauen();
    el.classList.add('gk');
    if (opt.dunkel !== false) el.classList.add('dunkel');
    if (opt.label) { el.setAttribute('role', 'img'); el.setAttribute('aria-label', opt.label); }
    el.innerHTML = '<div class="gk-kacheln" aria-hidden="true"></div><canvas class="gk-heat" aria-hidden="true"></canvas><div class="gk-marker"></div>'
      + (opt.zoomKnoepfe ? '<div class="gk-zoom"><button type="button" data-z="1" aria-label="Hineinzoomen">' + SVG_PLUS + '</button><button type="button" data-z="-1" aria-label="Herauszoomen">' + SVG_MINUS + '</button></div>' : '')
      + '<a class="gk-attr" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">' + esc(opt.attribution || '© OpenStreetMap-Mitwirkende') + '</a>';
    var ebeneK = el.querySelector('.gk-kacheln');
    var ebeneM = el.querySelector('.gk-marker');
    var canvas = el.querySelector('.gk-heat');
    var st = { lat: 51.9784, lng: 8.4814, z: 13 };
    var kacheln = {};       // Schlüssel -> img
    var marker = [];        // { id, lat, lng, art, titel, el }
    var heat = null;        // { liste, dLat, dLng }
    var weg = false;

    function groesse() { return { w: el.clientWidth, h: el.clientHeight }; }

    function zeichneKacheln(w, h, links, oben) {
      var n = Math.pow(2, st.z);
      var x0 = Math.floor(links / G), x1 = Math.floor((links + w - 1) / G);
      var y0 = Math.floor(oben / G), y1 = Math.floor((oben + h - 1) / G);
      var noetig = {};
      for (var x = x0; x <= x1; x++) {
        for (var y = y0; y <= y1; y++) {
          if (y < 0 || y >= n) continue;
          var xx = ((x % n) + n) % n;
          var key = st.z + '/' + x + '/' + y;
          noetig[key] = true;
          var img = kacheln[key];
          if (!img) {
            img = document.createElement('img');
            img.className = 'gk-k';
            img.alt = '';
            img.draggable = false;
            img.decoding = 'async';
            img.addEventListener('load', function () { this.classList.add('da'); });
            img.addEventListener('error', function () { this.style.visibility = 'hidden'; });
            img.src = KACHEL + st.z + '/' + xx + '/' + y + '.png';
            kacheln[key] = img;
            ebeneK.appendChild(img);
          }
          img.style.transform = 'translate(' + Math.round(x * G - links) + 'px,' + Math.round(y * G - oben) + 'px)';
        }
      }
      Object.keys(kacheln).forEach(function (k) {
        if (!noetig[k]) { kacheln[k].remove(); delete kacheln[k]; }
      });
    }

    function zeichneMarker(links, oben) {
      marker.forEach(function (m) {
        var p = welt(m.lat, m.lng, st.z);
        m.el.style.transform = 'translate(' + Math.round(p.x - links) + 'px,' + Math.round(p.y - oben) + 'px)';
      });
    }

    function zeichneHeat(w, h, links, oben) {
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      var ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!heat || !heat.liste.length) return;
      var max = 1;
      heat.liste.forEach(function (c) { if (c.n > max) max = c.n; });
      heat.liste.forEach(function (c) {
        var a = welt(c.lat + heat.dLat / 2, c.lng - heat.dLng / 2, st.z);
        var b = welt(c.lat - heat.dLat / 2, c.lng + heat.dLng / 2, st.z);
        var x = a.x - links, y = a.y - oben, bw = b.x - a.x, bh = b.y - a.y;
        if (x > w || y > h || x + bw < 0 || y + bh < 0) return;
        var t = Math.sqrt(c.n / max);
        var cx = x + bw / 2, cy = y + bh / 2, r = Math.max(12, Math.max(bw, bh) * 0.85);
        var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        var farbe = t > 0.66 ? '255,201,60' : (t > 0.33 ? '255,122,61' : '232,90,36');
        g.addColorStop(0, 'rgba(' + farbe + ',' + (0.45 + 0.5 * t).toFixed(2) + ')');
        g.addColorStop(1, 'rgba(' + farbe + ',0)');
        ctx.fillStyle = g;
        ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
      });
    }

    function zeichne() {
      if (weg) return;
      var gr = groesse();
      if (!gr.w || !gr.h) return;
      var c = welt(st.lat, st.lng, st.z);
      var links = c.x - gr.w / 2, oben = c.y - gr.h / 2;
      zeichneKacheln(gr.w, gr.h, links, oben);
      zeichneMarker(links, oben);
      zeichneHeat(gr.w, gr.h, links, oben);
    }

    function setzeMarker(liste) {
      var neu = [];
      (liste || []).forEach(function (m) {
        if (!m || typeof m.lat !== 'number' || typeof m.lng !== 'number') return;
        var alt = null;
        for (var i = 0; i < marker.length; i++) if (marker[i].id === m.id && marker[i].art === m.art) alt = marker[i];
        var e = alt ? alt.el : document.createElement('div');
        if (!alt) {
          e.className = 'gk-m gk-m-' + m.art;
          e.innerHTML = '<span>' + (m.art === 'ziel' ? SVG_HAUS : (m.art === 'truck' ? SVG_TRUCK : '')) + '</span>';
          ebeneM.appendChild(e);
        }
        if (m.titel) { e.setAttribute('title', m.titel); e.setAttribute('aria-label', m.titel); e.setAttribute('role', 'img'); }
        neu.push({ id: m.id, lat: m.lat, lng: m.lng, art: m.art, titel: m.titel, el: e });
      });
      marker.forEach(function (m) { if (neu.indexOf(m) < 0 && !neu.some(function (x) { return x.el === m.el; })) m.el.remove(); });
      marker = neu;
      zeichne();
    }

    function setzeZellen(liste, raster) {
      heat = { liste: (liste || []).filter(function (c) { return c && typeof c.lat === 'number'; }), dLat: (raster && raster.dLat) || 0.00225, dLng: (raster && raster.dLng) || 0.00365 };
      zeichne();
    }

    function einpassen(punkte, o) {
      o = o || {};
      var p = (punkte || []).filter(function (x) { return x && typeof x.lat === 'number' && typeof x.lng === 'number'; });
      if (!p.length) return;
      var gr = groesse();
      var rand = o.rand == null ? 40 : o.rand;
      var maxZ = o.maxZoom || 16, minZ = o.minZoom || 10;
      var z = maxZ;
      for (; z > minZ; z--) {
        var xs = p.map(function (q) { return welt(q.lat, q.lng, z).x; });
        var ys = p.map(function (q) { return welt(q.lat, q.lng, z).y; });
        if (Math.max.apply(null, xs) - Math.min.apply(null, xs) <= Math.max(10, gr.w - 2 * rand)
          && Math.max.apply(null, ys) - Math.min.apply(null, ys) <= Math.max(10, gr.h - 2 * rand)) break;
      }
      var X = p.map(function (q) { return welt(q.lat, q.lng, z).x; });
      var Y = p.map(function (q) { return welt(q.lat, q.lng, z).y; });
      var m = grad((Math.max.apply(null, X) + Math.min.apply(null, X)) / 2, (Math.max.apply(null, Y) + Math.min.apply(null, Y)) / 2, z);
      st.z = z; st.lat = m.lat; st.lng = m.lng;
      zeichne();
    }

    function zoom(d) {
      st.z = Math.max(MIN_Z, Math.min(MAX_Z, st.z + d));
      zeichne();
    }

    /* Verschieben */
    var zug = null;
    function unten(e) {
      if (e.button != null && e.button !== 0) return;
      if (e.target.closest('.gk-zoom,.gk-attr')) return;
      var c = welt(st.lat, st.lng, st.z);
      zug = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: c.x, cy: c.y };
      try { el.setPointerCapture(e.pointerId); } catch (x) {}
      el.classList.add('zieht');
    }
    function bewegt(e) {
      if (!zug || e.pointerId !== zug.id) return;
      var g2 = grad(zug.cx - (e.clientX - zug.x), zug.cy - (e.clientY - zug.y), st.z);
      st.lat = g2.lat; st.lng = g2.lng;
      zeichne();
    }
    function los(e) {
      if (!zug || (e && e.pointerId !== zug.id)) return;
      zug = null;
      el.classList.remove('zieht');
    }
    if (opt.ziehen) {
      el.classList.add('ziehbar');
      el.addEventListener('pointerdown', unten);
      el.addEventListener('pointermove', bewegt);
      el.addEventListener('pointerup', los);
      el.addEventListener('pointercancel', los);
    }
    if (opt.zoomKnoepfe) {
      el.querySelector('.gk-zoom').addEventListener('click', function (e) {
        var b = e.target.closest('button[data-z]');
        if (b) zoom(Number(b.getAttribute('data-z')));
      });
    }

    var ro = null;
    if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(function () { zeichne(); }); ro.observe(el); }
    else window.addEventListener('resize', zeichne);

    return {
      marker: setzeMarker,
      zellen: setzeZellen,
      einpassen: einpassen,
      zentrum: function (lat, lng, z) { st.lat = lat; st.lng = lng; if (z) st.z = z; zeichne(); },
      zoom: zoom,
      neuZeichnen: zeichne,
      stand: function () { return { lat: st.lat, lng: st.lng, z: st.z }; },
      zerstoere: function () { weg = true; if (ro) ro.disconnect(); el.innerHTML = ''; el.classList.remove('gk', 'dunkel', 'ziehbar'); },
    };
  }

  window.GNCKarte = { erstelle: erstelle, welt: welt, grad: grad };
})();
