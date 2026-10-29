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
 * 3. LIEFERGEBIET UND HALAL
 *    liefergebiet.html: Zonen, Preise, Karte und Radius kommen aus
 *    speisekarte.js (DELIVERY_ZONES, MAX_DELIVERY_KM). Ändert sich dort etwas,
 *    stimmt die Seite nach dem nächsten Deploy. Beide Seiten bekommen ihre
 *    FAQ-Daten für Google aus den sichtbaren <details>.
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

/* ---- 3. Unterseiten: Liefergebiet und Halal -------------------------------- */
// Bereiche zwischen <!-- NAME:START ... --> und <!-- NAME:ENDE --> neu füllen.
function bereich(html, name, inhalt, datei) {
  const rx = new RegExp('(<!-- ' + name + ':START[^>]*-->)[\\s\\S]*?(<!-- ' + name + ':ENDE -->)');
  if (!rx.test(html)) throw new Error('Marker ' + name + ' fehlt in ' + datei);
  return html.replace(rx, (_, a, b) => a + '\n' + inhalt + '\n' + b);
}

// FAQ-Daten für Google aus den sichtbaren <details>, damit beides übereinstimmt.
function faqDaten(html, url) {
  const fragen = [...html.matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>\s*<p>([\s\S]*?)<\/p>\s*<\/details>/g)]
    .map((m) => {
      const text = (x) => x.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
      return { '@type': 'Question', name: text(m[1]), acceptedAnswer: { '@type': 'Answer', text: text(m[2]) } };
    });
  const daten = { '@context': 'https://schema.org', '@type': 'FAQPage', '@id': url + '#faq', inLanguage: 'de', mainEntity: fragen };
  const rx = /(<script type="application\/ld\+json" id="faq-daten">)[\s\S]*?(<\/script>)/;
  if (!rx.test(html)) throw new Error('<script id="faq-daten"> fehlt (' + url + ')');
  return html.replace(rx, (_, a, b) => a + '\n' + JSON.stringify(daten, null, 2) + '\n' + b);
}

