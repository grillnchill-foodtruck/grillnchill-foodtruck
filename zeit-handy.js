/* ============================================================================
   zeit-handy.js
   Tab „Zeit“ fürs Team (zeit.html, Route /zeit): eigener Stand, Knöpfe, geplante Schicht heute und die Woche mit
   Arbeitszeit und Gutschrift je Tag. Anmeldung wie im Admin-Tool (admin-anmeldung.js), gemerkt wird nur der
   Sitzungs-Token (sessionStorage gnc_admin_pw, „angemeldet bleiben“ in localStorage gnc_admin_pw_p).
   Server: netlify/functions/zeit.js. Warteschlange und Texte: zeit-kern.js (via 'handy').
   Abgelehnte Stempel (Server sagt nein, Stempel bleibt auf dem Handy) stehen unter „Nicht übertragen“ mit
   „Nochmal senden“ und „Verwerfen“. Verwerfen geht nur mit Rückgängig, ohne Bestätigungsdialog.
   Muster wie zeit-stempeln.js: Stand-Zähler gegen Rennen zwischen Laden und Stempel-Antwort, Tippsperre nach
   Ansichtswechsel, endgültige Ablehnungen als Hinweis, Speicherstörung in Bernstein.
   ========================================================================== */
(function () {
  'use strict';
  var K = window.GNCZeit;
  if (!K) return;
  var URL_ZEIT = '/.netlify/functions/zeit';
  var URL_TEAM = '/.netlify/functions/team';
  var PW_KEY = 'gnc_admin_pw';
  var STAND_KEY = 'gnc_zeit_stand_handy';
  var RUECKGAENGIG_SEK = 10;
  var VERWERFEN_MS = 6000;
  var SPERRE_MS = 400;
  var ART = { beginn: 'Schicht beginnen', pause_beginn: 'Pause beginnen', pause_ende: 'Pause beenden', ende: 'Schicht beenden' };
  var TEXT_FREMD = 'Auf diesem Handy warten noch Stempel einer anderen Person. Sie gehen raus, sobald sie sich hier anmeldet.';
  var TEXT_NEU_ANMELDEN = 'Bitte melde dich neu an. Deine Stempel bleiben gespeichert.';
  var $ = function (id) { return document.getElementById(id); };
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  // Gesperrter Speicher wirft schon beim Zugriff auf window.localStorage
  function speicherHolen() { try { return window.localStorage; } catch (e) { return null; } }
  var SPEICHER = speicherHolen() || { getItem: function () { return null; }, setItem: function () { throw new Error('kein Speicher'); } };
  function lies(k) { try { return JSON.parse(window.localStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function schreib(k, v) { try { if (v == null) window.localStorage.removeItem(k); else window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  // Bindung des Stand-Caches an die Sitzung: FNV-1a über den Token, nur der Hash wird gespeichert, nie der Token.
  // Meldet sich jemand anders an (auch im Admin-Tool, dessen Abmelden diesen Cache nicht kennt), passt der Cache nicht mehr.
  function abdruck(t) {
    var h = 0x811c9dc5;
    for (var i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return 'f' + h.toString(16);
  }
  function standSpeichern() { if (st.cred && st.person) schreib(STAND_KEY, { person: st.person, heute: st.heute, bindung: abdruck(st.cred) }); }
  function standLesen() {
    var g = lies(STAND_KEY);
    if (g && g.person && st.cred && g.bindung === abdruck(st.cred)) return g;
    if (g) schreib(STAND_KEY, null);   // gehört einer anderen Sitzung
    return null;
  }
  var fehlercode = function (daten) { return daten && (daten.fehler || daten.error); };

  if (window.GNCAppLeiste) GNCAppLeiste.start({ modus: 'team', selected: 'zeit', zurueck: ['appZurueck', 'appZurueckLogin'] });

  var st = {
    cred: '', person: null, heute: '', offline: '', montag: '', uhr: null,
    vorgang: 0, ladeNr: 0, seq: 0, merk: 0, sperre: 0, phase: '',
    info: '', speicherFehler: false, weg: {}, wocheNr: 0, sitzung: 0,
  };

  function toast(text, art) {
    var t = $('toast');
    t.textContent = text;
    t.className = 'toast da' + (art ? ' ' + art : '');
    clearTimeout(t._t);
    t._t = setTimeout(function () { t.className = 'toast'; }, 3500);
  }
  function gemerkteAnmeldung() {
    try {
      var s = sessionStorage.getItem(PW_KEY);
      if (s && GNCAnmeldung.istToken(s)) return s;
      var p = JSON.parse(window.localStorage.getItem(PW_KEY + '_p') || 'null');
      if (p && p.t && p.exp > Date.now()) return p.t;
    } catch (e) {}
    return '';
  }
  // Eine Antwort ohne JSON (HTML-Fehlerseite) gibt { status, daten: {} }, ein Netzfehler { status: 0, daten: {} }
  async function post(body) {
    try {
      var r = await fetch(URL_ZEIT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ password: st.cred }, body)) });
      var d = await r.json().catch(function () { return {}; });
      return { status: r.status, daten: d && typeof d === 'object' ? d : {} };
    } catch (e) { return { status: 0, daten: {} }; }
  }
  var q = K.warteschlange({
    speicher: SPEICHER, via: 'handy',
    senden: function (e) {
      // Ohne Anmeldung nie senden: Die Stempel bleiben liegen, bis jemand angemeldet ist
      if (!st.cred) return Promise.resolve({ status: 401, daten: {} });
      // Nur Stempel der eigenen Person: alles andere bleibt liegen (Lauf stoppt wie ohne Netz)
      if (!eigeneId() || e.person_id !== eigeneId()) return Promise.resolve({ status: 0, daten: {} });
      return post(e.typ === 'stempeln'
        ? { aktion: 'stempeln', schluessel: e.schluessel, person_id: e.person_id, art: e.art, zeit: e.zeit }
        : { aktion: 'zuruecknehmen', schluessel: e.schluessel, person_id: e.person_id, bezug_schluessel: e.bezug_schluessel, zeit: e.zeit });
    },
  });

  // Der Tag kommt von der Uhr des Geräts. Der Plan gilt nur, wenn er für diesen Tag geladen wurde (offline über Mitternacht nicht).
  var heute = function () { return K.tagVon(new Date().toISOString()); };
  var planGilt = function () { return !!st.heute && st.heute === heute(); };
  function wannText(iso) {
    var t = K.tagVon(iso);
    return t === heute() ? K.uhrzeit(iso) : t.slice(8, 10) + '.' + t.slice(5, 7) + '. ' + K.uhrzeit(iso);
  }

  /* ---------------- Ansichten ---------------- */
  function zeigeLogin(text) {
    $('zeitView').hidden = true;
    $('loginView').hidden = false;
    var n = q.wartend().length;
    $('loginWartend').textContent = n ? (n === 1 ? 'Auf diesem Handy wartet ein Stempel. Er geht raus, sobald sich die Person hier anmeldet, zu der er gehört.' : 'Auf diesem Handy warten ' + n + ' Stempel. Sie gehen raus, sobald sich die Personen hier anmelden, zu denen sie gehören.') : '';
    $('loginWartend').hidden = !n;
    $('pwFehler').textContent = text || '';
    $('pwFehler').hidden = !text;
  }
  function zeigeZeit() { $('loginView').hidden = true; $('zeitView').hidden = false; }

  // Meldungen: Hinweise in Bernstein (zhInfo). Gleicher Text nur einmal.
  function infoDazu(text) {
    if (!text || st.info.indexOf(text) !== -1) return;
    st.info = st.info ? st.info + ' ' + text : text;
  }
  // Eigene Person bekannt: Stempel anderer Personen (wartend oder abgelehnt) auf diesem Handy bekommen einen neutralen Hinweis
  var eigeneId = function () { return st.person ? st.person.id : null; };
  function fremdeDa() {
    var id = eigeneId();
    if (!id) return false;
    return q.wartend().some(function (e) { return e.person_id !== id; });   // Abgelehnte gehen nicht von selbst raus: kein Hinweis
  }
  function meldungenZeigen() {
    var t = st.info + (fremdeDa() ? (st.info ? ' ' : '') + TEXT_FREMD : '');
    $('zhInfo').textContent = t;
    $('zhInfo').hidden = !t;
  }
  function wartendZeigen() {
    var n = q.wartend(eigeneId() || '-').length;
    var el = $('zhWartend');
    if (st.speicherFehler && n) el.textContent = K.fehlerText('speicher');
    else if (n) el.textContent = K.wartendText(n);
    else el.textContent = st.offline === 'netz' ? 'Ohne Verbindung. Angezeigt wird der letzte Stand.' : st.offline ? 'Gerade nicht erreichbar. Angezeigt wird der letzte Stand.' : '';
    el.hidden = !el.textContent;
    if (!n) st.speicherFehler = false;
  }
  // Stand-Zeile allein: gleich nach dem Stempeln, während die Knöpfe der Bestätigung Platz machen
  function standZeile() {
    var p = st.person;
    if (!p) return null;
    var s = K.vorlaeufig(p.stand, q.wartend(p.id), Date.now());
    $('zhName').textContent = p.name;
    $('zhStand').textContent = K.standText(s, heute());
    return s;
  }
  function zeichneStand() {
    var p = st.person;
    var s = standZeile();
    zeichneAbgelehnt();
    meldungenZeigen();
    wartendZeigen();
    if (!s) return;
    $('zhPlan').textContent = planGilt() ? (p.schicht ? 'Heute im Plan: ' + p.schicht.von + ' bis ' + p.schicht.bis : 'Heute nicht im Plan') : '';
    var h = K.vergessenText(s, heute());
    $('zhHinweis').textContent = h;
    $('zhHinweis').hidden = !h;
    // Während der Bestätigung bleiben die Knöpfe weg, auch wenn im Hintergrund etwas nachgesendet wird
    $('zhKnoepfe').innerHTML = st.phase === 'fertig' ? '' : K.knoepfe(s.zustand).map(function (k, i) {
      return '<button type="button" class="zs-knopf' + (i ? ' zweit' : '') + '" data-art="' + esc(k.art) + '">' + esc(k.text) + '</button>';
    }).join('');
  }

  /* ---------------- Ergebnisse eines Laufs ---------------- */
  function endText(y) {
    return (y.eintrag.typ === 'zuruecknehmen' ? 'Rückgängig' : (ART[y.eintrag.art] || 'Stempel')) + ': ' + K.fehlerText(fehlercode(y.daten), y.daten.hint);
  }
  // Text zu einer Antwort, die kein 200 war
  function ablehnText(y) {
    return y.abgelehnt ? endText(y) + ' Er steht unter „Nicht übertragen“.' : endText(y);
  }
  // Neuer Stand aus 200 und 409 zustand. Immer über st.person: Ein Laden zwischendurch ersetzt das Objekt.
  function standMerken(personId, y) {
    var p = st.person;
    if (!p || p.id !== personId || !y || !y.daten || !y.daten.stand) return;
    p.stand = y.daten.stand;
    st.merk = ++st.seq;
    standSpeichern();
  }
  // Alle Ergebnisse eines Laufs einarbeiten (Stände, Ablehnungen, Uhr, Anmeldung). eigen: Schlüssel, um den sich der Aufrufer selbst kümmert.
  // Liefert true, wenn die Sitzung abgelaufen ist und die Seite zur Anmeldung gewechselt hat.
  function verarbeite(r, eigen) {
    if (!r) return false;
    var abgel = 0;
    r.ergebnisse.forEach(function (y) {
      standMerken(y.eintrag.person_id, y);   // 200 und 409 zustand bringen beide den aktuellen Stand mit
      if (y.status === 200 || y.eintrag.schluessel === eigen) return;
      if (y.abgelehnt) { abgel++; return; }
      infoDazu(endText(y));   // endgültig abgelehnt: nicht still verschwinden lassen
    });
    if (abgel) infoDazu(abgel === 1 ? 'Ein Stempel wurde abgelehnt. Du findest ihn unter „Nicht übertragen“.' : abgel + ' Stempel wurden abgelehnt. Du findest sie unter „Nicht übertragen“.');
    if (r.gestoppt === 'anmeldung') { abmelden(TEXT_NEU_ANMELDEN); return true; }
    if (r.gestoppt === 'uhr') infoDazu(K.fehlerText('zukunft'));
    if (r.gestoppt === 'netz') st.offline = st.offline || 'netz'; else if (!r.gestoppt) st.offline = '';
    return false;
  }

  /* ---------------- Laden ---------------- */
  async function laden() {
    var nr = ++st.ladeNr, sz = st.sitzung;
    var gueltig = function () { return nr === st.ladeNr && sz === st.sitzung && !!st.cred; };
    var von = st.seq;   // Stände aus Stempel-Antworten während des Ladens sind neuer als diese Antwort
    var r = await post({ aktion: 'stand' });   // erst die eigene Person kennen, dann senden (geteiltes Handy)
    if (!gueltig()) return;
    if (r.status === 401) return abmelden(q.wartend().length ? TEXT_NEU_ANMELDEN : 'Bitte melde dich neu an.');
    if (r.status === 403) {
      st.person = null; st.heute = ''; st.unfrei = true; schreib(STAND_KEY, null);
      fertigZu();
      zeigeZeit();
      $('zhName').textContent = 'Noch nicht freigeschaltet';
      $('zhStand').textContent = K.fehlerText(fehlercode(r.daten), r.daten.hint);
      $('zhPlan').textContent = '';
      $('zhHinweis').hidden = true;
      $('zhKnoepfe').innerHTML = '';
      $('zhWocheBereich').hidden = true;
      meldungenZeigen(); wartendZeigen(); zeichneAbgelehnt();
      return;
    }
    st.unfrei = false;
    st.offline = r.status === 200 ? '' : r.status === 0 ? 'netz' : 'dienst';
    if (r.status === 200 && r.daten.personen && r.daten.personen[0]) {
      var neu = r.daten.personen[0];
      if (st.person && st.person.id === neu.id && st.merk > von) neu.stand = st.person.stand;
      st.person = neu;
      st.heute = r.daten.heute;
      standSpeichern();
    } else if (!st.person) {
      var g = standLesen();
      if (g) { st.person = g.person; st.heute = g.heute; }
    }
    zeigeZeit();
    if (!st.person) {
      $('zhName').textContent = 'Zeit';
      $('zhStand').textContent = st.offline === 'netz' ? 'Ohne Verbindung. Versuch es gleich noch einmal.' : 'Gerade nicht erreichbar. Versuch es gleich noch einmal.';
      $('zhPlan').textContent = ''; $('zhHinweis').hidden = true; $('zhKnoepfe').innerHTML = '';
      $('zhWocheBereich').hidden = true;
      meldungenZeigen(); wartendZeigen(); zeichneAbgelehnt();
      return;
    }
    zeichneStand();
    $('zhWocheBereich').hidden = false;
    // Nur Stempel dieser Person gehen raus, Stempel anderer Personen auf diesem Handy bleiben liegen
    var rq = await q.abarbeiten({ person: st.person.id });
    if (!gueltig()) return;
    if (verarbeite(rq)) return;
    zeichneStand();
    if (!st.montag) st.montag = montagVon(st.heute || heute());
    wocheLaden();
  }

  /* ---------------- Stempeln und Rückgängig ---------------- */
  function fertigZu() {
    clearInterval(st.uhr);
    st.phase = '';
    $('zhFertig').hidden = true;
  }
  async function stempeln(art) {
    var p = st.person;
    if (!p || Date.now() < st.sperre) return;
    var mein = ++st.vorgang;
    st.sperre = Date.now() + SPERRE_MS;   // Ein Doppeltipp trifft nicht „Rückgängig“, das an derselben Stelle erscheint
    st.info = '';
    var sz = st.sitzung;
    var e = q.stempeln(p.id, art);
    if (e.gespeichert === false) st.speicherFehler = true;
    st.phase = 'fertig';
    $('zhKnoepfe').innerHTML = '';
    standZeile();
    if (st.speicherFehler) infoDazu(K.fehlerText('speicher'));
    meldungenZeigen();
    wartendZeigen();
    $('zhFertigText').textContent = K.bestaetigung(p.name, art, e.zeit);
    $('zhFertig').hidden = false;
    var rest = RUECKGAENGIG_SEK, knopf = $('zhRueckgaengig');
    knopf.hidden = false;
    knopf.querySelector('.zs-sek').textContent = rest;
    knopf.onclick = function () { rueckgaengig(p, e); };
    clearInterval(st.uhr);
    st.uhr = setInterval(function () {
      rest--;
      if (rest > 0) { knopf.querySelector('.zs-sek').textContent = rest; return; }
      fertigZu(); knopf.hidden = true; zeichneStand();
    }, 1000);
    var r = await q.abarbeiten({ person: p.id });
    if (sz !== st.sitzung) return;
    if (verarbeite(r, e.schluessel)) return;
    var x = r.ergebnisse.find(function (y) { return y.eintrag.schluessel === e.schluessel; });
    var hier = mein === st.vorgang;   // false: die Person hat inzwischen Rückgängig getippt, der Rest macht rueckgaengig()
    if (!x) { zeichneStand(); return; }   // ohne Netz: „Gespeichert, wird übertragen“
    if (x.status !== 200) {
      // Endgültig abgelehnt oder in „Nicht übertragen“ gelandet: Bestätigung weg, Grund sichtbar
      if (hier) fertigZu();
      infoDazu(ablehnText(x));
      zeichneStand();
      return;
    }
    if (x.daten.konflikt) infoDazu('Gespeichert, passt aber nicht zum Stand. Kubi sieht es im Office.');
    if (hier && st.phase === 'fertig') $('zhFertigText').textContent = K.bestaetigung(p.name, art, e.zeit, x.daten);
    zeichneStand();   // lässt die Knöpfe weg, solange die Bestätigung steht
    if (art === 'ende') wocheLaden();
  }

  async function rueckgaengig(p, e) {
    if (Date.now() < st.sperre) return;
    var mein = ++st.vorgang, sz = st.sitzung;
    st.sperre = Date.now() + SPERRE_MS;   // Die Knöpfe erscheinen an derselben Stelle wieder
    clearInterval(st.uhr);
    $('zhRueckgaengig').hidden = true;
    var weg = q.rueckgaengig(e.schluessel, p.id);
    if (weg.weg === false) {
      // Der Stempel war schon abgelehnt und ließ sich nicht entfernen, weil das Gerät nicht speichern kann
      fertigZu();
      infoDazu('Rückgängig hat nicht geklappt. ' + K.fehlerText('speicher'));
      zeichneStand();
      return;
    }
    if (weg.weg) {
      fertigZu();
      toast('Rückgängig gemacht.');
      zeichneStand();
      wocheLaden();
      return;
    }
    // Der Stempel war schon unterwegs: Die Rücknahme wird hinten angestellt und gesendet
    if (weg.gespeichert === false) st.speicherFehler = true;
    $('zhFertigText').textContent = 'Wird rückgängig gemacht.';
    if (st.speicherFehler) infoDazu(K.fehlerText('speicher'));
    meldungenZeigen();
    var r = await q.abarbeiten({ person: p.id });
    if (sz !== st.sitzung) return;
    if (verarbeite(r, weg.schluessel)) return;
    var x = r.ergebnisse.find(function (y) { return y.eintrag.schluessel === weg.schluessel; });
    if (mein === st.vorgang) fertigZu();
    if (!x) toast('Rückgängig gespeichert, wird übertragen.');
    else if (x.status !== 200) infoDazu(ablehnText(x));
    else toast('Rückgängig gemacht.');
    zeichneStand();
    wocheLaden();
  }

  /* ---------------- Abgelehnte Stempel ---------------- */
  function zeichneAbgelehnt() {
    var liste = q.abgelehnt().filter(function (e) { return e.person_id === eigeneId(); });
    $('zhAbgelehntBereich').hidden = !liste.length;
    $('zhAbgelehnt').innerHTML = liste.map(function (e) {
      var s = esc(e.schluessel);
      if (st.weg[e.schluessel]) return '<div class="zs-weg" role="status"><span>Verworfen.</span><button type="button" class="zs-pille" data-wegzurueck="' + s + '">Rückgängig</button></div>';
      var was = e.typ === 'zuruecknehmen' ? 'Rückgängig' : (ART[e.art] || 'Stempel');
      return '<div class="zs-abgel"><b>' + esc(was) + ', ' + esc(wannText(e.zeit)) + '</b><p>' + esc(K.fehlerText(e.fehler)) + '</p>'
        + '<div class="zs-aktionen"><button type="button" class="zs-pille" data-nochmal="' + s + '">Nochmal senden</button>'
        + '<button type="button" class="zs-pille" data-verwerfen="' + s + '">Verwerfen</button></div></div>';
    }).join('');
  }
  async function nochmalSenden(schluessel, knopf) {
    if (!st.cred || !eigeneId()) return;
    if (knopf) { knopf.disabled = true; knopf.setAttribute('aria-busy', 'true'); }
    var sz = st.sitzung;
    var r = await q.erneut(schluessel, { person: eigeneId() });
    if (sz !== st.sitzung) return;
    if (r) {
      if (verarbeite(r, schluessel)) return;
      var x = r.ergebnisse.find(function (y) { return y.eintrag.schluessel === schluessel; });
      if (x && x.status === 200) toast('Gesendet.');
      else if (x) infoDazu(ablehnText(x));
      else if (r.gestoppt === 'uhr') infoDazu(K.fehlerText('zukunft'));
      else toast('Keine Verbindung. Der Stempel wartet und geht von selbst raus.');
      if (x && x.status === 200) wocheLaden();
    }
    zeichneStand();
  }
  // Verwerfen ohne Bestätigungsdialog: erst ausblenden, wenige Sekunden „Rückgängig“, dann wirklich weg
  function verwerfenAnstossen(schluessel) {
    if (st.weg[schluessel]) return;
    st.weg[schluessel] = setTimeout(function () {
      delete st.weg[schluessel];
      q.verwerfen(schluessel);
      zeichneAbgelehnt();
    }, VERWERFEN_MS);
    zeichneAbgelehnt();
  }
  function verwerfenZurueck(schluessel) {
    clearTimeout(st.weg[schluessel]);
    delete st.weg[schluessel];
    zeichneAbgelehnt();
  }

  /* ---------------- Woche ---------------- */
  var plusTage = function (tag, n) { return new Date(Date.parse(tag + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10); };
  var montagVon = function (tag) { return plusTage(tag, -((new Date(tag + 'T12:00:00Z').getUTCDay() + 6) % 7)); };
  var TAG = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'UTC' });
  var kurz = function (tag) { return TAG.format(new Date(tag + 'T12:00:00Z')); };

  async function wocheLaden() {
    var m = st.montag;
    if (!m || !st.cred) return;
    var nr = ++st.wocheNr, sz = st.sitzung;
    $('zhWoche').textContent = kurz(m) + ' bis ' + kurz(plusTage(m, 6));
    $('zhFolgewoche').disabled = plusTage(m, 7) > (st.heute || heute());
    var r = await post({ aktion: 'woche', montag: m });
    if (nr !== st.wocheNr || m !== st.montag || sz !== st.sitzung || !st.cred) return;
    if (r.status === 401) return abmelden(q.wartend().length ? TEXT_NEU_ANMELDEN : 'Bitte melde dich neu an.');
    if (r.status !== 200 || !Array.isArray(r.daten.tage)) { $('zhTage').innerHTML = '<p class="zh-leer">Die Woche ist gerade nicht abrufbar.</p>'; return; }
    var zeilen = [];
    r.daten.tage.forEach(function (t) {
      (t.schichten || []).forEach(function (s) {
        var ende = s.ende ? K.uhrzeit(s.ende) : s.vergessen ? 'Ende fehlt' : 'läuft';
        zeilen.push('<div class="zh-tag"><span><b>' + esc(kurz(t.tag)) + '</b><small>' + esc(K.uhrzeit(s.beginn) + ' bis ' + ende + (s.pause_min ? ', Pause ' + s.pause_min + ' Min' : '')) + '</small></span>'
          + '<span class="zh-wert">' + (s.arbeitszeit_min == null ? '' : esc(K.dauerText(s.arbeitszeit_min))) + (s.gutschrift_min ? '<small>+' + esc(s.gutschrift_min) + ' Min</small>' : '') + '</span></div>');
      });
    });
    var su = r.daten.summe || {};
    $('zhTage').innerHTML = zeilen.length
      ? zeilen.join('') + '<div class="zh-summe"><span>Woche</span><span>' + esc(K.dauerText(su.arbeitszeit_min || 0)) + ' + ' + esc(su.gutschrift_min || 0) + ' Min = ' + esc(K.dauerText(su.bezahlt_min || 0)) + '</span></div>'
      : '<p class="zh-leer">In dieser Woche hast du noch nicht gestempelt.</p>';
  }

  /* ---------------- Anmelden und Abmelden ---------------- */
  async function anmelden(ev) {
    ev.preventDefault();
    var pw = $('pw').value;
    if (!pw) { $('pwFehler').textContent = 'Bitte Passwort eingeben.'; $('pwFehler').hidden = false; return; }
    $('pwFehler').hidden = true;
    $('loginKnopf').disabled = true;
    var an = await GNCAnmeldung.anmelden(pw, { merken: $('pwBleiben').checked });
    $('loginKnopf').disabled = false;
    if (!an.ok) {
      if (an.grund === 'abbruch') return;
      $('pwFehler').textContent = an.grund === 'passwort' ? 'Passwort falsch.' : an.grund === 'gesperrt' ? 'Zu viele Fehlversuche. Versuch es später noch einmal.' : 'Keine Verbindung. Versuch es noch einmal.';
      $('pwFehler').hidden = false;
      return;
    }
    // Neue Anmeldung: Der Stand-Cache gehörte der Person davor
    st.sitzung++;
    st.person = null; st.heute = ''; st.montag = ''; st.info = '';
    schreib(STAND_KEY, null);
    st.cred = an.token;
    try {
      sessionStorage.setItem(PW_KEY, an.token);
      if ($('pwBleiben').checked) window.localStorage.setItem(PW_KEY + '_p', JSON.stringify({ t: an.token, exp: new Date(an.exp).getTime() }));
    } catch (e) {}
    $('pw').value = '';
    laden();
  }
  // Die Stempel in der Warteschlange bleiben: Sie sind Pflichtaufzeichnungen und gehen nach der nächsten Anmeldung raus.
  function abmelden(text) {
    if (st.cred) fetch(URL_TEAM, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: st.cred, action: 'abmelden' }) }).catch(function () {});
    try { sessionStorage.removeItem(PW_KEY); window.localStorage.removeItem(PW_KEY + '_p'); } catch (e) {}
    st.cred = ''; st.person = null; st.unfrei = false; st.heute = ''; st.montag = ''; st.info = ''; st.offline = '';
    st.sitzung++; st.ladeNr++; st.wocheNr++; st.vorgang++;
    Object.keys(st.weg).forEach(function (k) { clearTimeout(st.weg[k]); });
    st.weg = {};
    fertigZu();
    schreib(STAND_KEY, null);
    zeigeLogin(typeof text === 'string' ? text : '');
  }

  /* ---------------- Start ---------------- */
  $('loginForm').addEventListener('submit', anmelden);
  $('abmelden').addEventListener('click', function () { abmelden(); });
  $('zhKnoepfe').addEventListener('click', function (ev) { var b = ev.target.closest('[data-art]'); if (b) stempeln(b.getAttribute('data-art')); });
  $('zhAbgelehnt').addEventListener('click', function (ev) {
    var t = ev.target;
    var n = t.closest('[data-nochmal]'); if (n) return nochmalSenden(n.getAttribute('data-nochmal'), n);
    var v = t.closest('[data-verwerfen]'); if (v) return verwerfenAnstossen(v.getAttribute('data-verwerfen'));
    var w = t.closest('[data-wegzurueck]'); if (w) return verwerfenZurueck(w.getAttribute('data-wegzurueck'));
  });
  $('zhVorwoche').addEventListener('click', function () { st.montag = plusTage(st.montag, -7); wocheLaden(); });
  $('zhFolgewoche').addEventListener('click', function () { st.montag = plusTage(st.montag, 7); wocheLaden(); });
  // Nachsenden: wieder online, jede Minute, wenn die Seite wieder sichtbar wird. Ohne Anmeldung nie.
  function nachsenden() {
    var id = eigeneId(), sz = st.sitzung;
    if (st.cred && !id) { if (!st.unfrei) laden(); return; }   // Anmeldung da, Person unbekannt (stand scheiterte): erneut versuchen
    if (!st.cred || !q.wartend(id).length) return;
    q.abarbeiten({ person: id }).then(function (r) {
      if (sz !== st.sitzung || verarbeite(r)) return;
      zeichneStand();
      if (r.ergebnisse.some(function (y) { return y.status === 200; }) && !q.wartend(id).length) laden();
    });
  }
  addEventListener('online', nachsenden);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && st.cred) laden(); });
  setInterval(nachsenden, 60000);

  st.cred = gemerkteAnmeldung();
  // Ohne gültige Anmeldung gehört der Stand-Cache niemandem mehr
  if (st.cred) laden(); else { schreib(STAND_KEY, null); zeigeLogin(); }
})();
