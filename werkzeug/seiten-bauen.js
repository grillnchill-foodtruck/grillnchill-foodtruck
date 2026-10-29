#!/usr/bin/env node
/**
 * werkzeug/seiten-bauen.js
 * ----------------------------------------------------------------------------
 * Läuft bei jedem Netlify-Deploy (netlify.toml, [build] command) und lokal mit
 *   node werkzeug/seiten-bauen.js
 *
 * 1. SPEISEKARTE ALS HTML
 *    Die Karte entstand bisher nur per JavaScript (renderMenu in index.html).
 *    Google rendert das, die meisten KI-Crawler (ChatGPT, Claude, Perplexity)
 *    nicht: Sie sahen keine Gerichte und keine Preise. Jetzt steht die Karte
 *    fertig im HTML, zwischen den Markern SPEISEKARTE:START/ENDE in #menuGrid.
 *    Beim Laden ersetzt renderMenu() sie durch die interaktive Fassung. Die
 *    Karte liegt weit unter dem sichtbaren Bereich, der Tausch fällt nicht auf.
 *
 * 2. TÜRKISCHE SEITE /tr/
 *    Die Sprachen schaltet die Seite im Browser um, unter derselben Adresse.
 *    Suchmaschinen sahen deshalb nur Deutsch. tr/index.html ist dieselbe
 *    Seite mit allen data-i18n-Texten auf Türkisch, eigenem Titel, eigener
 *    Beschreibung, canonical und FAQ-Daten. <html data-seite="tr"> sorgt dafür,
 *    dass i18n.js dort mit Türkisch startet (detectLang).
 *    Pfade im HTML werden absolut (/logo.png statt logo.png). Was JavaScript
 *    relativ nachlädt (Produktbilder, Sprachpakete), leitet netlify.toml mit
 *    /tr/* -> /:splat aufs Hauptverzeichnis um.
 *
 * tr/ steht in .gitignore: Die Datei entsteht bei jedem Deploy neu und kann
 * deshalb nie hinter index.html zurückbleiben. index.html selbst wird mit der
 * eingebauten Karte committet, damit die lokale Vorschau sie auch zeigt.
 * ----------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WURZEL = path.join(__dirname, '..');
const SEITE = 'https://grillnchill-foodtruck.de';
const lies = (f) => fs.readFileSync(path.join(WURZEL, f), 'utf8');

const SK = require(path.join(WURZEL, 'speisekarte.js'));

/* ---- Übersetzungen laden: i18n.js und i18n-tr.js wie im Browser ---------- */
function sprachdaten() {
  const leer = () => null;
  const elementAttrappe = { getAttribute: leer, setAttribute() {}, appendChild() {}, style: {} };
  const ctx = {
    console,
    navigator: { language: 'de', userAgent: '' },
    localStorage: { getItem: leer, setItem() {} },
    document: {
      addEventListener() {}, querySelectorAll: () => [], querySelector: leer, getElementById: leer,
      createElement: () => elementAttrappe, documentElement: elementAttrappe, head: elementAttrappe,
    },
    window: { addEventListener() {} },
    setTimeout, clearTimeout,
  };
  vm.createContext(ctx);
  vm.runInContext(lies('i18n.js'), ctx, { filename: 'i18n.js' });
  vm.runInContext(lies('i18n-tr.js'), ctx, { filename: 'i18n-tr.js' });
  return vm.runInContext('({ de: I18N.de, tr: I18N.tr, produkte: PRODUCTS_I18N.tr || {}, tags: TAGS_I18N.tr || {} })', ctx);
}
const D = sprachdaten();

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const preis = (n) => n.toFixed(2).replace('.', ',') + ' €';

