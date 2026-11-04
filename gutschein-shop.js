/**
 * gutschein-shop.js
 * ----------------------------------------------------------------------------
 * Gutscheinseite /gutscheine: gestalten, bezahlen (SumUp), Danke-Ansicht mit
 * Code und PDF, „Gutschein prüfen“. Server: netlify/functions/giftcard-*.js
 * und lib/geschenk.js. Betragsgrenzen und Vorschläge müssen zu
 * lib/geschenk.js (MIN_BETRAG, MAX_BETRAG, VORSCHLAEGE) passen.
 *
 * Die Karte rechts folgt Maus oder Finger über Federn (kritisch gedämpft,
 * unterbrechbar, Geschwindigkeit wird beim Loslassen übernommen). Bei
 * „Bewegung reduzieren“ steht sie still und der Betrag springt ohne Zählen.
 * ----------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var MIN = 10, MAX = 200;
  var FORM_KEY = 'gnc_gs_form_v2';
  var PENDING_KEY = 'gnc_gift_pending_v1';
  var API = '/.netlify/functions/';
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var feinZeiger = window.matchMedia && matchMedia('(pointer: fine)').matches;
  var VORSCHLAG = { menue: 'Ein Burger-Menü', zwei: 'Menü für zwei', abend: 'Ein Abend mit Freunden', crew: 'Mittag für die Crew' };
  var EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/;

  /* ---- App: Rückweg und Glas-Leiste (app-leiste.js) ---------------------- */
  var leiste = window.GNCAppLeiste;
  var inApp = !!(leiste && leiste.inApp);
  if (leiste) leiste.start({ zurueck: 'appZurueck', marke: 'marke', text: 'Zurück' });
  var START = inApp ? '/?app=1' : '/';
  Array.prototype.forEach.call(document.querySelectorAll('.app-start'), function (a) { a.href = START; });

  /* ---- Hilfen ----------------------------------------------------------- */
  function euro(n) {
    var v = Number(n) || 0;
    return (v % 1 ? v.toFixed(2).replace('.', ',') : String(v)) + ' €';
  }
  function euroHtml(n) { return euro(n).replace(' €', '<span class="eur">€</span>'); }
  function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function datum(isoTag, lang) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoTag || '')) return '';
    var p = isoTag.split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12));
    try {
      return new Intl.DateTimeFormat('de-DE', lang ? { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' } : { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(d);
    } catch (e) { return p.reverse().join('.'); }
  }
  function lade(k, s) { try { return JSON.parse((s || sessionStorage).getItem(k) || 'null'); } catch (e) { return null; } }
  function sichere(k, v, s) { try { (s || sessionStorage).setItem(k, JSON.stringify(v)); } catch (e) {} }
  function weg(k, s) { try { (s || sessionStorage).removeItem(k); } catch (e) {} }
  function urlOhneParameter() {
    try { history.replaceState(null, '', '/gutscheine' + (inApp ? '?app=1' : '') + location.hash); } catch (e) {}
  }

  /* ---- Feder: Dämpfung und Antwortzeit wie bei Apple -------------------- */
  function Feder(wert, antwort, daempfung) {
    var k = Math.pow(2 * Math.PI / (antwort || 0.4), 2);
    return { x: wert, v: 0, ziel: wert, k: k, c: 2 * (daempfung == null ? 1 : daempfung) * Math.sqrt(k) };
  }
  function schritt(f, dt) {
    var a = f.k * (f.ziel - f.x) - f.c * f.v;
    f.v += a * dt;
    f.x += f.v * dt;
    return Math.abs(f.ziel - f.x) > 0.0005 || Math.abs(f.v) > 0.0005;
  }
  // Weicher Rand: je weiter über die Grenze, desto weniger folgt die Karte
  function gummi(x, grenze) {
    var c = 0.55, a = Math.abs(x);
    if (a <= grenze) return x;
    var ueber = a - grenze;
    return Math.sign(x) * (grenze + (ueber * grenze * c) / (grenze + c * ueber));
  }

  function kartenNeigung(buehne, karte) {
    var leer = { pop: function () {} };
    if (!buehne || !karte || reduce) return leer;
    var rx = Feder(0, 0.4), ry = Feder(0, 0.4), sc = Feder(1, 0.3), gl = Feder(0, 0.4);
    var raf = 0, zuletzt = 0, zieht = null;
    function bild(jetzt) {
      var dt = Math.min(0.032, (jetzt - (zuletzt || jetzt)) / 1000) || 0.016;
      zuletzt = jetzt;
      var laeuft = false;
      if (!zieht) { laeuft = schritt(rx, dt) | laeuft; laeuft = schritt(ry, dt) | laeuft; }
      laeuft = schritt(sc, dt) | laeuft;
      laeuft = schritt(gl, dt) | laeuft;
      karte.style.setProperty('--rx', rx.x.toFixed(3) + 'deg');
      karte.style.setProperty('--ry', ry.x.toFixed(3) + 'deg');
      karte.style.setProperty('--sc', sc.x.toFixed(4));
      karte.style.setProperty('--glanz', Math.max(0, gl.x).toFixed(3));
      raf = (laeuft || zieht) ? requestAnimationFrame(bild) : 0;
      if (!raf) zuletzt = 0;
    }
    function an() { if (!raf) raf = requestAnimationFrame(bild); }
    function glanzBei(x, y) {
      karte.style.setProperty('--px', (x * 100).toFixed(1) + '%');
      karte.style.setProperty('--py', (y * 100).toFixed(1) + '%');
    }

    // Maus: die Karte neigt sich sanft zum Zeiger
    buehne.addEventListener('pointermove', function (e) {
      if (e.pointerType !== 'mouse' || zieht) return;
      var r = karte.getBoundingClientRect();
      var x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      ry.ziel = (x - 0.5) * 14;
      rx.ziel = (0.5 - y) * 11;
      gl.ziel = 1;
      glanzBei(x, y);
      an();
    });
    buehne.addEventListener('pointerleave', function (e) {
      if (e.pointerType !== 'mouse') return;
      rx.ziel = 0; ry.ziel = 0; gl.ziel = 0; an();
    });

    // Finger: Karte klebt am Finger (1:1), beim Loslassen federt sie mit
    // dem Schwung des Fingers zurück. Senkrecht bleibt Scrollen (pan-y).
    buehne.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse') return;
      var r = karte.getBoundingClientRect();
      zieht = { id: e.pointerId, x0: e.clientX, y0: e.clientY, gy: (e.clientY - r.top) / r.height, w: r.width,
        verlauf: [{ t: performance.now(), ry: ry.x }] };
      try { buehne.setPointerCapture(e.pointerId); } catch (err) {}
      gl.ziel = 1;
      glanzBei((e.clientX - r.left) / r.width, zieht.gy);
      an();
    });
    buehne.addEventListener('pointermove', function (e) {
      if (!zieht || e.pointerId !== zieht.id) return;
      var dx = e.clientX - zieht.x0;
      var winkel = gummi((dx / zieht.w) * 34, 16);
      ry.x = winkel;
      rx.x = (0.5 - zieht.gy) * 8 * Math.min(1, Math.abs(dx) / 40);
      var t = performance.now();
      zieht.verlauf.push({ t: t, ry: ry.x });
      if (zieht.verlauf.length > 5) zieht.verlauf.shift();
      var r = karte.getBoundingClientRect();
      glanzBei((e.clientX - r.left) / r.width, zieht.gy);
    });
    function los(e) {
      if (!zieht || (e && e.pointerId !== zieht.id)) return;
      var v = zieht.verlauf, a = v[0], b = v[v.length - 1];
      var dt = (b.t - a.t) / 1000;
      // Schwung übernehmen, dazu etwas Nachfedern, weil der Finger Schwung hatte
      ry.v = dt > 0 ? (b.ry - a.ry) / dt : 0;
      rx.v = 0;
      ry.c = 2 * 0.72 * Math.sqrt(ry.k);
      rx.ziel = 0; ry.ziel = 0; gl.ziel = 0;
      zieht = null;
      setTimeout(function () { ry.c = 2 * Math.sqrt(ry.k); }, 900);
      an();
    }
    buehne.addEventListener('pointerup', los);
    buehne.addEventListener('pointercancel', los);

    return { pop: function () { sc.v += 0.6; an(); } };
  }

  /* =================== Gestalten =================== */
  function shop() {
    var form = $('gs-form');
    var gespeichert = lade(FORM_KEY) || {};
    var st = {
      preset: gespeichert.preset !== undefined ? gespeichert.preset : 'zwei',
      amount: gespeichert.amount || 30,
      delivery: gespeichert.delivery || 'mail',
      when: gespeichert.when || 'now',
      date: gespeichert.date || '',
    };
    var FELDER = ['rname', 'msg', 'remail', 'bname', 'bemail'];
    FELDER.forEach(function (f) { if (gespeichert[f]) $('gs-' + f).value = gespeichert[f]; });
    if (gespeichert.amount && !gespeichert.preset) $('gs-amount').value = gespeichert.amount;
    var neigung = kartenNeigung($('gs-buehne'), $('gs-karte'));
    var gezeigt = reduce ? st.amount : 0;
    var bereit = true;

    $('gs-hinweis').textContent = reduce ? 'So sieht dein Gutschein aus.'
      : feinZeiger ? 'So sieht dein Gutschein aus. Fahr mit der Maus über die Karte.' : 'So sieht dein Gutschein aus. Zieh seitlich an der Karte.';

    function merken() {
      var o = { preset: st.preset, amount: st.amount, delivery: st.delivery, when: st.when, date: st.date };
      FELDER.forEach(function (f) { o[f] = $('gs-' + f).value; });
      sichere(FORM_KEY, o);
    }
    function meldung(text, warn) {
      var a = $('gs-alert');
      a.textContent = text || '';
      a.classList.toggle('on', !!text);
      a.classList.toggle('warn', !!warn);
    }

    // Wunschdatum: ab morgen, höchstens ein Jahr im Voraus
    var heute = new Date();
    $('gs-date').min = iso(new Date(heute.getFullYear(), heute.getMonth(), heute.getDate() + 1));
    $('gs-date').max = iso(new Date(heute.getFullYear() + 1, heute.getMonth(), heute.getDate()));
    if (st.date) $('gs-date').value = st.date;
    var gueltigBis = new Date(heute.getFullYear() + 3, heute.getMonth(), heute.getDate());
    $('gc-gueltig').textContent = 'gültig bis ' + datum(iso(gueltigBis));

    // Betrag zählt vom gezeigten Wert aus hoch oder runter (unterbrechbar)
    var zaehlRaf = 0;
    function betragZeigen(ziel) {
      var el = $('gc-betrag');
      cancelAnimationFrame(zaehlRaf);
      if (reduce) { gezeigt = ziel; el.innerHTML = euroHtml(ziel); return; }
      var von = gezeigt, t0 = performance.now(), dauer = Math.min(640, 260 + Math.abs(ziel - von) * 4);
      function f(jetzt) {
        var p = Math.min(1, (jetzt - t0) / dauer);
        p = 1 - Math.pow(1 - p, 3);
        gezeigt = von + (ziel - von) * p;
        el.innerHTML = euroHtml(Math.round(gezeigt));
        if (p < 1) zaehlRaf = requestAnimationFrame(f); else gezeigt = ziel;
      }
      zaehlRaf = requestAnimationFrame(f);
    }
    function platzhalter(el, wert, ph) {
      el.textContent = wert || ph;
      el.classList.toggle('ph', !wert);
    }
    function gueltigerBetrag() { return st.amount >= MIN && st.amount <= MAX && Math.floor(st.amount) === st.amount; }

    function karteAktualisieren(pop) {
      betragZeigen(st.amount || 0);
      if (pop) neigung.pop();
      $('gc-gedacht').textContent = st.preset && VORSCHLAG[st.preset] ? 'Gedacht für: ' + VORSCHLAG[st.preset] : '';
      $('gc-nachricht').textContent = $('gs-msg').value.trim();
      platzhalter($('gc-fuer'), $('gs-rname').value.trim(), 'Name');
      platzhalter($('gc-von'), $('gs-bname').value.trim(), 'Dein Name');
      $('gs-zahlen-text').textContent = 'Weiter zur Zahlung' + (gueltigerBetrag() ? ' · ' + euro(st.amount) : '');
      $('gs-zaehler').textContent = $('gs-msg').value.length + ' / 300';
      $('rname-opt').hidden = st.delivery === 'mail';
      var name = $('gs-rname').value.trim();
      var adresse = $('gs-remail').value.trim();
      var wer = name || 'Die beschenkte Person';
      var text;
      if (st.delivery === 'print') text = 'Nach der Zahlung lädst du das PDF zum Ausdrucken herunter. Es kommt auch per Mail an dich.';
      else if (st.when === 'date' && st.date) text = wer + ' bekommt den Gutschein am ' + datum(st.date, true) + ' um 8 Uhr per Mail' + (adresse ? ' an ' + adresse : '') + '.';
      else text = wer + ' bekommt den Gutschein direkt nach der Zahlung per Mail' + (adresse ? ' an ' + adresse : '') + '.';
      $('gs-zusammen').textContent = text;
    }

    /* Betrag */
    var kacheln = Array.prototype.slice.call(document.querySelectorAll('.gs-tile'));
    function kachelWaehlen(k, fokus) {
      kacheln.forEach(function (b) { b.setAttribute('aria-checked', b === k ? 'true' : 'false'); });
      var frei = k.classList.contains('frei');
      $('gs-frei').classList.toggle('on', frei);
      if (frei) {
        st.preset = '';
        var v = parseInt($('gs-amount').value, 10);
        st.amount = isNaN(v) ? 0 : v;
        if (fokus) $('gs-amount').focus();
      } else {
        st.preset = k.getAttribute('data-preset');
        st.amount = parseInt(k.getAttribute('data-amount'), 10);
        $('gs-frei').classList.remove('bad');
      }
      karteAktualisieren(true);
      merken();
    }
    kacheln.forEach(function (b) { b.addEventListener('click', function () { kachelWaehlen(b, true); }); });
    // Pfeiltasten in der Kachelgruppe wie bei Radio-Knöpfen
    $('gs-tiles').addEventListener('keydown', function (e) {
      var i = kacheln.indexOf(document.activeElement);
      if (i < 0) return;
      var n = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!n) return;
      e.preventDefault();
      var z = kacheln[(i + n + kacheln.length) % kacheln.length];
      z.focus(); kachelWaehlen(z, false);
    });
    var start = kacheln.filter(function (b) { return (b.getAttribute('data-preset') || '') === (st.preset || ''); })[0] || kacheln[1];
    kachelWaehlen(start, false);
    $('gs-amount').addEventListener('input', function () {
      this.value = this.value.replace(/[^0-9]/g, '').slice(0, 3);
      var v = parseInt(this.value, 10);
      st.amount = isNaN(v) ? 0 : v;
      if (gueltigerBetrag()) $('gs-frei').classList.remove('bad');
      karteAktualisieren(false);
      merken();
    });
    $('gs-amount').addEventListener('blur', function () {
      if (this.value && !gueltigerBetrag()) $('gs-frei').classList.add('bad');
    });

    /* Zustellung */
    var seg = Array.prototype.slice.call(document.querySelectorAll('#gs-seg button'));
    function zustellung(d) {
      st.delivery = d;
      seg.forEach(function (b) { b.setAttribute('aria-checked', b.getAttribute('data-delivery') === d ? 'true' : 'false'); });
      $('gs-seg').style.setProperty('--seg', d === 'print' ? '100%' : '0%');
      $('gs-mailbox').classList.toggle('on', d === 'mail');
      $('gs-printbox').classList.toggle('on', d === 'print');
      if (d === 'print') { $('f-rname').classList.remove('bad'); $('f-remail').classList.remove('bad'); }
      karteAktualisieren(false);
      merken();
    }
    seg.forEach(function (b) { b.addEventListener('click', function () { zustellung(b.getAttribute('data-delivery')); }); });
    zustellung(st.delivery);

    var wann = Array.prototype.slice.call(document.querySelectorAll('#gs-wann button'));
    function zeitpunkt(w) {
      st.when = w;
      wann.forEach(function (b) { b.setAttribute('aria-checked', b.getAttribute('data-when') === w ? 'true' : 'false'); });
      $('f-date').classList.toggle('on', w === 'date');
      if (w !== 'date') $('f-date').classList.remove('bad');
      karteAktualisieren(false);
      merken();
    }
    wann.forEach(function (b) {
      b.addEventListener('click', function () { zeitpunkt(b.getAttribute('data-when')); if (st.when === 'date') $('gs-date').focus(); });
    });
    zeitpunkt(st.when);
    $('gs-date').addEventListener('change', function () { st.date = this.value; $('f-date').classList.remove('bad'); karteAktualisieren(false); merken(); });

    FELDER.forEach(function (f) { $('gs-' + f).addEventListener('input', function () { karteAktualisieren(false); merken(); }); });

    /* Prüfungen: beim Verlassen des Felds, nicht bei jedem Tastendruck */
    var regeln = {
      rname: function () { return st.delivery !== 'mail' || !!$('gs-rname').value.trim(); },
      remail: function () { return st.delivery !== 'mail' || EMAIL.test($('gs-remail').value.trim()); },
      bname: function () { return !!$('gs-bname').value.trim(); },
      bemail: function () { return EMAIL.test($('gs-bemail').value.trim()); },
    };
    Object.keys(regeln).forEach(function (k) {
      $('gs-' + k).addEventListener('blur', function () {
        if (!this.value.trim()) return;
        $('f-' + k).classList.toggle('bad', !regeln[k]());
      });
      $('gs-' + k).addEventListener('input', function () { if (regeln[k]()) $('f-' + k).classList.remove('bad'); });
    });
    $('gs-terms').addEventListener('change', function () { if (this.checked) $('f-terms').classList.remove('bad'); });

    function pruefen() {
      var falsch = [];
      if (!gueltigerBetrag()) { $('gs-frei').classList.add('bad'); falsch.push($('gs-amount')); }
      Object.keys(regeln).forEach(function (k) {
        var gut = regeln[k]();
        $('f-' + k).classList.toggle('bad', !gut);
        if (!gut) falsch.push($('gs-' + k));
      });
      if (st.delivery === 'mail' && st.when === 'date') {
        var d = $('gs-date').value;
        var gut = !!d && d >= $('gs-date').min && d <= $('gs-date').max;
        $('f-date').classList.toggle('bad', !gut);
        if (!gut) falsch.push($('gs-date'));
      }
      if (!$('gs-terms').checked) { $('f-terms').classList.add('bad'); falsch.push($('gs-terms')); }
      if (falsch.length) {
        if (falsch[0] === $('gs-amount')) kachelWaehlen(kacheln[kacheln.length - 1], false);
        falsch[0].focus();
        if (falsch[0].scrollIntoView) falsch[0].scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
        return false;
      }
      return true;
    }

    var FEHLER = {
      bad_amount: 'Wähl einen Betrag zwischen 10 und 200 €.',
      bad_email: 'Deine E-Mail-Adresse stimmt nicht. Prüf sie bitte.',
      bad_buyer: 'Gib deinen Namen ein.',
      bad_recipient: 'Gib den Namen der beschenkten Person ein.',
      bad_recipient_email: 'Die E-Mail-Adresse der beschenkten Person stimmt nicht.',
      bad_date: 'Wähl ein Wunschdatum ab morgen, höchstens ein Jahr im Voraus.',
      terms: 'Bestätige bitte, dass du die Gutscheinbedingungen gelesen hast.',
      too_many_requests: 'Gerade kommen zu viele Anfragen. Versuch es in ein paar Minuten noch einmal.',
      rate_limited: 'Gerade kommen zu viele Anfragen. Versuch es in ein paar Minuten noch einmal.',
      not_configured: 'Der Gutscheinkauf ist gerade nicht verfügbar. Schreib uns an info@grillnchill-foodtruck.de.',
    };

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!bereit) return;
      meldung('');
      if (!pruefen()) return;
      var knopf = $('gs-zahlen');
      if (knopf.disabled) return;
      knopf.disabled = true;
      var warte = setTimeout(function () { knopf.classList.add('busy'); }, 150);
      var alt = lade(PENDING_KEY, localStorage);
      var body = {
        v: 2,
        amount: st.amount,
        preset: st.preset || '',
        email: $('gs-bemail').value.trim(),
        buyerName: $('gs-bname').value.trim(),
        recipientName: $('gs-rname').value.trim(),
        recipientEmail: st.delivery === 'mail' ? $('gs-remail').value.trim() : '',
        message: $('gs-msg').value.trim(),
        delivery: st.delivery,
        sendOn: st.delivery === 'mail' && st.when === 'date' ? $('gs-date').value : '',
        terms: $('gs-terms').checked,
        supersedes: alt && alt.reference && alt.checkoutId ? { reference: alt.reference, checkoutId: alt.checkoutId } : null,
      };
      fetch(API + 'giftcard-checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (res.ok && res.d.hosted_checkout_url) {
            sichere(PENDING_KEY, { checkoutId: res.d.id, reference: res.d.reference, email: body.email, at: Date.now() }, localStorage);
            merken();
            location.href = res.d.hosted_checkout_url;
            return;
          }
          throw res.d || {};
        })
        .catch(function (d) {
          clearTimeout(warte);
          knopf.classList.remove('busy');
          knopf.disabled = false;
          meldung(FEHLER[d && d.error] || 'Das hat nicht geklappt. Prüf deine Verbindung und versuch es noch einmal.', true);
          $('gs-alert').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
        });
    });

    // Zurück von SumUp über den Zurück-Pfeil (Back/Forward-Cache): Knopf wieder frei
    window.addEventListener('pageshow', function (e) {
      if (!e.persisted) return;
      var k = $('gs-zahlen'); k.disabled = false; k.classList.remove('busy');
    });

    return { meldung: meldung };
  }

  /* =================== Danke =================== */
  function danke(shopApi) {
    var p = new URLSearchParams(location.search);
    if (p.get('payment') !== 'return') return;
    urlOhneParameter();
    var offen = lade(PENDING_KEY, localStorage);
    $('shopAnsicht').hidden = true;
    $('danke').classList.add('on');
    window.scrollTo(0, 0);
    function zeige(n) {
      ['pruefen', 'ok', 'langsam', 'fehler'].forEach(function (x) { $('dk-' + x).hidden = x !== n; });
    }
    function zumShop(text) {
      $('danke').classList.remove('on');
      $('shopAnsicht').hidden = false;
      if (shopApi && text) shopApi.meldung(text, true);
    }
    if (!offen || !offen.checkoutId || !offen.reference) { zeige('langsam'); return; }
    zeige('pruefen');
    var versuche = 0, seit = Date.now(), daten = null;
    function abfragen() {
      versuche++;
      fetch(API + 'giftcard-status?ref=' + encodeURIComponent(offen.reference) + '&id=' + encodeURIComponent(offen.checkoutId), { cache: 'no-store' })
        .then(function (r) { if (r.status === 404) throw { fehlt: true }; return r.json(); })
        .then(function (d) {
          if (d.state === 'paid') return bezahlt(d);
          if (d.state === 'failed') { weg(PENDING_KEY, localStorage); return zeige('fehler'); }
          if (d.state === 'open') {
            // Ohne Zahlung zurück: Vorgang still stornieren, Formular mit den Angaben zeigen
            fetch(API + 'giftcard-checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cancelOnly: true, supersedes: { reference: offen.reference, checkoutId: offen.checkoutId } }) }).catch(function () {});
            weg(PENDING_KEY, localStorage);
            return zumShop('Die Zahlung wurde nicht abgeschlossen. Wir haben nichts abgebucht, deine Angaben sind noch da.');
          }
          weiter();
        })
        .catch(function (err) { if (err && err.fehlt) return zeige('langsam'); weiter(); });
    }
    function weiter() {
      if (Date.now() - seit > 60000) return zeige('langsam');
      setTimeout(abfragen, versuche < 10 ? 1500 : 3000);
    }
    function bezahlt(d) {
      daten = d;
      weg(PENDING_KEY, localStorage);
      weg(FORM_KEY);
      $('dk-code').textContent = d.code;
      $('dk-betrag').textContent = euro(d.amount);
      $('dk-meta').textContent = (d.recipientName ? 'Für ' + d.recipientName + ' · ' : '') + (d.validUntil ? 'gültig bis ' + datum(d.validUntil) : '');
      var t;
      if (d.delivery === 'print') t = 'Lad dir das PDF herunter und druck es aus. Die Karte zum Ausschneiden ist drauf.';
      else if (d.delivery === 'mail' && d.sendOn && !d.recipientMailed) t = (d.recipientName || 'Die beschenkte Person') + ' bekommt ihn am ' + datum(d.sendOn, true) + ' um 8 Uhr per Mail.';
      else if (d.delivery === 'mail') t = 'Wir haben ihn an ' + (d.recipientName || 'die beschenkte Person') + ' geschickt.';
      else t = 'Gib den Code weiter oder bestell selbst damit.';
      $('dk-weg').textContent = t;
      $('dk-mail').textContent = offen.email || 'deine Adresse';
      if (d.pdf) {
        $('dk-pdf').href = d.pdfDownload; $('dk-pdf2').href = d.pdf;
      } else {
        $('dk-pdf').hidden = true; $('dk-pdf2').hidden = true;
      }
      zeige('ok');
    }
    $('dk-nochmal').addEventListener('click', function () { seit = Date.now(); versuche = 0; zeige('pruefen'); abfragen(); });
    $('dk-kopieren').addEventListener('click', function () {
      var k = this;
      if (!daten || !navigator.clipboard) return;
      navigator.clipboard.writeText(daten.code).then(function () {
        k.textContent = 'Kopiert';
        setTimeout(function () { k.textContent = 'Code kopieren'; }, 1800);
      }, function () {});
    });
    abfragen();
  }

  /* =================== Prüfen =================== */
  function pruefSeite() {
    var eingabe = $('pr-code'), box = $('pr-ergebnis');
    function format(v) {
      var s = String(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (s.indexOf('GNC') === 0) s = s.slice(3);
      s = s.slice(0, 6);
      return 'GNC' + s;
    }
    eingabe.addEventListener('input', function () {
      var f = this.value.trim() ? format(this.value) : '';
      if (f !== this.value) this.value = f;
    });
    function zeigen(r) {
      box.hidden = false;
      box.className = 'pr-ergebnis ' + (r.valid ? 'ok' : 'bad');
      box.textContent = '';
      if (!r.valid) {
        var p = document.createElement('p');
        p.className = 'pr-msg';
        p.textContent = {
          format: 'Ein Gutschein-Code beginnt mit GNC, dahinter folgen sechs Zeichen, zum Beispiel GNCK7P2QX.',
          unknown: 'Diesen Code finden wir nicht. Prüf die Schreibweise, 0 und O kommen nicht vor.',
          used: 'Dieser Gutschein wurde schon eingelöst.',
          expired: 'Dieser Gutschein ist am ' + datum(r.validUntil) + ' abgelaufen.',
          inactive: 'Dieser Gutschein ist gesperrt. Schreib uns an info@grillnchill-foodtruck.de.',
          rate: 'Zu viele Versuche. Probier es in ein paar Minuten noch einmal.',
        }[r.reason] || 'Das hat nicht geklappt. Versuch es noch einmal.';
        box.appendChild(p);
        return;
      }
      var kopf = document.createElement('div'); kopf.className = 'pr-kopf';
      var badge = document.createElement('span'); badge.className = 'pr-badge'; badge.textContent = 'Gültig';
      var code = document.createElement('span'); code.className = 'pr-code'; code.textContent = r.code;
      kopf.appendChild(badge); kopf.appendChild(code);
      var betrag = document.createElement('div'); betrag.className = 'pr-betrag'; betrag.textContent = euro(r.value);
      var meta = document.createElement('p'); meta.className = 'pr-meta';
      meta.textContent = 'Einlösbar ab ' + euro(r.minOrder) + ' Bestellwert · gültig bis ' + datum(r.validUntil);
      var los = document.createElement('a'); los.className = 'btn';
      los.href = (inApp ? '/?app=1&gutschein=' : '/?gutschein=') + encodeURIComponent(r.code) + '#menu';
      los.textContent = 'Jetzt Burger aussuchen';
      [kopf, betrag, meta, los].forEach(function (x) { box.appendChild(x); });
    }
    function abschicken() {
      var c = eingabe.value.trim();
      if (!c) { eingabe.focus(); return; }
      var k = $('pr-knopf');
      k.disabled = true;
      fetch(API + 'giftcard-check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: c }) })
        .then(function (r) { if (r.status === 429) return { valid: false, reason: 'rate' }; return r.json(); })
        .then(zeigen)
        .catch(function () { zeigen({ valid: false, reason: '' }); })
        .then(function () { k.disabled = false; });
    }
    $('pr-form').addEventListener('submit', function (e) { e.preventDefault(); abschicken(); });
    var vorab = new URLSearchParams(location.search).get('code');
    if (vorab) {
      eingabe.value = format(vorab);
      urlOhneParameter();
      $('pruefen').scrollIntoView({ behavior: 'auto', block: 'start' });
      abschicken();
    }
  }

  var api = shop();
  danke(api);
  pruefSeite();
})();
