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
 * 3. LIEFERGEBIET, HALAL UND AGB
 *    agb.html: Text aus LEGAL.agb in index.html (Nutzungsbedingungen-URL
 *    für Google Play), siehe agbBauen().
 *    liefergebiet.html: Zonen, Preise, Karte und Radius kommen aus
 *    speisekarte.js (DELIVERY_ZONES, MAX_DELIVERY_KM). Ändert sich dort etwas,
 *    stimmt die Seite nach dem nächsten Deploy. Beide Seiten bekommen ihre
 *    FAQ-Daten für Google aus den sichtbaren <details>.
 *
 * 4. CONTENT-SECURITY-POLICY (_headers)
 *    Skripte laufen nur aus eigenen Dateien und aus den Inline-Blöcken, deren
 *    Hash in der Policy steht. 'unsafe-inline' fehlt: Eingeschleustes HTML
 *    kann keinen Code mehr ausführen und keine Anmelde-Tokens auslesen.
 *    Deshalb gibt es kein onclick="…" mehr, sondern data-on-click="…"
 *    (ereignisse.js). Jede Änderung an einem Inline-Skript ändert seinen
 *    Hash; darum schreibt jeder Build _headers neu, nach allen anderen
 *    Schritten. Die übrigen Sicherheits-Header stehen in netlify.toml.
 *
 * tr/ und _headers stehen in .gitignore: Sie entstehen bei jedem Deploy neu
 * und können deshalb nie hinter index.html zurückbleiben. index.html selbst wird mit der
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
      ? `<img src="${esc(bildPfad(item.image))}" alt="${esc(name(item))}" class="menu-card-photo" width="600" height="600" loading="lazy" decoding="async" />`
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
  titel: "Grill'n Chill | Helal Burger Bielefeld, Teslimat ve Gel-Al",
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