/* ---- 1. Speisekarte ------------------------------------------------------ */
// Gleiche Klassen wie renderMenu(), damit die Karte auch ohne JavaScript nach
// Grill'n Chill aussieht. Ohne Knöpfe: bestellen geht nur mit JavaScript.
function karteHtml(lang) {
  const t = (k) => (lang === 'de' ? D.de[k] : (D.tr[k] || D.de[k])) || k;
  const uebersetzt = (item) => (lang !== 'de' && D.produkte[item.id]) || null;
  const name = (item) => (uebersetzt(item) || item).name;
  const desc = (item) => (uebersetzt(item) || item).desc;
  const tag = (label) => (lang !== 'de' && D.tags[label]) || label;
  const bildPfad = (p) => (lang === 'de' ? p : '/' + p);

  const karten = SK.MENU.map((item) => {
    const codes = String(item.allergens || '').split(',').map((x) => x.trim()).filter(Boolean);
    let badges = '';
    if (item.cat === 'burger') badges += `<span class="info-badge info-badge-halal">☪ ${esc(t('badge.halal'))}</span>`;
    if (codes.length) badges += `<span class="info-badge info-badge-allergens">${esc(t('badge.allergens'))}: ${esc(codes.join(', '))}</span>`;

    const grundpreis = item.liter ? `<span class="menu-card-base">${preis(item.price / item.liter)}/l</span>` : '';
    let preise;
    if (item.cat === 'burger' && !SK.DOUBLE_PATTY_EXCLUDE_IDS.includes(item.id)) {
      preise = `<div class="patty-options">
          <div class="patty-row"><div class="patty-row-info"><span class="patty-label">${esc(t('menu.single'))}</span><span class="patty-price">${preis(item.price)}</span></div></div>
          <div class="patty-row patty-row-double"><div class="patty-row-info"><span class="patty-label">${esc(t('menu.double'))} <span class="patty-extra">+${preis(SK.DOUBLE_PATTY_PRICE)}</span></span><span class="patty-price">${preis(item.price + SK.DOUBLE_PATTY_PRICE)}</span></div></div>
        </div>`;
    } else {
      preise = `<div class="menu-card-footer"><span class="menu-card-price">${preis(item.price)}${grundpreis}</span></div>`;
    }
    const bild = item.image
      ? `<img src="${esc(bildPfad(item.image))}" alt="${esc(name(item))}" class="menu-card-photo" loading="lazy" decoding="async" />`
      : `<span style="font-size: 4.5rem; position: relative; z-index: 1;">${item.emoji}</span>`;
    const etikett = item.tag
      ? `<span class="menu-card-tag ${esc(item.tag.class)}">${item.tag.class === 'veggie' ? '🌱' : esc(tag(item.tag.label))}</span>` : '';
    return `<article class="menu-card">
      <div class="menu-card-img">${etikett}${bild}</div>
      <div class="menu-card-body">
        <h3 class="menu-card-title" style="margin-top:0">${esc(name(item))}</h3>
        <p class="menu-card-desc">${esc(desc(item))}</p>
        ${badges ? `<div class="menu-card-badges">${badges}</div>` : ''}
        ${preise}
      </div>
    </article>`;
  });
  return '<!-- SPEISEKARTE:START (werkzeug/seiten-bauen.js, nicht von Hand ändern) -->\n'
    + karten.join('\n') + '\n<!-- SPEISEKARTE:ENDE -->';
}

const KARTE_RX = /<!-- SPEISEKARTE:START[\s\S]*?<!-- SPEISEKARTE:ENDE -->/;
function karteEinsetzen(html, lang) {
  if (!KARTE_RX.test(html)) throw new Error('Marker SPEISEKARTE:START/ENDE fehlen in index.html (#menuGrid)');
  return html.replace(KARTE_RX, () => karteHtml(lang));
}

/* ---- Hilfen für die türkische Seite ---------------------------------------- */
// Script- und Style-Blöcke bleiben unangetastet: In den JS-Vorlagen steht
// ebenfalls data-i18n, das darf hier nicht ersetzt werden.
function ausserhalbVonCode(html, fn) {
  const teile = [];
  let pos = 0;
  const rx = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
  let m;
  while ((m = rx.exec(html))) {
    teile.push(fn(html.slice(pos, m.index)));
    teile.push(m[0]);
    pos = m.index + m[0].length;
  }
  teile.push(fn(html.slice(pos)));
  return teile.join('');
}