// Bezugspunkt wie im Shop (getRestaurantOrigin): die Nominatim-Koordinate der
// Truck-Adresse. Stadtteil-Mittelpunkte ebenfalls aus OpenStreetMap/Nominatim,
// abgefragt am 29.10.2026. seite: wohin die Beschriftung auf der Karte zeigt.
const TRUCK = { lat: 51.98685, lon: 8.48556 };
const ORTE = [
  { name: 'Quelle', lat: 51.9975, lon: 8.4832, seite: 'l' },
  { name: 'Brackwede', lat: 51.9875, lon: 8.5163, seite: 'r' },
  { name: 'Ummeln', lat: 51.9694, lon: 8.4600, seite: 'l' },
  { name: 'Senne', lat: 51.9669, lon: 8.5140, seite: 'r' },
  { name: 'Gadderbaum', lat: 52.0031, lon: 8.5216, seite: 'o' },
  { name: 'Mitte', lat: 52.0209, lon: 8.5309, seite: 'r' },
  { name: 'Avenwedde', lat: 51.9378, lon: 8.4451, seite: 'r' },
  { name: 'Stieghorst', lat: 51.9982, lon: 8.5799, seite: 'r' },
  { name: 'Isselhorst', lat: 51.9460, lon: 8.4128, seite: 'l' },
  { name: 'Dornberg', lat: 52.0472, lon: 8.4540, seite: 'l' },
  { name: 'Steinhagen', lat: 51.9996, lon: 8.3836, seite: 'l' },
  { name: 'Sennestadt', lat: 51.9460, lon: 8.5851, seite: 'r' },
  { name: 'Schildesche', lat: 52.0532, lon: 8.5541, seite: 'r' },
  { name: 'Heepen', lat: 52.0320, lon: 8.6035, seite: 'r' },
  { name: 'Gütersloh', lat: 51.9167, lon: 8.4043, seite: 'l' },
  { name: 'Jöllenbeck', lat: 52.0964, lon: 8.5130, seite: 'r' },
];
// Abgerundet, damit 2,96 km nicht als „3,0 km“ in der Zone „bis 3 km“ steht
const kmText = (k) => (Math.floor(k * 10) / 10).toFixed(1).replace('.', ',') + ' km';
function luftlinie(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
const ZONEN = SK.DELIVERY_ZONES.map((z, i) => ({
  ...z, nr: i + 1, von: i ? SK.DELIVERY_ZONES[i - 1].maxKm : 0,
}));
const zoneVon = (k) => (k <= SK.MAX_DELIVERY_KM ? ZONEN.find((z) => k <= z.maxKm) : null);
const ORTE_KM = ORTE.map((o) => ({ ...o, km: luftlinie(TRUCK, o) })).sort((a, b) => a.km - b.km);
const ZONEN_FARBE = ['#FF7A3D', '#E85A24', '#A8441E'];
const spanne = (z) => (z.von ? `${z.von} bis ${z.maxKm} km` : `bis ${z.maxKm} km`);

function karteSvg() {
  const M = 200, R = 180, s = R / SK.MAX_DELIVERY_KM;
  const cos = Math.cos(TRUCK.lat * Math.PI / 180);
  const punkt = (o) => ({
    x: M + (o.lon - TRUCK.lon) * cos * 111.32 * s,
    y: M - (o.lat - TRUCK.lat) * 110.57 * s,
  });
  const ringe = [...ZONEN].reverse().map((z) => {
    const i = z.nr - 1;
    return `<circle cx="${M}" cy="${M}" r="${(z.maxKm * s).toFixed(1)}" fill="${ZONEN_FARBE[i]}" fill-opacity="${[0.26, 0.15, 0.07][i] || 0.07}" stroke="${ZONEN_FARBE[i]}" stroke-opacity="0.55" stroke-width="1"/>`
      + `<text x="${M}" y="${(M - z.maxKm * s - 5).toFixed(1)}" text-anchor="middle" class="ring">${z.maxKm} km</text>`;
  }).join('');
  const orte = ORTE_KM.filter((o) => zoneVon(o.km)).map((o) => {
    const p = punkt(o);
    const t = o.seite === 'l' ? { x: p.x - 7, y: p.y + 4, a: 'end' }
      : o.seite === 'o' ? { x: p.x, y: p.y - 8, a: 'middle' } : { x: p.x + 7, y: p.y + 4, a: 'start' };
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.6" class="ort"/>`
      + `<text x="${t.x.toFixed(1)}" y="${t.y.toFixed(1)}" text-anchor="${t.a}" class="ortname">${esc(o.name)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 400 400" role="img" aria-labelledby="kartenTitel">
  <title id="kartenTitel">Lieferzonen rund um den Truck in Brackwede: ${ZONEN.map((z) => `Zone ${z.nr} ${spanne(z)}`).join(', ')}</title>
  <style>.ring{font:600 10px Inter,sans-serif;fill:#8F8471}.ort{fill:#F5E9D0}.ortname{font:600 11px Inter,sans-serif;fill:#C9BCA4}.truck{font:800 10px Inter,sans-serif;fill:#FFC93C;letter-spacing:.08em}</style>
  ${ringe}${orte}
  <circle cx="${M}" cy="${M}" r="7" fill="#FFC93C" stroke="#0C0B09" stroke-width="2"/>
  <text x="${M}" y="${M + 20}" text-anchor="middle" class="truck">TRUCK</text>
</svg>`;
}

function zonenHtml() {
  const karten = ZONEN.map((z) => {
    const orte = ORTE_KM.filter((o) => zoneVon(o.km) === z)
      .map((o) => `<li>${esc(o.name)} <span>${kmText(o.km)}</span></li>`).join('');
    return `<div class="zone">
        <div class="zone-kopf"><span class="zone-nr"><i style="background:${ZONEN_FARBE[z.nr - 1]}"></i>Zone ${z.nr}</span><span class="zone-km">${spanne(z)}</span></div>
        <dl><div><dt>Mindestbestellwert</dt><dd>${preis(z.minOrder)}</dd></div><div><dt>Liefergebühr</dt><dd>${preis(z.fee)}</dd></div></dl>
        ${orte ? `<ul class="orte" aria-label="Stadtteile, deren Mitte in Zone ${z.nr} liegt">${orte}</ul>` : ''}
      </div>`;
  }).join('\n      ');
  return `<div class="zonen">
      <div class="karte-svg">${karteSvg()}</div>
      <div class="zone-liste">
      ${karten}
      </div>
    </div>
    <p class="zone-notiz">Entfernung jeweils Luftlinie vom Truck zur Mitte des Stadtteils (Daten: OpenStreetMap). Weiter als ${SK.MAX_DELIVERY_KM} km liefern wir nicht.</p>`;
}

function liefergebietBauen(html) {
  const datei = 'liefergebiet.html';
  const guenstigste = Math.min(...ZONEN.map((z) => z.fee));
  html = bereich(html, 'FAKTEN', `      <div class="hero-facts">
        <div><b>${SK.MAX_DELIVERY_KM} km</b>Luftlinie</div>
        <div><b>ab ${preis(guenstigste)}</b>Liefergebühr</div>
        <div><b>30 bis 45 Min.</b>Lieferzeit</div>
        <div><b>Mo bis Sa</b>12:00 bis 20:30</div>
      </div>`, datei);
  html = bereich(html, 'ZONEN', zonenHtml(), datei);
  const fern = ORTE_KM.filter((o) => zoneVon(o.km)).slice(-3).map((o) => o.name);
  html = bereich(html, 'RADIUS', `Bis ${SK.MAX_DELIVERY_KM} km Luftlinie rund um unseren Truck in der Gütersloher Straße 122, zum Beispiel bis ${fern.slice(0, -1).join(', ')} und ${fern[fern.length - 1]}.`, datei);
  html = bereich(html, 'PREISE', ZONEN.map((z) => `Zone ${z.nr} (${spanne(z)}): ${preis(z.minOrder)} Mindestbestellwert, ${preis(z.fee)} Liefergebühr.`).join(' ')
    + ' Welche Zone für dich gilt, zeigt die Adressprüfung oben.', datei);
  return faqDaten(html, SEITE + '/liefergebiet');
}

/* ---- Ablauf ---------------------------------------------------------------- */
const indexPfad = path.join(WURZEL, 'index.html');
const deHtml = karteEinsetzen(fs.readFileSync(indexPfad, 'utf8'), 'de');
fs.writeFileSync(indexPfad, deHtml);

const trHtml = tuerkischeSeite(deHtml);
fs.mkdirSync(path.join(WURZEL, 'tr'), { recursive: true });
fs.writeFileSync(path.join(WURZEL, 'tr', 'index.html'), trHtml);

const lgPfad = path.join(WURZEL, 'liefergebiet.html');
fs.writeFileSync(lgPfad, liefergebietBauen(fs.readFileSync(lgPfad, 'utf8')));
const halalPfad = path.join(WURZEL, 'halal.html');
fs.writeFileSync(halalPfad, faqDaten(fs.readFileSync(halalPfad, 'utf8'), SEITE + '/halal'));

const reste = (trHtml.match(/data-i18n="[^"]+"/g) || []).length;
console.log('seiten-bauen: Speisekarte mit ' + SK.MENU.length + ' Artikeln in index.html, tr/index.html geschrieben ('
  + Math.round(trHtml.length / 1024) + ' KB, ' + reste + ' data-i18n-Stellen), liefergebiet.html und halal.html aktualisiert.');
