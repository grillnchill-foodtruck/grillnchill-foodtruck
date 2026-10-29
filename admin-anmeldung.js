/* ============================================================================
   admin-anmeldung.js
   Anmeldung mit Passwort und Code für Admin-Tool, Dienstplan und Cockpit.
   Server: netlify/functions/team.js (action "anmelden"), lib/zweifaktor.js.

   Benutzung auf der Seite:
     const r = await GNCAnmeldung.anmelden(passwort, { merken: true });
     r = { ok: true, token, exp, role, name }
       | { ok: false, grund: 'passwort' | 'gesperrt' | 'abbruch' | 'netz' | 'stoerung', retryAfter }

   Das Fenster für den Code, die erste Einrichtung (QR-Code) und die
   Notfallcodes bringt diese Datei selbst mit, samt eigenem Stil. Die Seite
   speichert danach nur den Token, nie das Passwort.
   ========================================================================== */
(function () {
  'use strict';

  var URL_TEAM = '/.netlify/functions/team';
  var TOKEN_FORM = /^gncs_[a-f0-9]{64}$/;

  var STIL = '\
.gzf-ov{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(8,7,5,.8);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}\
.gzf-box{width:min(430px,100%);max-height:calc(100dvh - 32px);overflow:auto;background:#17140F;border:1px solid #2E2820;border-radius:20px;padding:1.4rem 1.3rem 1.2rem;color:#F5E9D0;font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 24px 70px rgba(0,0,0,.55);animation:gzfRein .22s cubic-bezier(.16,1,.3,1)}\
@keyframes gzfRein{from{opacity:0;transform:translateY(14px)}}\
@media(prefers-reduced-motion:reduce){.gzf-box{animation:none}}\
.gzf-box h2{font-family:"Bowlby One",Inter,sans-serif;font-weight:400;font-size:1.25rem;line-height:1.25;margin:0 0 .5rem;letter-spacing:0}\
.gzf-box p{margin:0 0 .9rem;color:#C9BCA4;font-size:.92rem;line-height:1.5}\
.gzf-schritt{font-size:.7rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#FF7A3D;margin-bottom:.35rem}\
.gzf-qr{background:#fff;border-radius:14px;padding:10px;width:196px;height:196px;margin:.2rem auto 1rem;display:flex;align-items:center;justify-content:center}\
.gzf-qr svg{width:100%;height:100%}\
.gzf-geheim{display:flex;align-items:center;gap:.5rem;background:#100E0B;border:1px solid #2E2820;border-radius:10px;padding:.55rem .7rem;margin:0 0 .9rem}\
.gzf-geheim code{flex:1;font:600 .86rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;color:#F5E9D0;word-break:break-all}\
.gzf-klein{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:.35rem .8rem;border:1px solid #3a3228;border-radius:999px;background:none;color:#C9BCA4;font:700 .78rem Inter,sans-serif;text-decoration:none;cursor:pointer;white-space:nowrap}\
.gzf-klein:hover{border-color:#E85A24;color:#F5E9D0}\
.gzf-geraet{display:flex;justify-content:center;margin:-.2rem 0 1rem}\
.gzf-feld{width:100%;min-height:54px;padding:.7rem .9rem;background:#100E0B;border:1px solid #3a3228;border-radius:12px;color:#F5E9D0;font:700 1.45rem/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.3em;text-align:center}\
.gzf-feld.notfall{font-size:1.05rem;letter-spacing:.12em}\
.gzf-feld:focus{outline:none;border-color:#FF7A3D;box-shadow:0 0 0 3px rgba(255,122,61,.25)}\
.gzf-fehler{min-height:1.2em;margin:.5rem 0 0;color:#FF8A6B;font-size:.85rem;font-weight:600}\
.gzf-knoepfe{display:flex;gap:.6rem;margin-top:1rem}\
.gzf-knoepfe button{flex:1}\
.gzf-haupt{min-height:48px;border:0;border-radius:12px;background:#CC4715;color:#fff;font:800 .95rem Inter,sans-serif;cursor:pointer}\
.gzf-haupt:disabled{opacity:.55;cursor:default}\
.gzf-neben{min-height:48px;border:1px solid #3a3228;border-radius:12px;background:none;color:#C9BCA4;font:700 .9rem Inter,sans-serif;cursor:pointer}\
.gzf-unten{display:flex;justify-content:center;margin-top:.9rem}\
.gzf-codes{display:grid;grid-template-columns:1fr 1fr;gap:.45rem;margin:0 0 .9rem;padding:.8rem;background:#100E0B;border:1px solid #2E2820;border-radius:12px}\
.gzf-codes span{font:600 .95rem ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;text-align:center}\
.gzf-check{display:flex;gap:.6rem;align-items:flex-start;font-size:.88rem;color:#C9BCA4;cursor:pointer}\
.gzf-check input{width:20px;height:20px;margin-top:1px;accent-color:#E85A24;flex:none}\
.gzf-box button:focus-visible,.gzf-box a:focus-visible,.gzf-box input:focus-visible{outline:3px solid #FF7A3D;outline-offset:2px}\
';

  function stilEinbauen() {
    if (document.getElementById('gzfStil')) return;
    var s = document.createElement('style');
    s.id = 'gzfStil';
    s.textContent = STIL;
    document.head.appendChild(s);
  }
  function el(html) { var d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function wartezeit(sek) {
    var s = Math.max(1, Number(sek) || 0);
    if (s < 60) return s + ' Sekunden';
    var m = Math.ceil(s / 60);
    return m + (m === 1 ? ' Minute' : ' Minuten');
  }

  async function senden(body) {
    var res;
    try {
      res = await fetch(URL_TEAM, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) { return { status: 0, d: {} }; }
    var d = await res.json().catch(function () { return {}; });
    return { status: res.status, d: d };
  }

  function qrLaden() {
    if (window.qrcode) return Promise.resolve();
    return new Promise(function (ok, nein) {
      var s = document.createElement('script');
      s.src = '/vendor/qrcode.js';
      s.onload = ok; s.onerror = nein;
      document.head.appendChild(s);
    });
  }
  async function kopieren(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
    try {
      var t = document.createElement('textarea');
      t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      var ok = document.execCommand('copy'); t.remove(); return ok;
    } catch (e) { return false; }
  }

  /* ---- Fenster ------------------------------------------------------------ */
  function fenster() {
    stilEinbauen();
    var vorher = document.activeElement;
    var ov = el('<div class="gzf-ov" role="dialog" aria-modal="true" aria-labelledby="gzfTitel"><div class="gzf-box"></div></div>');
    document.body.appendChild(ov);
    var box = ov.firstChild;
    var api = {
      box: box,
      zeigen: function (html) { box.innerHTML = html; },
      zu: function () { ov.remove(); document.removeEventListener('keydown', taste, true); try { if (vorher && vorher.focus) vorher.focus(); } catch (e) {} },
      beiEscape: null,
    };
    function taste(e) {
      if (e.key === 'Escape' && api.beiEscape) { e.preventDefault(); api.beiEscape(); return; }
      if (e.key !== 'Tab') return;
      var f = box.querySelectorAll('button:not([disabled]),a[href],input:not([disabled])');
      if (!f.length) return;
      var erst = f[0], letzt = f[f.length - 1];
      if (e.shiftKey && document.activeElement === erst) { e.preventDefault(); letzt.focus(); }
      else if (!e.shiftKey && document.activeElement === letzt) { e.preventDefault(); erst.focus(); }
    }
    document.addEventListener('keydown', taste, true);
    return api;
  }

  /* Code abfragen. Bei der Einrichtung mit QR-Code und Geheimnis davor. */
  function codeFenster(passwort, merken, start) {
    return new Promise(function (fertig) {
      var f = fenster();
      var einrichtung = start.schritt === 'einrichten' ? start.einrichtung : null;
      var notfall = false;

      function abbrechen() { f.zu(); fertig({ ok: false, grund: 'abbruch' }); }
      f.beiEscape = abbrechen;

      var kopf = einrichtung
        ? '<div class="gzf-schritt">Einmalig einrichten</div>'
          + '<h2 id="gzfTitel">Zwei-Faktor für ' + esc(start.name) + '</h2>'
          + '<p>Zum Anmelden brauchst du ab jetzt zusätzlich einen Code aus einer Authenticator-App. Auf dem iPhone kann das die Passwörter-App, sonst zum Beispiel Google Authenticator.</p>'
          + '<p><b>1.</b> Scanne den QR-Code mit der App.</p>'
          + '<div class="gzf-qr" id="gzfQr" aria-label="QR-Code zum Einrichten"></div>'
          + '<div class="gzf-geraet"><a class="gzf-klein" href="' + esc(start.url) + '">Auf diesem Gerät einrichten</a></div>'
          + '<p style="margin-bottom:.4rem">Oder gib den Schlüssel von Hand ein:</p>'
          + '<div class="gzf-geheim"><code>' + esc(start.geheim.replace(/(.{4})/g, '$1 ').trim()) + '</code><button type="button" class="gzf-klein" id="gzfKopie">Kopieren</button></div>'
          + '<p><b>2.</b> Gib den 6-stelligen Code ein, den die App jetzt zeigt.</p>'
        : '<div class="gzf-schritt">Zweiter Schritt</div>'
          + '<h2 id="gzfTitel">Code aus deiner App</h2>'
          + '<p id="gzfText">Öffne deine Authenticator-App und gib den 6-stelligen Code für Grill\'n Chill ein.</p>';

      f.zeigen(kopf
        + '<form id="gzfForm" novalidate>'
        + '<input class="gzf-feld" id="gzfCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" aria-label="Code" aria-describedby="gzfFehler" spellcheck="false" autocapitalize="off">'
        + '<p class="gzf-fehler" id="gzfFehler" role="alert"></p>'
        + '<div class="gzf-knoepfe"><button type="button" class="gzf-neben" id="gzfAbbruch">Abbrechen</button><button type="submit" class="gzf-haupt" id="gzfLos">' + (einrichtung ? 'Bestätigen' : 'Anmelden') + '</button></div>'
        + (einrichtung ? '' : '<div class="gzf-unten"><button type="button" class="gzf-klein" id="gzfNotfall">Handy nicht da? Notfallcode eingeben</button></div>')
        + '</form>');

      var feld = f.box.querySelector('#gzfCode');
      var fehler = f.box.querySelector('#gzfFehler');
      var los = f.box.querySelector('#gzfLos');
      f.box.querySelector('#gzfAbbruch').onclick = abbrechen;

      if (einrichtung) {
        qrLaden().then(function () {
          var q = window.qrcode(0, 'M'); q.addData(start.url); q.make();
          f.box.querySelector('#gzfQr').innerHTML = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
        }).catch(function () { f.box.querySelector('#gzfQr').style.display = 'none'; });
        f.box.querySelector('#gzfKopie').onclick = async function () {
          this.textContent = (await kopieren(start.geheim)) ? 'Kopiert' : 'Nicht möglich';
        };
      } else {
        f.box.querySelector('#gzfNotfall').onclick = function () {
          notfall = !notfall;
          feld.value = ''; fehler.textContent = '';
          feld.classList.toggle('notfall', notfall);
          feld.setAttribute('inputmode', notfall ? 'text' : 'numeric');
          feld.setAttribute('maxlength', notfall ? '11' : '6');
          feld.setAttribute('autocomplete', notfall ? 'off' : 'one-time-code');
          feld.setAttribute('aria-label', notfall ? 'Notfallcode' : 'Code');
          feld.placeholder = notfall ? 'abcde-fghij' : '';
          f.box.querySelector('#gzfText').textContent = notfall
            ? 'Gib einen deiner Notfallcodes ein. Jeder gilt nur einmal.'
            : 'Öffne deine Authenticator-App und gib den 6-stelligen Code für Grill\'n Chill ein.';
          this.textContent = notfall ? 'Doch mit Code aus der App' : 'Handy nicht da? Notfallcode eingeben';
          feld.focus();
        };
      }

      // Sechs Ziffern komplett: gleich abschicken
      feld.addEventListener('input', function () {
        if (!notfall) feld.value = feld.value.replace(/\D/g, '').slice(0, 6);
        fehler.textContent = '';
        if (!notfall && feld.value.length === 6) f.box.querySelector('#gzfForm').requestSubmit();
      });

      var laeuft = false;
      f.box.querySelector('#gzfForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        if (laeuft) return;
        var code = feld.value.trim();
        if (!notfall && code.length !== 6) { fehler.textContent = 'Der Code hat 6 Ziffern.'; feld.focus(); return; }
        if (notfall && code.replace(/[^a-z0-9]/gi, '').length !== 10) { fehler.textContent = 'Ein Notfallcode hat 10 Zeichen, zum Beispiel abcde-fghij.'; feld.focus(); return; }
        laeuft = true; los.disabled = true;
        var body = { action: 'anmelden', password: passwort, code: code, merken: !!merken };
        if (einrichtung) body.einrichtung = einrichtung;
        var r = await senden(body);
        laeuft = false; los.disabled = false;
        if (r.status === 200 && r.d.ok && r.d.token) {
          var erfolg = { ok: true, token: r.d.token, exp: r.d.exp, role: r.d.role, name: r.d.name || '' };
          if (r.d.notfallCodes) { notfallCodesZeigen(f, r.d.notfallCodes, function () { f.zu(); fertig(erfolg); }); return; }
          if (typeof r.d.notfallRest === 'number') {
            hinweisZeigen(f, 'Mit Notfallcode angemeldet', 'Du hast noch ' + r.d.notfallRest + ' Notfallcodes. Hast du dein Handy verloren, lass dir im Admin-Tool unter Team die Zwei-Faktor-App zurücksetzen und richte sie neu ein.', function () { f.zu(); fertig(erfolg); });
            return;
          }
          f.zu(); fertig(erfolg); return;
        }
        feld.value = ''; feld.focus();
        if (r.status === 401) fehler.textContent = notfall ? 'Dieser Notfallcode passt nicht oder ist schon benutzt.' : 'Der Code passt nicht. Nimm den aktuellen aus der App.';
        else if (r.status === 429) fehler.textContent = 'Zu viele falsche Codes. Bitte in ' + wartezeit(r.d.retryAfter) + ' erneut versuchen.';
        else if (r.status === 410) { f.zu(); fertig({ ok: false, grund: 'stoerung', hinweis: 'Die Einrichtung hat zu lange gedauert. Bitte neu anmelden.' }); }
        else if (r.status === 0) fehler.textContent = 'Keine Verbindung. Bitte erneut versuchen.';
        else fehler.textContent = 'Gerade nicht möglich. Bitte erneut versuchen.';
      });

      // Bei der Einrichtung nicht gleich ins Feld: die Tastatur verdeckte auf dem Handy sonst den QR-Code
      setTimeout(function () { (einrichtung ? f.box.querySelector('.gzf-klein') : feld).focus(); }, 30);
    });
  }

  function notfallCodesZeigen(f, codes, weiter) {
    f.beiEscape = null;   // nicht aus Versehen wegdrücken, die Codes gibt es nur jetzt
    f.zeigen('<div class="gzf-schritt">Fertig eingerichtet</div>'
      + '<h2 id="gzfTitel">Deine Notfallcodes</h2>'
      + '<p>Ist dein Handy weg, meldest du dich mit einem dieser Codes an. Jeder gilt einmal. Sicher sie jetzt, zum Beispiel in deinem Passwort-Manager. Wir zeigen sie nur dieses eine Mal.</p>'
      + '<div class="gzf-codes">' + codes.map(function (c) { return '<span>' + esc(c) + '</span>'; }).join('') + '</div>'
      + '<div style="display:flex;justify-content:center;margin:-.2rem 0 1rem"><button type="button" class="gzf-klein" id="gzfKopieCodes">Codes kopieren</button></div>'
      + '<label class="gzf-check"><input type="checkbox" id="gzfGesichert"> <span>Ich habe die Codes gesichert.</span></label>'
      + '<div class="gzf-knoepfe"><button type="button" class="gzf-haupt" id="gzfWeiter" disabled>Weiter</button></div>');
    f.box.querySelector('#gzfKopieCodes').onclick = async function () {
      this.textContent = (await kopieren("Grill'n Chill Notfallcodes\n" + codes.join('\n'))) ? 'Kopiert' : 'Nicht möglich';
    };
    var weiterKnopf = f.box.querySelector('#gzfWeiter');
    f.box.querySelector('#gzfGesichert').onchange = function () { weiterKnopf.disabled = !this.checked; };
    weiterKnopf.onclick = weiter;
    setTimeout(function () { f.box.querySelector('#gzfKopieCodes').focus(); }, 30);
  }

  function hinweisZeigen(f, titel, text, weiter) {
    f.zeigen('<h2 id="gzfTitel">' + esc(titel) + '</h2><p>' + esc(text) + '</p>'
      + '<div class="gzf-knoepfe"><button type="button" class="gzf-haupt" id="gzfWeiter">Weiter</button></div>');
    f.beiEscape = weiter;
    f.box.querySelector('#gzfWeiter').onclick = weiter;
    setTimeout(function () { f.box.querySelector('#gzfWeiter').focus(); }, 30);
  }

  /* ---- Einstieg ----------------------------------------------------------- */
  async function anmelden(passwort, optionen) {
    var merken = !!(optionen && optionen.merken);
    var r = await senden({ action: 'anmelden', password: passwort, merken: merken });
    if (r.status === 0) return { ok: false, grund: 'netz' };
    if (r.status === 401) return { ok: false, grund: 'passwort' };
    if (r.status === 429) return { ok: false, grund: 'gesperrt', retryAfter: Number(r.d.retryAfter) || 900 };
    if (r.status !== 200) return { ok: false, grund: 'stoerung', hinweis: r.d && r.d.hint };
    if (r.d.ok && r.d.token) return { ok: true, token: r.d.token, exp: r.d.exp, role: r.d.role, name: r.d.name || '' };
    if (r.d.schritt === 'code' || r.d.schritt === 'einrichten') return codeFenster(passwort, merken, r.d);
    return { ok: false, grund: 'stoerung' };
  }

  window.GNCAnmeldung = {
    anmelden: anmelden,
    istToken: function (x) { return typeof x === 'string' && TOKEN_FORM.test(x); },
    wartezeit: wartezeit,
  };
})();