// Inhalt jedes Elements mit data-i18n="schluessel" ersetzen, wie es
// applyTranslations() im Browser tut (textContent).
function textErsetzen(html, t) {
  const auf = /<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\bdata-i18n="([^"]+)"[^>]*>/g;
  let aus = '';
  let pos = 0;
  let m;
  while ((m = auf.exec(html))) {
    const tagName = m[1];
    const wert = t(m[2]);
    const start = m.index + m[0].length;
    // passendes Schluss-Tag, verschachtelte gleichnamige Tags mitgezählt
    const rx = new RegExp('<(/?)' + tagName + '\\b[^>]*>', 'gi');
    rx.lastIndex = start;
    let tiefe = 1;
    let ende = -1;
    let z;
    while ((z = rx.exec(html))) {
      tiefe += z[1] ? -1 : 1;
      if (!tiefe) { ende = z.index; break; }
    }
    if (ende < 0 || wert == null) continue;
    aus += html.slice(pos, start) + esc(wert);
    pos = ende;
    auf.lastIndex = ende;
  }
  return aus + html.slice(pos);
}

function attributeErsetzen(html, t) {
  return html
    .replace(/<[^>]*\bdata-i18n-(placeholder|aria)="([^"]+)"[^>]*>/g, (tag, art, key) => {
      const wert = t(key);
      if (wert == null) return tag;
      const attr = art === 'aria' ? 'aria-label' : 'placeholder';
      const rx = new RegExp('\\b' + attr + '="[^"]*"');
      return rx.test(tag) ? tag.replace(rx, `${attr}="${esc(wert)}"`) : tag;
    });
}

// Relative Pfade in HTML-Attributen absolut machen (die Seite liegt unter /tr/).
function pfadeAbsolut(html) {
  return html.replace(/\b(src|href|data-src|poster)="(?!\/|#|https?:|mailto:|tel:|data:|javascript:|\$\{)([^"]+)"/g,
    (_, attr, wert) => `${attr}="/${wert}"`);
}

function ersetzePflicht(html, alt, neu, was) {
  if (!html.includes(alt)) throw new Error('Nicht gefunden (' + was + '): ' + alt.slice(0, 80));
  return html.split(alt).join(neu);
}
function metaInhalt(html, sel, wert) {
  const rx = new RegExp('(<meta ' + sel + ' content=")[^"]*(")');
  if (!rx.test(html)) throw new Error('Meta fehlt: ' + sel);
  return html.replace(rx, (_, a, b) => a + esc(wert) + b);
}

const TR = {
  titel: 'Grilln Chill | Helal Burger Bielefeld, Teslimat ve Gel-Al',
  beschreibung: "Bielefeld-Brackwede'de food truck'tan helal burger. Online sipariş ver, gel al veya teslimat iste, GRILL5 koduyla 5 € tasarruf et (20 € üzeri siparişte).",
  ogBeschreibung: "Bielefeld-Brackwede'den %100 helal burger ve sokak lezzetleri. Online sipariş ver, GRILL5 koduyla 5 € tasarruf et. Teslimat ve gel-al.",
  restaurant: "Bielefeld-Brackwede'de helal burger food truck'ı: %100 helal burgerler, tavuk nugget, patates kızartması ve sokak lezzetleri, taze ızgarada. Food truck'tan gel al veya Bielefeld, Gütersloh ve çevresine teslimat. Classic, Cheese, Chili-Cheese ve White BBQ vejetaryen ve vegan olarak da var.",
};

