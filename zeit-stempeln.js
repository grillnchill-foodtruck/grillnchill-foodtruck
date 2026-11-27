/* ============================================================================
   zeit-stempeln.js
   Stempeln am iPad im Cockpit (cockpit.html). Kubi koppelt das iPad einmal als Stempeluhr (Karte
   „Dieses iPad als Stempeluhr“, nur mit Admin-Sitzung). Danach zeigt das Cockpit den Knopf „Stempeln“, auch
   abgemeldet. Das Sheet zeigt die Namensliste (erst mit Schicht heute, dann „Weitere“), nach dem Antippen
   die passenden Knöpfe und danach 10 Sekunden lang „Rückgängig“.
   Server: netlify/functions/zeit.js (Token im Feld stempeluhr), Kopplung über team-device.js.
   Warteschlange und Texte: zeit-kern.js. Token: localStorage gnc_stempeluhr { token, name, id }.
   Der Token geht NUR an /.netlify/functions/zeit, nie als teamToken an Cockpit-Zahlen, Bestellungen oder andere
   Endpunkte (jede Abweisung dort zählt als Fehlversuch). Ohne Token wird nichts gesendet.
   Das Cockpit meldet per Ereignis 'gnc-cockpit' { owner, cred, role }, wer angemeldet ist.
   Abgelehnte Stempel (Server sagt nein, Stempel bleibt auf dem iPad) stehen in der Liste unter „Nicht übertragen“
   mit „Nochmal senden“ und „Verwerfen“. Verwerfen geht nur mit Rückgängig, ohne Bestätigungsdialog.
   ========================================================================== */