// Übersetzungsschlüssel mit Zahlen aus speisekarte.js (i18n.js setzt {name} ein)
const vars = (v) => " data-i18n-vars='" + JSON.stringify(v).replace(/'/g, '&#39;') + "'";
const ue = (key, v) => ` data-i18n="${key}"` + (v ? vars(v) : '');
const spanneHtml = (z) => (z.von
  ? `<span${ue('lgb.spanne_von_bis', { von: z.von, bis: z.maxKm })}>${z.von} bis ${z.maxKm} km</span>`
  : `<span${ue('lgb.spanne_bis', { bis: z.maxKm })}>bis ${z.maxKm} km</span>`);

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
  <title id="kartenTitel"${ue('lgb.svg_titel', { ringe: ZONEN.map((z) => z.maxKm).join(', ') })}>Lieferzonen rund um den Truck in Brackwede, Ringe bei ${ZONEN.map((z) => z.maxKm).join(', ')} km</title>
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
        <div class="zone-kopf"><span class="zone-nr"><i style="background:${ZONEN_FARBE[z.nr - 1]}"></i><span${ue('lgb.zone', { nr: z.nr })}>Zone ${z.nr}</span></span><span class="zone-km">${spanneHtml(z)}</span></div>
        <dl><div><dt data-i18n="lgb.mindest">Mindestbestellwert</dt><dd>${preis(z.minOrder)}</dd></div><div><dt data-i18n="lgb.gebuehr">Liefergebühr</dt><dd>${preis(z.fee)}</dd></div></dl>
        ${orte ? `<ul class="orte" aria-label="Stadtteile, deren Mitte in Zone ${z.nr} liegt" data-i18n-aria="lgb.orte_aria"${vars({ nr: z.nr })}>${orte}</ul>` : ''}
      </div>`;
  }).join('\n      ');
  return `<div class="zonen">
      <div class="karte-svg">${karteSvg()}</div>
      <div class="zone-liste">
      ${karten}
      </div>
    </div>
    <p class="zone-notiz"${ue('lgb.notiz', { km: SK.MAX_DELIVERY_KM })}>Entfernung jeweils Luftlinie vom Truck zur Mitte des Stadtteils (Daten: OpenStreetMap). Weiter als ${SK.MAX_DELIVERY_KM} km liefern wir nicht.</p>`;
}

function liefergebietBauen(html) {
  const datei = 'liefergebiet.html';
  const guenstigste = Math.min(...ZONEN.map((z) => z.fee));
  html = bereich(html, 'FAKTEN', `      <div class="hero-facts">
        <div><b>${SK.MAX_DELIVERY_KM} km</b><span data-i18n="lgb.f_luft">Luftlinie</span></div>
        <div><b${ue('lgb.ab', { x: preis(guenstigste) })}>ab ${preis(guenstigste)}</b><span data-i18n="lgb.gebuehr">Liefergebühr</span></div>
        <div><b${ue('lgb.min_spanne', { a: 30, b: 45 })}>30 bis 45 Min.</b><span data-i18n="lgb.f_zeit">Lieferzeit</span></div>
        <div><b data-i18n="lgb.mo_sa">Mo bis Sa</b><span${ue('lgb.uhr_spanne', { a: '12:00', b: '20:30' })}>12:00 bis 20:30</span></div>
      </div>`, datei);
  html = bereich(html, 'ZONEN', zonenHtml(), datei);
  const fern = ORTE_KM.filter((o) => zoneVon(o.km)).slice(-3).map((o) => o.name);
  const rv = { km: SK.MAX_DELIVERY_KM, orte: fern.slice(0, -1).join(', '), letzter: fern[fern.length - 1] };
  html = bereich(html, 'RADIUS', `<span${ue('lgb.radius', rv)}>Bis ${rv.km} km Luftlinie rund um unseren Truck in der Gütersloher Straße 122, zum Beispiel bis ${rv.orte} und ${rv.letzter}.</span>`, datei);
  html = bereich(html, 'PREISE', ZONEN.map((z) => {
    const v = { nr: z.nr, von: z.von, bis: z.maxKm, min: preis(z.minOrder), fee: preis(z.fee) };
    return z.von
      ? `<span${ue('lgb.preis_von_bis', v)}>Zone ${z.nr} (${z.von} bis ${z.maxKm} km): ${v.min} Mindestbestellwert, ${v.fee} Liefergebühr.</span>`
      : `<span${ue('lgb.preis_bis', v)}>Zone ${z.nr} (bis ${z.maxKm} km): ${v.min} Mindestbestellwert, ${v.fee} Liefergebühr.</span>`;
  }).join(' ') + ' <span data-i18n="lgb.preis_ende">Welche Zone für dich gilt, zeigt die Adressprüfung oben.</span>', datei);
  return faqDaten(html, SEITE + '/liefergebiet');
}

/* ---- 3b. AGB als eigene Seite /agb ---------------------------------------- */
// Google Play verlangt für die Nutzungsbedingungen eine normale Webseite. Die
// AGB stehen als LEGAL.agb in index.html (Fenster „AGB“). agb.html übernimmt
// genau diesen Text, damit Fenster und Seite nie auseinanderlaufen.
function agbBauen(html, indexHtml) {
  const m = /\n  agb: \{\n    title: '[^']*',\n    body: `([\s\S]*?)`,\n  \},/.exec(indexHtml);
  if (!m) throw new Error('LEGAL.agb fehlt in index.html');
  let text = m[1];
  if (/\$\{|\\/.test(text)) throw new Error('LEGAL.agb enthält ${…} oder \\, agb.html kann den Text so nicht übernehmen');
  const marken = [];
  text = text.replace(/<h4>([\s\S]*?)<\/h4>/g, (_, titel) => {
    const nr = (/§\s*(\d+)/.exec(titel) || [])[1];
    const id = nr ? 'p' + nr : 'abschnitt-' + (marken.length + 1);
    marken.push({ id, titel });
    return '<h2 id="' + id + '">' + titel + '</h2>';
  });
  if (marken.length < 10) throw new Error('LEGAL.agb hat nur ' + marken.length + ' Abschnitte');
  const verzeichnis = '    <nav aria-label="Inhalt"><ul class="pillen">\n'
    + marken.map((x) => '      <li><a class="pille" href="#' + x.id + '">' + x.titel + '</a></li>').join('\n')
    + '\n    </ul></nav>';
  html = bereich(html, 'AGB-VERZEICHNIS', verzeichnis, 'agb.html');
  return bereich(html, 'AGB', text.replace(/^\n+|\s+$/g, ''), 'agb.html');
}

/* ---- 3c. Gemeinsamer Kopf der Unterseiten ---------------------------------- */
// Halal, Liefergebiet, Catering, Firmen und Gutscheine hatten je einen eigenen
// Kopf mit „← Zur Hauptseite“ und sonst nichts. Jetzt tragen sie den Kopf der
// Startseite: Logo mit Namen, Menü, Status-Pille, Bestellen. Das HTML steht
// hier einmal und landet zwischen <!-- SEITENKOPF:START --> und :ENDE.
// Stile: seitenkopf.css. Pille und Menü: seitenkopf.js, das dieser Build aus
// werkzeug/seitenkopf-vorlage.js und den Öffnungszeiten aus index.html baut.
// Alle Unterseiten sind mehrsprachig (i18n.js), darum überall die Sprachwahl
const KOPF_SEITEN = {
  'halal.html': { mehr: 'halal', sprache: true },
  'liefergebiet.html': { mehr: 'liefergebiet', sprache: true },
  'catering.html': { aktiv: 'catering', sprache: true },
  'firmen.html': { mehr: 'firmen', sprache: true },
  'gutscheine.html': { mehr: 'gutscheine', appZurueck: true, sprache: true },
};
const FLAMME = '<svg class="sk-flamme" viewBox="0 0 16 20" aria-hidden="true"><path class="koerper" d="M8 1.3c2.4 2.9 1.2 4.6 2.5 5.9.9 1 1.9-.2 1.9-1.5 1.5 1.8 2.3 3.8 2.3 5.8 0 3.6-3 6.7-6.7 6.7S1.3 15.1 1.3 11.5c0-3.7 2.3-6 3.9-7.8C6.6 2 7.6 2 8 1.3z"/><path class="kern" d="M8 9.4c1 1.2.5 2 1 2.6.4.4.8-.1.8-.7.6.8 1 1.6 1 2.5 0 1.6-1.3 2.8-2.8 2.8s-2.8-1.2-2.8-2.8c0-1.6 1-2.6 1.7-3.4C7.4 9.7 7.8 9.7 8 9.4z"/></svg>';
function kopfHtml(o) {
  const akt = (id) => (o.aktiv === id ? ' aria-current="page"' : '');
  const mehrAkt = (id) => (o.mehr === id ? ' aria-current="page"' : '');
  const haupt = [
    ['/#menu', 'nav.menu', 'Speisekarte', ''],
    ['/#story', 'nav.about', 'Über uns', ''],
    ['/#location', '', '<span class="sk-wort-voll" data-i18n="nav.location_hours">Standort &amp; Zeiten</span><span class="sk-wort-kurz" data-i18n="nav.location">Standort</span>', ''],
    ['/catering', 'nav.catering', 'Catering', 'catering'],
    ['/#faq', 'nav.faq', 'FAQ', ''],
  ];
  const link = ([href, key, text, id]) => `<a href="${href}"${key ? ` data-i18n="${key}"` : ''}${id ? akt(id) : ''}>${text}</a>`;
  // Im Menü steht immer der ganze Name („Standort & Zeiten“)
  const menuLink = ([href, key, text, id]) => `<li><a href="${href}" data-i18n="${key || 'nav.location_hours'}"${id ? akt(id) : ''}>${key ? text : 'Standort &amp; Zeiten'}</a></li>`;
  const mehr = [
    ['/liefergebiet', 'footer.menu_delivery', 'Liefergebiet', 'liefergebiet'],
    ['/halal', 'footer.menu_halal', 'Halal-Zertifikat', 'halal'],
    ['/firmen', 'footer.menu_firmen', 'Firmen-Mittag', 'firmen'],
    ['/gutscheine', 'firmen.foot_vouchers', 'Gutscheine', 'gutscheine'],
  ].map(([href, key, text, id]) => `<li><a href="${href}" data-i18n="${key}"${mehrAkt(id)}>${text}</a></li>`).join('\n          ');
  const sprache = o.sprache ? `
      <div class="lang-dd">
        <button type="button" class="lang-dd-btn" aria-haspopup="listbox" aria-expanded="false" data-on-click="toggleLangDd(null, this)">
          <span class="lang-dd-flag"></span>
          <span class="lang-dd-code">DE</span><span class="sk-sr" data-i18n="a11y.lang">Sprache wählen</span>
          <svg class="lang-dd-caret" viewBox="0 0 10 6" fill="none" aria-hidden="true"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <ul class="lang-dd-list" role="listbox" hidden></ul>
      </div>` : '';
  const zurueck = o.appZurueck ? `
      <a class="app-zurueck" id="appZurueck" href="/?app=1" hidden><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg><span data-text>Zurück</span></a>` : '';
  return `<a class="sk-skip" href="#main" data-i18n="sk.skip">Zum Inhalt springen</a>
<header class="sk-kopf" id="seitenkopf">
  <div class="sk-innen">
    <a class="sk-marke" id="marke" href="/" aria-label="Grill'n Chill, zur Startseite">
      <img src="/logo.png" alt="" width="44" height="44">
      <span lang="en">Grill'n Chill</span>
    </a>
    <nav class="sk-links" aria-label="Hauptnavigation" data-i18n-aria="a11y.nav_main">
      ${haupt.map(link).join('\n      ')}
    </nav>
    <div class="sk-aktionen">
      <a class="sk-status" id="skStatus" href="/#location" aria-label="Öffnungszeiten" hidden>${FLAMME}<span class="sk-status-lang"></span><span class="sk-status-kurz" aria-hidden="true"></span></a>${sprache}${zurueck}
      <a class="sk-bestellen" href="/#menu" data-i18n="nav.order">Bestellen</a>
      <details class="sk-menu">
        <summary aria-label="Menü öffnen"><span></span><span></span><span></span></summary>
        <div class="sk-menu-flaeche">
          <ul class="sk-menu-liste">
          ${haupt.map(menuLink).join('\n          ')}
          </ul>
          <ul class="sk-menu-mehr">
          ${mehr}
          </ul>
        </div>
      </details>
    </div>
  </div>
</header>`;
}

// Öffnungszeiten-Code aus index.html: von HOURS bis parseTime, dazu findNextOpening
function oeffnungszeitenQuelle(indexHtml) {
  const a = indexHtml.indexOf('const HOURS = {');
  const b = indexHtml.indexOf('// Öffnungsstatus als ganzer Satz', a);
  const c = indexHtml.indexOf('function findNextOpening(now) {');
  const d = c < 0 ? -1 : indexHtml.indexOf('\n}\n', c);
  if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error('Öffnungszeiten in index.html nicht gefunden (HOURS … parseTime, findNextOpening)');
  return indexHtml.slice(a, b).trim() + '\n\n' + indexHtml.slice(c, d + 2).trim();
}
function seitenkopfJsBauen(indexHtml) {
  const vorlage = lies('werkzeug/seitenkopf-vorlage.js');
  if (!vorlage.includes('/*%OEFFNUNGSZEITEN%*/')) throw new Error('Platzhalter fehlt in werkzeug/seitenkopf-vorlage.js');
  const code = vorlage.replace('/*%OEFFNUNGSZEITEN%*/', () => '/* ---- Öffnungszeiten, kopiert aus index.html ---- */\n'
    + oeffnungszeitenQuelle(indexHtml).split('\n').map((z) => (z ? '  ' + z : z)).join('\n'));
  new vm.Script(code, { filename: 'seitenkopf.js' });   // Syntaxfehler brechen den Build ab
  fs.writeFileSync(path.join(WURZEL, 'seitenkopf.js'), code);
}
// Überschriften mit Umlaut oder Akzent bekommen class="sk-luft" (seitenkopf.css)
const AKZENT = /[À-ÖØ-öø-ÿĀ-ſ]/;
function akzentLuft(html) {
  const a = html.indexOf('<main'), b = html.indexOf('</main>');
  if (a < 0 || b < 0) return html;
  const mitte = html.slice(a, b).replace(/<(h[12])(\s[^>]*)?>([\s\S]*?)<\/\1>/g, (m, tag, attrs, inner) => {
    attrs = attrs || '';
    const luft = AKZENT.test(inner.replace(/<[^>]+>/g, ''));
    const k = attrs.match(/\sclass="([^"]*)"/);
    let klassen = (k ? k[1].split(/\s+/) : []).filter((x) => x && x !== 'sk-luft');
    if (luft) klassen.push('sk-luft');
    const ohne = attrs.replace(/\sclass="[^"]*"/, '');
    return '<' + tag + (klassen.length ? ' class="' + klassen.join(' ') + '"' : '') + ohne + '>' + inner + '</' + tag + '>';
  });
  return html.slice(0, a) + mitte + html.slice(b);
}
function kopfEinsetzen(datei) {
  const p = path.join(WURZEL, datei);
  if (!fs.existsSync(p)) return;
  let html = fs.readFileSync(p, 'utf8');
  html = akzentLuft(bereich(html, 'SEITENKOPF', kopfHtml(KOPF_SEITEN[datei]), datei));
  if (!html.includes('<link rel="stylesheet" href="/seitenkopf.css">')) throw new Error('seitenkopf.css fehlt im <head> von ' + datei);
  if (!html.includes('<script src="/seitenkopf.js" defer></script>')) throw new Error('seitenkopf.js fehlt in ' + datei);
  if (!html.includes('<script src="/i18n.js"></script>')) throw new Error('i18n.js fehlt in ' + datei + ' (Sprachwahl im Kopf)');
  if (!/<main[^>]*\bid="main"/.test(html)) throw new Error('<main id="main"> fehlt in ' + datei + ' (Sprunglink)');
  fs.writeFileSync(p, html);
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
// Paket firmen: FAQ-Daten der Seite /firmen aus ihren <details>
const firmenPfad = path.join(WURZEL, 'firmen.html');
if (fs.existsSync(firmenPfad)) fs.writeFileSync(firmenPfad, faqDaten(fs.readFileSync(firmenPfad, 'utf8'), SEITE + '/firmen'));
const agbPfad = path.join(WURZEL, 'agb.html');
fs.writeFileSync(agbPfad, agbBauen(fs.readFileSync(agbPfad, 'utf8'), deHtml));
seitenkopfJsBauen(deHtml);
Object.keys(KOPF_SEITEN).forEach(kopfEinsetzen);

/* ---- Content-Security-Policy ---------------------------------------------- */
/* SumUp-Widget in der Kasse („Bezahlen ohne Umweg“, Admin-Schalter, Paket
   bezahlen). Laut SumUp-Doku und eigenem Blick ins SDK (gateway.sumup.com/
   gateway/ecom/card/v2/sdk.js) braucht es:
     script-src   gateway.sumup.com (SDK), ltxup.sumup.com (Betrugsprüfung von
                  SumUp, lädt das SDK nach), pay.google.com (Google Pay)
     connect-src  *.sumup.com (api, js, gateway), pay.google.com
     img-src      static.sumup.com, api.sumup.com (Kartenlogos), ltxup.sumup.com,
                  www.gstatic.com (Google-Pay-Knopf)
     frame-src    https: weil die 3-D-Secure-Abfrage im Rahmen läuft: SumUps
                  redirect.html schickt im selben Rahmen ein Formular an den
                  Server der kartenausgebenden Bank, und deren Adresse ist
                  jede beliebige. Mit einer festen Liste scheitert jede
                  Kartenzahlung mit 3-D Secure.
   style-src hat schon 'unsafe-inline' (das Widget setzt Inline-Stile). */
const crypto = require('crypto');
const CSP = [
  "default-src 'self'",
  "script-src 'self' %HASHES% https://challenges.cloudflare.com https://accounts.google.com https://appleid.cdn-apple.com https://gateway.sumup.com https://ltxup.sumup.com https://pay.google.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com/gsi/style",
  // Kartenkacheln für die Live-Lieferung (status.html) und die Liefer-Heatmap (cockpit.html), karte.js;
  // SumUp-Widget: Kartenlogos, Betrugsprüfung, Google-Pay-Knopf
  "img-src 'self' data: blob: https://tile.openstreetmap.org https://static.sumup.com https://api.sumup.com https://ltxup.sumup.com https://www.gstatic.com",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' https://nominatim.openstreetmap.org https://accounts.google.com https://appleid.apple.com https://*.sumup.com https://pay.google.com",
  // 'self' für die PDF-Vorschau der Catering-Angebote im Admin-Tool (Paket catering),
  // https: für die 3-D-Secure-Abfrage im SumUp-Widget (siehe oben)
  "frame-src 'self' https://maps.google.com https://www.google.com https://challenges.cloudflare.com https://accounts.google.com https:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

// Ausführbare Inline-Skripte: ohne src, ohne Datentyp wie application/ld+json
function inlineSkripte(html) {
  const aus = [];
  for (const m of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    const attr = m[1] || '';
    if (/\ssrc\s*=/i.test(attr)) continue;
    const typ = (/\stype\s*=\s*["']?([^"'\s>]+)/i.exec(attr) || [])[1];
    if (typ && !/^(text\/javascript|application\/javascript|module)$/i.test(typ)) continue;
    aus.push(m[2]);
  }
  return aus;
}

const seiten = fs.readdirSync(WURZEL).filter((f) => f.endsWith('.html')).concat('tr/index.html');
const hashes = new Set();
for (const f of seiten) {
  for (const code of inlineSkripte(lies(f))) {
    hashes.add("'sha256-" + crypto.createHash('sha256').update(code, 'utf8').digest('base64') + "'");
  }
}
const policy = CSP.replace('%HASHES%', [...hashes].join(' '));
fs.writeFileSync(path.join(WURZEL, '_headers'),
  '# Entsteht bei jedem Build (werkzeug/seiten-bauen.js). Nicht von Hand ändern.\n'
  + '/*\n  Content-Security-Policy: ' + policy + '\n');

const reste = (trHtml.match(/data-i18n="[^"]+"/g) || []).length;
console.log('seiten-bauen: Speisekarte mit ' + SK.MENU.length + ' Artikeln in index.html, tr/index.html geschrieben ('
  + Math.round(trHtml.length / 1024) + ' KB, ' + reste + ' data-i18n-Stellen), liefergebiet.html, halal.html und agb.html aktualisiert, '
  + '_headers mit ' + hashes.size + ' Skript-Hashes aus ' + seiten.length + ' Seiten.');