function jsonLdAnpassen(html, t) {
  const bloecke = [...html.matchAll(/(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g)];
  for (const b of bloecke.reverse()) {
    const daten = JSON.parse(b[2]);
    if (daten['@type'] === 'FAQPage') {
      // Aus den sichtbaren türkischen FAQ-Texten, damit Daten und Seite übereinstimmen
      const frage = [];
      for (let i = 1; t('faq.q' + i) && t('faq.q' + i) !== 'faq.q' + i; i++) {
        let antwort = t('faq.a' + i);
        if (i === 8) antwort = [t('faq.a8_intro'), t('faq.a8_z1'), t('faq.a8_z2'), t('faq.a8_z3'), t('faq.a8_outro')].join(' ');
        frage.push({
          '@type': 'Question',
          name: t('faq.q' + i),
          acceptedAnswer: { '@type': 'Answer', text: String(antwort).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() },
        });
      }
      daten['@id'] = SEITE + '/tr/#faq';
      daten.inLanguage = 'tr';
      daten.mainEntity = frage;
    } else if (daten['@type'] && [].concat(daten['@type']).includes('Restaurant')) {
      daten.description = TR.restaurant;
    }
    const neu = b[1] + '\n' + JSON.stringify(daten, null, 2) + '\n' + b[3];
    html = html.slice(0, b.index) + neu + html.slice(b.index + b[0].length);
  }
  return html;
}

function tuerkischeSeite(deHtml) {
  const t = (k) => (D.tr[k] != null ? D.tr[k] : D.de[k]);
  let h = karteEinsetzen(deHtml, 'tr');

  h = ersetzePflicht(h, '<html lang="de">', '<html lang="tr" data-seite="tr">', 'html lang');
  h = h.replace(/<title>[^<]*<\/title>/, '<title>' + esc(TR.titel) + '</title>');
  h = metaInhalt(h, 'name="description"', TR.beschreibung);
  h = metaInhalt(h, 'property="og:title"', TR.titel);
  h = metaInhalt(h, 'property="og:description"', TR.ogBeschreibung);
  h = metaInhalt(h, 'property="og:url"', SEITE + '/tr/');
  h = metaInhalt(h, 'property="og:locale"', 'tr_TR');
  h = ersetzePflicht(h, '<meta property="og:locale:alternate" content="tr_TR" />', '<meta property="og:locale:alternate" content="de_DE" />', 'og:locale:alternate');
  h = metaInhalt(h, 'name="twitter:title"', TR.titel);
  h = metaInhalt(h, 'name="twitter:description"', TR.ogBeschreibung);
  h = ersetzePflicht(h, `<link rel="canonical" href="${SEITE}/" />`, `<link rel="canonical" href="${SEITE}/tr/" />`, 'canonical');
  // Türkisch sofort da, kein Umweg über Deutsch
  h = ersetzePflicht(h, '<script src="i18n.js"></script>', '<script src="/i18n.js"></script>\n<script src="/i18n-tr.js"></script>', 'i18n.js');
  h = jsonLdAnpassen(h, t);

  h = ausserhalbVonCode(h, (stueck) => pfadeAbsolut(attributeErsetzen(textErsetzen(stueck, t), t)));
  // Externe Skripte stecken in den übersprungenen Script-Blöcken, ihre src gesondert
  h = h.replace(/<script src="(?!\/|https?:)([^"]+)"/g, (_, wert) => `<script src="/${wert}"`);
  return h;
}

/* ---- Ablauf ---------------------------------------------------------------- */
const indexPfad = path.join(WURZEL, 'index.html');
const deHtml = karteEinsetzen(fs.readFileSync(indexPfad, 'utf8'), 'de');
fs.writeFileSync(indexPfad, deHtml);

const trHtml = tuerkischeSeite(deHtml);
fs.mkdirSync(path.join(WURZEL, 'tr'), { recursive: true });
fs.writeFileSync(path.join(WURZEL, 'tr', 'index.html'), trHtml);

const reste = (trHtml.match(/data-i18n="[^"]+"/g) || []).length;
console.log('seiten-bauen: Speisekarte mit ' + SK.MENU.length + ' Artikeln in index.html, tr/index.html geschrieben ('
  + Math.round(trHtml.length / 1024) + ' KB, ' + reste + ' data-i18n-Stellen).');