(function () {
  'use strict';
  var K = window.GNCZeit;
  if (!K) return;
  var URL_ZEIT = '/.netlify/functions/zeit';
  var URL_GERAET = '/.netlify/functions/team-device';
  var TOKEN_KEY = 'gnc_stempeluhr';
  var STAND_KEY = 'gnc_zeit_stand';
  var RUECKGAENGIG_SEK = 10;
  var VERWERFEN_MS = 6000;
  var ART = { beginn: 'Schicht beginnen', pause_beginn: 'Pause beginnen', pause_ende: 'Pause beenden', ende: 'Schicht beenden' };
  var $ = function (id) { return document.getElementById(id); };
  var X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // Gesperrter Speicher wirft schon beim Zugriff auf window.localStorage
  function speicherHolen() {
    try { return window.localStorage; } catch (e) { return null; }
  }
  var SPEICHER = speicherHolen() || { getItem: function () { return null; }, setItem: function () { throw new Error('kein Speicher'); } };
  function lies(k) { try { return JSON.parse(window.localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function schreib(k, v) { try { if (v == null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  var fehlercode = function (daten) { return daten && (daten.fehler || daten.error); };

  var st = {
    cred: '', role: '', dlg: null, inhalt: null, tiefe: 0, ignorieren: 0, daten: lies(STAND_KEY), uhr: null, zuTimer: null,
    offline: false, speicherFehler: false, vorgang: 0, ansicht: '', meldung: '', weg: {},
  };
  var geraet = function () { var g = lies(TOKEN_KEY); return g && typeof g.token === 'string' && g.token ? g : null; };

  // Eine Antwort ohne JSON (HTML-Fehlerseite) gibt { status, daten: {} }, ein Netzfehler { status: 0, daten: {} }
  async function post(url, body) {
    try {
      var r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      var d = await r.json().catch(function () { return {}; });
      return { status: r.status, daten: d && typeof d === 'object' ? d : {} };
    } catch (e) { return { status: 0, daten: {} }; }
  }
  var q = K.warteschlange({
    speicher: SPEICHER, via: 'stempeluhr',
    senden: function (e) {
      var g = geraet();
      // Ohne gültigen Token nie senden: Ein leerer Token würde als Fehlversuch zählen
      if (!g) return Promise.resolve({ status: 401, daten: {} });
      var body = e.typ === 'stempeln'
        ? { stempeluhr: g.token, aktion: 'stempeln', schluessel: e.schluessel, person_id: e.person_id, art: e.art, zeit: e.zeit }
        : { stempeluhr: g.token, aktion: 'zuruecknehmen', schluessel: e.schluessel, person_id: e.person_id, bezug_schluessel: e.bezug_schluessel, zeit: e.zeit };
      return post(URL_ZEIT, body);
    },
  });

  var TEXT_ENTKOPPELT = 'Dieses iPad ist nicht mehr als Stempeluhr gekoppelt. Kubi koppelt es im Cockpit neu.';

  /* ---------------- Knöpfe und Kopplungskarte im Cockpit ---------------- */
  function knoepfeZeigen() {
    var g = geraet();
    var offen = q.abgelehnt().length;
    // Auch ohne Token sichtbar, solange Stempel auf dem iPad liegen: Sie sollen nicht unsichtbar bleiben
    var da = !!g || offen > 0 || q.wartend().length > 0;
    document.querySelectorAll('[data-stempeln]').forEach(function (b) {
      b.hidden = !da;
      var s = b.querySelector('span');
      if (s) s.textContent = offen ? 'Stempeln (' + offen + ' offen)' : 'Stempeln';
    });
    var karte = $('cardStempeluhr');
    if (!karte) return;
    karte.hidden = !(st.role === 'superadmin' || st.role === 'admin');
    $('stempeluhrForm').hidden = !!g;
    $('stempeluhrGekoppelt').hidden = !g;
    if (g) $('stempeluhrGekoppelt').textContent = 'Gekoppelt als „' + g.name + '“. Entkoppeln geht im Admin-Tool unter Team-Geräte.';
  }
  function entkoppelt() {
    schreib(TOKEN_KEY, null);
    knoepfeZeigen();
  }
  document.addEventListener('gnc-cockpit', function (e) {
    st.cred = (e.detail && e.detail.cred) || '';
    st.role = (e.detail && e.detail.role) || '';
    knoepfeZeigen();
  });

  async function koppeln(ev) {
    ev.preventDefault();
    var knopf = $('stempeluhrKnopf'), fehler = $('stempeluhrFehler');
    var name = $('stempeluhrName').value.trim() || 'iPad Truck';
    if (knopf.getAttribute('aria-busy') === 'true') return;
    knopf.setAttribute('aria-busy', 'true');
    fehler.hidden = true;
    var c = await post(URL_GERAET, { action: 'create', password: st.cred, zweck: 'stempeluhr', name: name });
    var r = c.status === 200 && c.daten.code ? await post(URL_GERAET, { action: 'redeem', code: c.daten.code, device: name }) : null;
    knopf.removeAttribute('aria-busy');
    if (!r || r.status !== 200 || !r.daten.token) {
      fehler.textContent = c.status === 403 ? 'Nur Admins können eine Stempeluhr koppeln.' : c.status === 401 ? 'Deine Anmeldung ist abgelaufen. Melde dich neu an.' : 'Koppeln hat nicht geklappt. Versuch es noch einmal.';
      fehler.hidden = false;
      return;
    }
    schreib(TOKEN_KEY, { token: r.daten.token, name: r.daten.name, id: r.daten.id });
    knoepfeZeigen();
    // Was während der Entkopplung liegen blieb, geht jetzt raus
    nachsenden();
  }

  /* ---------------- Sheet ---------------- */
  function bauen() {
    var d = document.createElement('dialog');
    d.className = 'zs-dlg';
    d.setAttribute('aria-labelledby', 'zsTitel');
    d.innerHTML = '<div class="zs-sheet" tabindex="-1" autofocus><div class="zs-griff" aria-hidden="true"></div>'
      + '<div class="zs-kopf"><h2 id="zsTitel">Stempeln</h2><button type="button" class="zs-x" data-zs-zu aria-label="Schließen">' + X + '</button></div>'
      + '<div data-zs-inhalt></div>'
      + '<div class="zs-fuss"><a class="zs-pille" href="/zeit/datenschutz">Datenschutz</a><span class="zs-wartend" data-zs-wartend aria-live="polite"></span></div></div>';
    document.body.appendChild(d);
    // iOS-Safari verscrollt sonst die Hülle beim Einfahren
    d.addEventListener('scroll', function () { if (d.scrollTop || d.scrollLeft) d.scrollTo(0, 0); });
    d.addEventListener('cancel', function (ev) { ev.preventDefault(); zu(); });
    d.addEventListener('click', function (ev) {
      var t = ev.target;
      if (t === d || t.closest('[data-zs-zu]')) return zu();
      var p = t.closest('[data-zs-person]');
      if (p) return personZeigen(p.getAttribute('data-zs-person'), true);
      var a = t.closest('[data-zs-art]');
      if (a) return stempeln(a.getAttribute('data-zs-person-id'), a.getAttribute('data-zs-art'));
      var n = t.closest('[data-zs-nochmal]');
      if (n) return nochmalSenden(n.getAttribute('data-zs-nochmal'), n);
      var v = t.closest('[data-zs-verwerfen]');
      if (v) return verwerfenAnstossen(v.getAttribute('data-zs-verwerfen'));
      var w = t.closest('[data-zs-wegzurueck]');
      if (w) return verwerfenZurueck(w.getAttribute('data-zs-wegzurueck'));
      if (t.closest('[data-zs-liste]')) return zurueck();
    });
    st.dlg = d;
    st.inhalt = d.querySelector('[data-zs-inhalt]');
  }
  // Jede Ebene (Sheet, Person) ist ein Verlaufseintrag: Die Zurück-Geste geht erst zur Liste, dann zu.
  function eintragen() { history.pushState({ zs: ++st.tiefe }, ''); }
  addEventListener('popstate', function () {
    if (st.ignorieren) { st.ignorieren--; return; }
    if (!st.dlg || !st.dlg.open || !st.tiefe) return;
    st.tiefe--;
    if (st.tiefe > 0) listeZeigen(); else schliessen();
  });
  function zurueck() { if (st.tiefe > 1) history.back(); else listeZeigen(); }
  function zu() {
    if (st.tiefe) { st.ignorieren++; history.go(-st.tiefe); st.tiefe = 0; }
    schliessen();
  }
  function schliessen() {
    clearInterval(st.uhr); clearTimeout(st.zuTimer);
    st.vorgang++;
    if (!st.dlg || !st.dlg.open) return;
    st.dlg.classList.remove('da');
    setTimeout(function () { if (st.dlg.open && !st.dlg.classList.contains('da')) st.dlg.close(); }, 320);
  }

  async function oeffnen() {
    if (!st.dlg) bauen();
    if (st.dlg.open) return;
    if (!geraet() && !q.wartend().length && !q.abgelehnt().length) return;
    st.meldung = '';
    st.dlg.showModal();
    requestAnimationFrame(function () { st.dlg.classList.add('da'); });
    eintragen();
    listeZeigen();
    var r = await q.abarbeiten();
    bei(r);
    await standLaden();
    if (st.dlg.open && st.tiefe === 1) listeZeigen();
  }
  // Nach einem Lauf außerhalb eines Stempel-Vorgangs: Anmeldung weg, Uhr, neue Ablehnungen
  function bei(r) {
    if (!r) return;
    // Neuer Stand aus den gesendeten Stempeln, sonst zeigt die Liste bis zum nächsten Laden den alten
    r.ergebnisse.forEach(function (y) {
      var p = y.status === 200 && findePerson(y.eintrag.person_id);
      if (p) standMerken(p, y);
    });
    if (r.gestoppt === 'anmeldung') entkoppelt();
    if (r.gestoppt === 'uhr') st.meldung = K.fehlerText('zukunft');
    var neu = r.ergebnisse.filter(function (y) { return y.abgelehnt; });
    if (neu.length) st.meldung = neu.length === 1 ? 'Ein Stempel wurde abgelehnt. Du findest ihn unten unter „Nicht übertragen“.' : neu.length + ' Stempel wurden abgelehnt. Du findest sie unten unter „Nicht übertragen“.';
    if (!r.gestoppt) st.offline = false;
    knoepfeZeigen();
  }
  async function standLaden() {
    var g = geraet();
    if (!g) return;
    var r = await post(URL_ZEIT, { stempeluhr: g.token, aktion: 'stand' });
    if (r.status === 401) { entkoppelt(); st.meldung = TEXT_ENTKOPPELT; return; }
    st.offline = r.status !== 200;
    if (r.status === 200 && Array.isArray(r.daten.personen)) { st.daten = { heute: r.daten.heute, personen: r.daten.personen }; schreib(STAND_KEY, st.daten); }
  }
  function wartendZeigen() {
    var n = q.wartend().length;
    var el = st.dlg && st.dlg.querySelector('[data-zs-wartend]');
    if (!el) return;
    if (st.speicherFehler && n) el.textContent = K.fehlerText('speicher');
    else if (n) el.textContent = K.wartendText(n);
    else el.textContent = st.offline ? 'Ohne Verbindung. Angezeigt wird der letzte Stand.' : '';
    if (!n) st.speicherFehler = false;
  }
  var heute = function () { return (st.daten && st.daten.heute) || K.tagVon(new Date().toISOString()); };
  function standVon(p) { return K.vorlaeufig(p.stand, q.wartend(p.id), Date.now()); }
  var findePerson = function (id) { return ((st.daten && st.daten.personen) || []).find(function (x) { return x.id === id; }); };
  function wannText(iso) {
    var t = K.tagVon(iso);
    return t === heute() ? K.uhrzeit(iso) : t.slice(8, 10) + '.' + t.slice(5, 7) + '. ' + K.uhrzeit(iso);
  }

  function abgelehntZeile(e) {
    var p = findePerson(e.person_id);
    var was = e.typ === 'zuruecknehmen' ? 'Rückgängig' : (ART[e.art] || 'Stempel');
    var grund = K.fehlerText(e.fehler, e.fehler === 'nicht_zuruecknehmbar' ? 'abgelehnt' : undefined);
    var s = esc(e.schluessel);
    return '<div class="zs-abgel"><b>' + esc(p ? p.name : 'Unbekannte Person') + ', ' + esc(wannText(e.zeit)) + '</b>'
      + '<p>' + esc(was) + '. ' + esc(grund) + '</p>'
      + '<div class="zs-aktionen">'
      + (geraet() ? '<button type="button" class="zs-pille" data-zs-nochmal="' + s + '">Nochmal senden</button>' : '')
      + '<button type="button" class="zs-pille" data-zs-verwerfen="' + s + '">Verwerfen</button></div></div>';
  }
  function abgelehntBlock() {
    var liste = q.abgelehnt();
    if (!liste.length) return '';
    return '<h3 class="zs-abschnitt">Nicht übertragen</h3><div class="zs-liste">' + liste.map(function (e) {
      if (st.weg[e.schluessel]) return '<div class="zs-weg" role="status"><span>Verworfen.</span><button type="button" class="zs-pille" data-zs-wegzurueck="' + esc(e.schluessel) + '">Rückgängig</button></div>';
      return abgelehntZeile(e);
    }).join('') + '</div>';
  }

  function listeZeigen() {
    clearInterval(st.uhr); clearTimeout(st.zuTimer);
    st.vorgang++;
    st.ansicht = 'liste';
    $('zsTitel').textContent = 'Stempeln';
    var g = geraet();
    var personen = (g && st.daten && st.daten.personen) || [];
    var zeile = function (p) {
      var s = standVon(p);
      return '<button type="button" class="zs-person ' + (s.zustand === 'im_dienst' ? 'ist-dienst' : s.zustand === 'pause' ? 'ist-pause' : '') + '" data-zs-person="' + esc(p.id) + '">'
        + '<i class="zs-punkt" data-farbe="' + esc(p.farbe || '') + '"></i><span><b>' + esc(p.name) + '</b><small>' + esc(K.standText(s, heute())) + '</small></span>'
        + (p.schicht ? '<span class="zs-plan">' + esc(p.schicht.von) + ' bis ' + esc(p.schicht.bis) + '</span>' : '') + '</button>';
    };
    var mit = personen.filter(function (p) { return p.schicht; }), ohne = personen.filter(function (p) { return !p.schicht; });
    var namen;
    if (!g) namen = '<p class="zs-hinweis">' + esc(TEXT_ENTKOPPELT) + '</p>';
    else if (!personen.length) namen = '<p class="zs-hinweis">' + (st.offline ? 'Ohne Verbindung und noch ohne gespeicherte Namen.' : 'Namen werden geladen.') + '</p>';
    else namen = (mit.length ? '<h3 class="zs-abschnitt">Heute im Plan</h3><div class="zs-liste">' + mit.map(zeile).join('') + '</div>' : '')
      + (ohne.length ? '<h3 class="zs-abschnitt">' + (mit.length ? 'Weitere' : 'Team') + '</h3><div class="zs-liste">' + ohne.map(zeile).join('') + '</div>' : '');
    st.inhalt.innerHTML = (st.meldung && (g || st.meldung !== TEXT_ENTKOPPELT) ? '<p class="zs-hinweis" role="status">' + esc(st.meldung) + '</p>' : '') + namen + abgelehntBlock();
    // Farbpunkt erst nach dem Einsetzen und nur in der Form #RRGGBB setzen
    st.inhalt.querySelectorAll('[data-farbe]').forEach(function (i) { if (/^#[0-9a-fA-F]{6}$/.test(i.getAttribute('data-farbe'))) i.style.background = i.getAttribute('data-farbe'); });
    wartendZeigen();
  }

  function personZeigen(id, neu) {
    var p = findePerson(id);
    if (!p || !geraet()) return;
    if (neu) eintragen();
    clearInterval(st.uhr); clearTimeout(st.zuTimer);
    st.vorgang++;
    st.meldung = '';
    st.ansicht = 'person';
    var s = standVon(p);
    $('zsTitel').textContent = p.name;
    st.inhalt.innerHTML = '<p class="zs-stand">' + esc(K.standText(s, heute())) + '</p>'
      + '<p class="zs-plan-text">' + (p.schicht ? 'Heute im Plan: ' + esc(p.schicht.von) + ' bis ' + esc(p.schicht.bis) : 'Heute nicht im Plan') + '</p>'
      + (s.vergessen ? '<p class="zs-hinweis">' + esc(K.vergessenText(s, heute())) + '</p>' : '')
      + '<div class="zs-knoepfe">' + K.knoepfe(s.zustand).map(function (k, i) {
        return '<button type="button" class="zs-knopf' + (i ? ' zweit' : '') + '" data-zs-art="' + esc(k.art) + '" data-zs-person-id="' + esc(p.id) + '">' + esc(k.text) + '</button>';
      }).join('') + '</div>'
      + '<div class="zs-fuss"><button type="button" class="zs-pille" data-zs-liste>Andere Person</button></div>';
    wartendZeigen();
  }

  // Fehler: Das Sheet bleibt offen, bis jemand es schließt
  function fehlerZeigen(text) {
    if (!st.inhalt) return;
    clearInterval(st.uhr); clearTimeout(st.zuTimer);
    st.ansicht = 'fehler';
    st.inhalt.innerHTML = '<p class="zs-fehler" role="alert">' + esc(text) + '</p><div class="zs-fuss"><button type="button" class="zs-pille" data-zs-liste>Zur Liste</button></div>';
    wartendZeigen();
  }

  // Nach jedem Ende eines Vorgangs: 10 Sekunden stehen lassen, dann schließt das Sheet von selbst
  function spaeterZu() { clearTimeout(st.zuTimer); st.zuTimer = setTimeout(zu, RUECKGAENGIG_SEK * 1000); }
  function infoZeigen(text) {
    var info = st.inhalt && st.inhalt.querySelector('[data-zs-info]');
    if (!info) return;
    info.textContent = info.hidden || !info.textContent ? text : info.textContent + ' ' + text;
    info.hidden = false;
  }
  // Text zu einer Antwort, die kein 200 war
  function ablehnText(x) {
    var code = fehlercode(x.daten);
    var t = K.fehlerText(code, x.daten.hint);
    return x.abgelehnt ? t + ' Er wartet in der Liste unter „Nicht übertragen“.' : t;
  }
  function standMerken(p, x) {
    if (x && x.daten && x.daten.stand) { p.stand = x.daten.stand; schreib(STAND_KEY, st.daten); }
  }

  async function stempeln(id, art) {
    var p = findePerson(id);
    if (!p || !geraet()) return;
    var mein = ++st.vorgang;
    var e = q.stempeln(p.id, art);
    if (e.gespeichert === false) st.speicherFehler = true;
    knoepfeZeigen();
    st.ansicht = 'ende';
    var text = K.bestaetigung(p.name, art, e.zeit);
    st.inhalt.innerHTML = '<p class="zs-fertig" role="status" data-zs-text>' + esc(text) + '</p>'
      + '<button type="button" class="zs-rueckgaengig" data-zs-rueck>Rückgängig <span class="zs-sek" aria-hidden="true">' + RUECKGAENGIG_SEK + '</span></button>'
      + '<p class="zs-hinweis" data-zs-info hidden></p>';
    if (st.speicherFehler) infoZeigen(K.fehlerText('speicher'));
    var rest = RUECKGAENGIG_SEK, knopf = st.inhalt.querySelector('[data-zs-rueck]');
    knopf.onclick = function () { rueckgaengig(p, e); };
    clearInterval(st.uhr);
    st.uhr = setInterval(function () {
      rest--;
      if (rest <= 0) { clearInterval(st.uhr); knopf.remove(); return; }
      knopf.querySelector('.zs-sek').textContent = rest;
    }, 1000);
    spaeterZu();
    wartendZeigen();
    var r = await q.abarbeiten();
    var x = r.ergebnisse.find(function (y) { return y.eintrag.schluessel === e.schluessel; });
    if (x && x.status === 200) standMerken(p, x);
    if (r.gestoppt === 'anmeldung') entkoppelt();
    if (!r.gestoppt) st.offline = false;
    knoepfeZeigen();
    // Der Nutzer ist schon woanders (Rückgängig, Liste, zu): nur noch die Daten pflegen
    if (mein !== st.vorgang || !st.dlg.open) { wartendZeigen(); return; }
    if (r.gestoppt === 'anmeldung') return fehlerZeigen(TEXT_ENTKOPPELT + ' Der Stempel bleibt auf dem iPad, bis es neu gekoppelt ist.');
    if (r.gestoppt === 'uhr') infoZeigen(K.fehlerText('zukunft'));
    var fremd = r.ergebnisse.filter(function (y) { return y !== x && y.abgelehnt; });
    if (fremd.length) infoZeigen('Ein früherer Stempel wurde abgelehnt. Du findest ihn in der Liste unter „Nicht übertragen“.');
    if (!x) return wartendZeigen();   // ohne Netz: der Fuß zeigt „Gespeichert, wird übertragen“
    if (x.status !== 200) {
      standMerken(p, x);
      return fehlerZeigen(ablehnText(x));
    }
    if (x.daten.konflikt) { infoZeigen('Gespeichert, passt aber nicht zum Stand. Kubi sieht es im Office.'); return wartendZeigen(); }
    var textEl = st.inhalt.querySelector('[data-zs-text]');
    if (textEl) textEl.textContent = K.bestaetigung(p.name, art, e.zeit, x.daten);
    wartendZeigen();
  }

  async function rueckgaengig(p, e) {
    clearInterval(st.uhr); clearTimeout(st.zuTimer);
    var mein = ++st.vorgang;
    var weg = q.rueckgaengig(e.schluessel, p.id);
    if (weg.weg === false) {
      // Der Stempel war schon abgelehnt und ließ sich nicht entfernen, weil das Gerät nicht speichern kann
      st.inhalt.innerHTML = '<p class="zs-fertig" role="status">Rückgängig hat nicht geklappt.</p><p class="zs-hinweis">' + esc(K.fehlerText('speicher')) + '</p>';
      spaeterZu();
      return wartendZeigen();
    }
    knoepfeZeigen();
    if (weg.weg) { st.inhalt.innerHTML = '<p class="zs-fertig" role="status">Rückgängig gemacht.</p>'; spaeterZu(); return wartendZeigen(); }
    if (weg.gespeichert === false) st.speicherFehler = true;
    st.inhalt.innerHTML = '<p class="zs-fertig" role="status" data-zs-text>Wird rückgängig gemacht.</p><p class="zs-hinweis" data-zs-info hidden></p>';
    if (st.speicherFehler) infoZeigen(K.fehlerText('speicher'));
    var r = await q.abarbeiten();
    var x = r.ergebnisse.find(function (y) { return y.eintrag.schluessel === weg.schluessel; });
    if (x && x.status === 200) standMerken(p, x);
    if (r.gestoppt === 'anmeldung') entkoppelt();
    if (!r.gestoppt) st.offline = false;
    knoepfeZeigen();
    if (mein !== st.vorgang || !st.dlg.open) { wartendZeigen(); return; }
    if (r.gestoppt === 'anmeldung') return fehlerZeigen(TEXT_ENTKOPPELT + ' Der Stempel bleibt auf dem iPad, bis es neu gekoppelt ist.');
    if (x && x.status !== 200) { standMerken(p, x); return fehlerZeigen(ablehnText(x)); }
    if (r.gestoppt === 'uhr') infoZeigen(K.fehlerText('zukunft'));
    var t = st.inhalt.querySelector('[data-zs-text]');
    if (t) t.textContent = x ? 'Rückgängig gemacht.' : 'Rückgängig gespeichert, wird übertragen.';
    spaeterZu();
    wartendZeigen();
  }

  /* ---------------- Abgelehnte Stempel ---------------- */
  async function nochmalSenden(schluessel, knopf) {
    if (!geraet()) return;
    if (knopf) { knopf.disabled = true; knopf.setAttribute('aria-busy', 'true'); }
    var r = await q.erneut(schluessel);
    if (r) {
      var x = r.ergebnisse.find(function (y) { return y.eintrag.schluessel === schluessel; });
      if (r.gestoppt === 'anmeldung') entkoppelt();
      st.meldung = r.gestoppt === 'anmeldung' ? TEXT_ENTKOPPELT
        : x && x.status === 200 ? 'Gesendet.'
        : x ? ablehnText(x)
        : r.gestoppt === 'uhr' ? K.fehlerText('zukunft')
        : 'Keine Verbindung. Der Stempel wartet auf diesem iPad und geht von selbst raus.';
      if (x && x.status === 200 && x.daten.stand) { var p = findePerson(x.eintrag.person_id); if (p) standMerken(p, x); }
    }
    knoepfeZeigen();
    if (st.dlg && st.dlg.open && st.ansicht === 'liste') listeZeigen();
  }
  // Verwerfen ohne Bestätigungsdialog: erst ausblenden, wenige Sekunden „Rückgängig“, dann wirklich weg
  function verwerfenAnstossen(schluessel) {
    if (st.weg[schluessel]) return;
    st.weg[schluessel] = setTimeout(function () {
      delete st.weg[schluessel];
      q.verwerfen(schluessel);
      knoepfeZeigen();
      if (st.dlg && st.dlg.open && st.ansicht === 'liste') listeZeigen();
    }, VERWERFEN_MS);
    if (st.ansicht === 'liste') listeZeigen();
  }
  function verwerfenZurueck(schluessel) {
    clearTimeout(st.weg[schluessel]);
    delete st.weg[schluessel];
    if (st.ansicht === 'liste') listeZeigen();
  }

  /* ---------------- Start ---------------- */
  // Nachsenden: wieder online, alle 60 Sekunden, wenn die Seite wieder sichtbar wird. Ohne Token nie.
  function nachsenden() {
    if (!geraet() || !q.wartend().length) return;
    q.abarbeiten().then(function (r) {
      bei(r);
      if (st.dlg && st.dlg.open && st.ansicht === 'liste') listeZeigen(); else wartendZeigen();
    });
  }
  function start() {
    document.querySelectorAll('[data-stempeln]').forEach(function (b) { b.addEventListener('click', oeffnen); });
    var f = $('stempeluhrForm');
    if (f) f.addEventListener('submit', koppeln);
    knoepfeZeigen();
    addEventListener('online', nachsenden);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) nachsenden(); });
    setInterval(nachsenden, 60000);
    nachsenden();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
