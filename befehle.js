/**
 * befehle.js – Schnellsuche (Command-Menü) für Startseite und Unterseiten
 * ----------------------------------------------------------------------------
 * ⌘K (Mac) bzw. Strg+K oder „/“ öffnet ein Suchfeld: Burger und Beilagen der
 * Speisekarte, Abschnitte der Startseite, Unterseiten, Aktionen (Warenkorb,
 * Konto, Gruppenbestellung) und die Sprachen. Pfeiltasten wählen, Enter
 * öffnet, Esc schließt. Auf dem Desktop steht dazu ein Lupen-Knopf im Kopf
 * mit dem Tastenkürzel als Hinweis.
 * Stil: feinschliff.css (.befehle-*). Keine Inline-Handler (strenge CSP).
 * ----------------------------------------------------------------------------
 */
(function () {
  'use strict';

  var MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  var STARTSEITE = !!document.getElementById('menuGrid');
  var TEXTE = {
    de: { suchen: 'Burger, Seiten oder Aktionen suchen', leer: 'Nichts gefunden', karte: 'Speisekarte', bereiche: 'Startseite', seiten: 'Seiten', aktionen: 'Aktionen', sprache: 'Sprache', waehlen: 'Auswählen', oeffnen: 'Öffnen', schliessen: 'Schließen', knopf: 'Suchen', warenkorb: 'Warenkorb öffnen', konto: 'Mein Konto', gruppe: 'Gruppenbestellung starten', oben: 'Nach oben' },
    en: { suchen: 'Search burgers, pages or actions', leer: 'Nothing found', karte: 'Menu', bereiche: 'Home page', seiten: 'Pages', aktionen: 'Actions', sprache: 'Language', waehlen: 'Select', oeffnen: 'Open', schliessen: 'Close', knopf: 'Search', warenkorb: 'Open cart', konto: 'My account', gruppe: 'Start a group order', oben: 'Back to top' },
    tr: { suchen: 'Burger, sayfa veya işlem ara', leer: 'Sonuç yok', karte: 'Menü', bereiche: 'Ana sayfa', seiten: 'Sayfalar', aktionen: 'İşlemler', sprache: 'Dil', waehlen: 'Seç', oeffnen: 'Aç', schliessen: 'Kapat', knopf: 'Ara', warenkorb: 'Sepeti aç', konto: 'Hesabım', gruppe: 'Grup siparişi başlat', oben: 'Başa dön' },
    it: { suchen: 'Cerca burger, pagine o azioni', leer: 'Nessun risultato', karte: 'Menù', bereiche: 'Pagina iniziale', seiten: 'Pagine', aktionen: 'Azioni', sprache: 'Lingua', waehlen: 'Scegli', oeffnen: 'Apri', schliessen: 'Chiudi', knopf: 'Cerca', warenkorb: 'Apri il carrello', konto: 'Il mio account', gruppe: 'Avvia un ordine di gruppo', oben: 'Torna su' },
    es: { suchen: 'Busca burgers, páginas o acciones', leer: 'Sin resultados', karte: 'Carta', bereiche: 'Página de inicio', seiten: 'Páginas', aktionen: 'Acciones', sprache: 'Idioma', waehlen: 'Elegir', oeffnen: 'Abrir', schliessen: 'Cerrar', knopf: 'Buscar', warenkorb: 'Abrir el carrito', konto: 'Mi cuenta', gruppe: 'Empezar un pedido de grupo', oben: 'Volver arriba' },
    pt: { suchen: 'Procura burgers, páginas ou ações', leer: 'Sem resultados', karte: 'Menu', bereiche: 'Página inicial', seiten: 'Páginas', aktionen: 'Ações', sprache: 'Idioma', waehlen: 'Escolher', oeffnen: 'Abrir', schliessen: 'Fechar', knopf: 'Procurar', warenkorb: 'Abrir o carrinho', konto: 'A minha conta', gruppe: 'Começar uma encomenda de grupo', oben: 'Voltar ao topo' },
    fr: { suchen: 'Chercher un burger, une page ou une action', leer: 'Aucun résultat', karte: 'Carte', bereiche: "Page d'accueil", seiten: 'Pages', aktionen: 'Actions', sprache: 'Langue', waehlen: 'Choisir', oeffnen: 'Ouvrir', schliessen: 'Fermer', knopf: 'Chercher', warenkorb: 'Ouvrir le panier', konto: 'Mon compte', gruppe: 'Lancer une commande de groupe', oben: 'Revenir en haut' },
    nl: { suchen: 'Zoek burgers, pagina’s of acties', leer: 'Niets gevonden', karte: 'Menukaart', bereiche: 'Startpagina', seiten: 'Pagina’s', aktionen: 'Acties', sprache: 'Taal', waehlen: 'Kiezen', oeffnen: 'Openen', schliessen: 'Sluiten', knopf: 'Zoeken', warenkorb: 'Winkelwagen openen', konto: 'Mijn account', gruppe: 'Groepsbestelling starten', oben: 'Naar boven' },
  };
  function lang() { var l = document.documentElement.lang || 'de'; return TEXTE[l] ? l : 'de'; }
  function tx(k) { return TEXTE[lang()][k] || TEXTE.de[k]; }
  function tr(k, de) {
    if (typeof window.t === 'function') { try { var v = window.t(k); if (v && v !== k) return v; } catch (e) {} }
    return de;
  }
  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');
  }
  function kuerzel() { return MAC ? ['⌘', 'K'] : [tx('knopf') === 'Suchen' ? 'Strg' : 'Ctrl', 'K']; }

  /* ---- Einträge ---------------------------------------------------------- */
  function zuStartseite(anker) {
    return function () {
      if (STARTSEITE) {
        var z = document.getElementById(anker);
        if (z) { z.scrollIntoView({ behavior: 'smooth', block: 'start' }); try { history.replaceState(history.state, '', '#' + anker); } catch (e) {} }
      } else { location.href = '/#' + anker; }
    };
  }
  function zuSeite(pfad) { return function () { location.href = pfad; }; }
  function zeigeArtikel(id) {
    return function () {
      var alle = document.querySelector('#menuFilters [data-cat="all"]');
      if (alle && !alle.classList.contains('active')) alle.click();
      setTimeout(function () {
        var karte = document.querySelector('.menu-card[data-on-click*="karteTipp(\'' + id + '\'"]');
        if (!karte) { var g = document.getElementById('menu'); if (g) g.scrollIntoView({ behavior: 'smooth' }); return; }
        karte.scrollIntoView({ behavior: 'smooth', block: 'center' });
        karte.classList.remove('befehle-ziel'); void karte.offsetWidth; karte.classList.add('befehle-ziel');
        setTimeout(function () { karte.classList.remove('befehle-ziel'); }, 1800);
      }, 60);
    };
  }

  function eintraege() {
    var liste = [];
    var gr = { karte: tx('karte'), bereiche: tx('bereiche'), seiten: tx('seiten'), aktionen: tx('aktionen'), sprache: tx('sprache') };

    if (STARTSEITE) {
      if (typeof window.navWarenkorb === 'function') liste.push({ g: gr.aktionen, t: tx('warenkorb'), k: 'cart warenkorb bestellen order', tun: function () { window.navWarenkorb(); } });
      if (typeof window.openAccountOverlay === 'function') liste.push({ g: gr.aktionen, t: tx('konto'), k: 'account login anmelden', tun: function () { window.openAccountOverlay('kompakt'); } });
      if (typeof window.openGroupOverlay === 'function') liste.push({ g: gr.aktionen, t: tx('gruppe'), k: 'gruppe team büro office', tun: function () { window.openGroupOverlay(); } });
    } else {
      liste.push({ g: gr.aktionen, t: tx('konto'), k: 'account login anmelden', tun: zuSeite('/#konto') });
    }

    var SK = window.SPEISEKARTE;
    if (STARTSEITE && SK && SK.MENU) {
      SK.MENU.forEach(function (it) {
        var name = typeof window.productName === 'function' ? window.productName(it) : it.name;
        var preis = typeof window.formatPrice === 'function' ? window.formatPrice(it.price) : '';
        var desc = typeof window.productDesc === 'function' ? window.productDesc(it) : (it.desc || '');
        liste.push({ g: gr.karte, t: name, rechts: preis, k: desc + ' ' + it.cat + (it.veggie ? ' veggie vegan' : ''), tun: zeigeArtikel(it.id) });
      });
    }

    [['menu', 'nav.menu', 'Speisekarte'], ['story', 'nav.about', 'Über uns'], ['location', 'nav.location_hours', 'Standort & Zeiten'],
      ['catering', 'nav.catering', 'Catering'], ['faq', 'nav.faq', 'FAQ']].forEach(function (b) {
      liste.push({ g: gr.bereiche, t: tr(b[1], b[2]), k: b[0] + ' öffnungszeiten opening hours adresse', tun: zuStartseite(b[0]) });
    });

    [['/liefergebiet', 'footer.menu_delivery', 'Liefergebiet', 'lieferung delivery zone'], ['/halal', 'footer.menu_halal', 'Halal-Zertifikat', 'halal hcg zertifikat'],
      ['/catering', 'footer.menu_catering', 'Foodtruck-Catering', 'catering event feier hochzeit'], ['/firmen', 'footer.menu_firmen', 'Firmen-Mittag', 'firma büro rechnung office'],
      ['/gutscheine', 'firmen.foot_vouchers', 'Gutscheine', 'gutschein geschenk gift voucher'], ['/agb', 'footer.agb', 'AGB', 'agb terms bedingungen']].forEach(function (s) {
      if (location.pathname.replace(/\.html$/, '') === s[0]) return;
      liste.push({ g: gr.seiten, t: tr(s[1], s[2]), k: s[3], tun: zuSeite(s[0]) });
    });

    if (typeof window.setLang === 'function' && typeof LANGS !== 'undefined') {
      LANGS.forEach(function (l) {
        if (l.code === (document.documentElement.lang || 'de')) return;
        liste.push({ g: gr.sprache, t: l.label, k: 'sprache language ' + l.code, tun: function () { window.setLang(l.code); } });
      });
    }
    return liste;
  }

  function filtern(liste, q) {
    var woerter = norm(q).split(/\s+/).filter(Boolean);
    if (!woerter.length) {
      // Ohne Eingabe: Aktionen, Bereiche, die ersten Burger, Seiten
      var zaehl = {};
      return liste.filter(function (e) {
        zaehl[e.g] = (zaehl[e.g] || 0) + 1;
        return e.g !== tx('sprache') && (e.g !== tx('karte') || zaehl[e.g] <= 5);
      });
    }
    return liste.map(function (e) {
      var titel = norm(e.t), alles = titel + ' ' + norm(e.k);
      if (!woerter.every(function (w) { return alles.indexOf(w) >= 0; })) return null;
      var punkte = titel.indexOf(woerter[0]) === 0 ? 3 : (titel.indexOf(woerter[0]) > 0 ? 2 : 1);
      return { e: e, p: punkte };
    }).filter(Boolean).sort(function (a, b) { return b.p - a.p; }).map(function (x) { return x.e; });
  }

  /* ---- Fenster ------------------------------------------------------------ */
  var fenster, feld, liste, aktiv = 0, treffer = [], vorher = null;

  function taste(txt) { var k = document.createElement('kbd'); k.textContent = txt; return k; }

  function bauen() {
    fenster = document.createElement('dialog');
    fenster.className = 'befehle-fenster';
    fenster.setAttribute('aria-label', tx('knopf'));
    var kopf = fenster.appendChild(document.createElement('div'));
    kopf.className = 'befehle-kopf';
    kopf.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>');
    feld = kopf.appendChild(document.createElement('input'));
    feld.type = 'search';
    feld.className = 'befehle-feld';
    feld.setAttribute('role', 'combobox');
    feld.setAttribute('aria-expanded', 'true');
    feld.setAttribute('aria-controls', 'befehleListe');
    feld.setAttribute('aria-autocomplete', 'list');
    feld.setAttribute('autocomplete', 'off');
    feld.setAttribute('spellcheck', 'false');
    feld.setAttribute('enterkeyhint', 'go');
    kopf.appendChild(taste('Esc')).className = 'befehle-esc';
    liste = fenster.appendChild(document.createElement('ul'));
    liste.id = 'befehleListe';
    liste.className = 'befehle-liste';
    liste.setAttribute('role', 'listbox');
    var fuss = fenster.appendChild(document.createElement('div'));
    fuss.className = 'befehle-fuss';
    document.body.appendChild(fenster);

    feld.addEventListener('input', function () { aktiv = 0; zeichnen(); });
    feld.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); waehle(aktiv + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); waehle(aktiv - 1); }
      else if (e.key === 'Home') { e.preventDefault(); waehle(0); }
      else if (e.key === 'End') { e.preventDefault(); waehle(treffer.length - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); ausfuehren(aktiv); }
    });
    liste.addEventListener('click', function (e) {
      var li = e.target.closest('[data-i]');
      if (li) ausfuehren(Number(li.getAttribute('data-i')));
    });
    liste.addEventListener('pointermove', function (e) {
      var li = e.target.closest('[data-i]');
      if (li && Number(li.getAttribute('data-i')) !== aktiv) waehle(Number(li.getAttribute('data-i')), true);
    });
    // Esc selbst behandeln: Andere Esc-Handler der Seite verhindern sonst das
    // eingebaute Schließen des <dialog>
    fenster.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); schliessen(); }
    });
    // Klick auf den abgedunkelten Rand schließt
    fenster.addEventListener('click', function (e) { if (e.target === fenster) schliessen(); });
    fenster.addEventListener('close', function () {
      document.documentElement.classList.remove('befehle-offen');
      if (vorher && vorher.focus) { try { vorher.focus({ preventScroll: true }); } catch (e) {} }
    });
  }

  function fussZeichnen() {
    var fuss = fenster.querySelector('.befehle-fuss');
    fuss.textContent = '';
    [[['↑', '↓'], tx('waehlen')], [['↵'], tx('oeffnen')], [['Esc'], tx('schliessen')]].forEach(function (h) {
      var s = fuss.appendChild(document.createElement('span'));
      h[0].forEach(function (k) { s.appendChild(taste(k)); });
      s.appendChild(document.createTextNode(h[1]));
    });
  }

  function zeichnen() {
    treffer = filtern(eintraege(), feld.value);
    liste.textContent = '';
    if (!treffer.length) {
      var leer = liste.appendChild(document.createElement('li'));
      leer.className = 'befehle-leer'; leer.setAttribute('role', 'presentation'); leer.textContent = tx('leer');
      feld.removeAttribute('aria-activedescendant');
      return;
    }
    var gruppe = null;
    treffer.forEach(function (e, i) {
      if (e.g !== gruppe) {
        gruppe = e.g;
        var gl = liste.appendChild(document.createElement('li'));
        gl.className = 'befehle-gruppe'; gl.setAttribute('role', 'presentation'); gl.textContent = gruppe;
      }
      var li = liste.appendChild(document.createElement('li'));
      li.id = 'befehl-' + i;
      li.className = 'befehle-eintrag';
      li.setAttribute('role', 'option');
      li.setAttribute('data-i', String(i));
      li.appendChild(document.createElement('span')).textContent = e.t;
      if (e.rechts) { var r = li.appendChild(document.createElement('span')); r.className = 'befehle-rechts'; r.textContent = e.rechts; }
    });
    waehle(Math.min(aktiv, treffer.length - 1), true);
  }

  function waehle(i, ohneScroll) {
    if (!treffer.length) return;
    aktiv = (i + treffer.length) % treffer.length;
    [].forEach.call(liste.querySelectorAll('.befehle-eintrag'), function (li) {
      var an = Number(li.getAttribute('data-i')) === aktiv;
      li.setAttribute('aria-selected', an ? 'true' : 'false');
      if (an && !ohneScroll) li.scrollIntoView({ block: 'nearest' });
    });
    feld.setAttribute('aria-activedescendant', 'befehl-' + aktiv);
  }

  function ausfuehren(i) {
    var e = treffer[i];
    if (!e) return;
    vorher = null;            // Fokus wandert zum Ziel, nicht zurück zum Knopf
    schliessen();
    setTimeout(function () { try { e.tun(); } catch (err) {} }, 10);
  }

  function oeffnen() {
    if (!fenster) bauen();
    if (fenster.open) return;
    vorher = document.activeElement;
    feld.placeholder = tx('suchen');
    fenster.setAttribute('aria-label', tx('knopf'));
    fussZeichnen();
    feld.value = '';
    aktiv = 0;
    zeichnen();
    document.documentElement.classList.add('befehle-offen');
    fenster.showModal();
    feld.focus();
  }
  function schliessen() { if (fenster && fenster.open) fenster.close(); }
  window.gncBefehle = { oeffnen: oeffnen, schliessen: schliessen };

  /* ---- Tastenkürzel ------------------------------------------------------ */
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      if (fenster && fenster.open) schliessen(); else oeffnen();
      return;
    }
    if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      var z = e.target;
      if (z && (z.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(z.tagName))) return;
      if (document.querySelector('dialog[open], .cart-drawer.open, .upsell-overlay.open, .modal-overlay.open')) return;
      e.preventDefault();
      oeffnen();
    }
  });

  /* ---- Lupe im Kopf (Desktop) mit Tastenhinweis --------------------------- */
  function knopfEinsetzen() {
    var ziel = document.querySelector('.nav-actions #accountBtn') || document.querySelector('.sk-aktionen .sk-icon');
    if (!ziel || document.querySelector('.befehle-knopf')) return;
    var k = document.createElement('button');
    k.type = 'button';
    k.className = (ziel.classList.contains('sk-icon') ? 'sk-icon' : 'nav-icon-btn') + ' befehle-knopf';
    k.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
    var hinweis = k.appendChild(document.createElement('span'));
    hinweis.className = 'befehle-hinweis';
    kuerzel().forEach(function (t) { hinweis.appendChild(taste(t)); });
    function beschriften() {
      var text = tx('knopf') + ' (' + kuerzel().join(MAC ? '' : '+') + ')';
      k.setAttribute('aria-label', text);
      k.setAttribute('aria-keyshortcuts', MAC ? 'Meta+K' : 'Control+K');
      k.title = text;
    }
    beschriften();
    document.addEventListener('gnc-sprache', beschriften);
    k.addEventListener('click', oeffnen);
    ziel.parentNode.insertBefore(k, ziel);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', knopfEinsetzen); else knopfEinsetzen();
})();
