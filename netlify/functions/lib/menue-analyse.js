/**
 * lib/menue-analyse.js
 * ----------------------------------------------------------------------------
 * Menü-Engineering für das Cockpit: welcher Artikel bringt wie viel, und was
 * sollte Kubi damit tun? Reine Rechnung, ohne Speicher (testbar).
 *
 * DECKUNGSBEITRAG (Schätzung)
 * ---------------------------
 *   Nettopreis je Stück  = Umsatz des Artikels / Stück, ohne Umsatzsteuer
 *   Deckungsbeitrag      = Nettopreis je Stück minus Wareneinsatz
 *   Wareneinsatz-Quote   = Wareneinsatz / Nettopreis je Stück
 *
 * Die Steuersätze sind ein Spiegel der vorhandenen Logik in index.html
 * (VAT_FOOD 7 für Speisen, VAT_DRINK 19 für Getränke, splitVat). Hier wird
 * nur gelesen und nachgerechnet, die Steuer-Logik selbst bleibt unberührt.
 * werkzeug/cockpit-test.js prüft, dass der Spiegel zu index.html passt.
 * Rabatte, Liefergebühr und Trinkgeld fließen nicht ein: Grundlage ist der
 * Warenwert je Position. Deshalb steht in der Oberfläche "Schätzung".
 *
 * VIER-FELDER-TAFEL (nach Kasavana und Smith)
 * -------------------------------------------
 * Je Gruppe (Burger, Beilagen, Dips, Getränke oder alle zusammen):
 *   beliebt      Anteil an den verkauften Stück >= 70 % des Durchschnittsanteils
 *                (Durchschnittsanteil = 1 / Anzahl Artikel der Gruppe)
 *   hohe Marge   Deckungsbeitrag >= mengengewichteter Durchschnitt der Gruppe
 *
 *   Renner       beliebt, hohe Marge
 *   Zugpferd     beliebt, niedrige Marge
 *   Rätsel       hohe Marge, wenig gekauft
 *   Ladenhüter   wenig gekauft, niedrige Marge
 *
 * Die Tafel "alle" mischt Burger, Dips und Getränke. Sie zeigt die Lage,
 * aber keine Preis-Beträge; die stehen nur in der eigenen Gruppe.
 *
 * Artikel ohne Wareneinsatz bekommen kein Feld und zählen nicht in den
 * Durchschnitt der Marge. In die Beliebtheit gehen sie ein, denn die hängt
 * nicht am Wareneinsatz.
 * ----------------------------------------------------------------------------
 */

const { EXTRA_DOUBLE } = require('./tageswerte');

/* Spiegel von VAT_FOOD / VAT_DRINK in index.html (nur lesen) */
const SATZ_SPEISE = 7;
const SATZ_GETRAENK = 19;
const satzFuer = (cat) => (cat === 'drinks' ? SATZ_GETRAENK : SATZ_SPEISE);

const BELIEBT_FAKTOR = 0.7;

const GRUPPEN = [
  { id: 'burger', name: 'Burger' },
  { id: 'sides', name: 'Snacks & Beilagen' },
  { id: 'dips', name: 'Dips' },
  { id: 'drinks', name: 'Getränke' },
];
const FELDER = {
  renner: 'Renner',
  zugpferd: 'Zugpferd',
  raetsel: 'Rätsel',
  ladenhueter: 'Ladenhüter',
};

const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const fmtEur = (x) => eur.format(x).replace(/ /g, ' ');

/** Nettopreis aus Brutto und Steuersatz in Prozent. */
function netto(brutto, satz) {
  return (Number(brutto) || 0) / (1 + (Number(satz) || 0) / 100);
}

/** Alle Artikel der Karte plus Extras, in Karten-Reihenfolge. */
function artikelListe(sk) {
  const liste = sk.MENU.map((m) => ({
    id: m.id, name: m.name, cat: m.cat, preis: m.price, satz: satzFuer(m.cat), extra: false,
  }));
  liste.push({
    id: EXTRA_DOUBLE, name: 'Double Patty (Aufpreis)', cat: 'extra',
    preis: sk.DOUBLE_PATTY_PRICE, satz: SATZ_SPEISE, extra: true,
  });
  return liste;
}
function erlaubteIds(sk) {
  return new Set(artikelListe(sk).map((a) => a.id));
}

/** Wareneinsatz aus dem Store-Objekt { id: { cost, updatedAt } }, sonst null. */
function kostenWert(kosten, id) {
  const k = kosten && typeof kosten === 'object' ? kosten[id] : null;
  const c = k && typeof k === 'object' ? k.cost : null;
  return typeof c === 'number' && Number.isFinite(c) && c >= 0 ? c : null;
}

/**
 * Vier-Felder-Einordnung einer Gruppe.
 * @param {Array<{id, qty, db, satz}>} liste  db = null, wenn der Wareneinsatz fehlt
 */
function vierFelder(liste, optionen) {
  const o = optionen || {};
  const n = liste.length;
  const gesamt = liste.reduce((s, a) => s + (a.qty > 0 ? a.qty : 0), 0);
  const schwelleAnteil = n ? BELIEBT_FAKTOR / n : 0;
  let summeDb = 0, summeQty = 0;
  for (const a of liste) {
    if (a.db === null || a.db === undefined || !(a.qty > 0)) continue;
    summeDb += a.db * a.qty;
    summeQty += a.qty;
  }
  const schnittDb = summeQty > 0 ? summeDb / summeQty : null;
  const tafel = {
    n,
    gesamt,
    schwelleAnteil: r3(schwelleAnteil),
    schwelleStueck: r2(schwelleAnteil * gesamt),
    schnittDb: schnittDb === null ? null : r2(schnittDb),
    leer: gesamt === 0,
    punkte: {},
  };
  for (const a of liste) {
    const anteil = gesamt > 0 ? (a.qty > 0 ? a.qty : 0) / gesamt : 0;
    const beliebt = gesamt > 0 && anteil >= schwelleAnteil - 1e-12;
    const ohneKosten = a.db === null || a.db === undefined;
    const hoch = ohneKosten || schnittDb === null ? null : a.db >= schnittDb - 1e-9;
    let feld = null;
    if (!tafel.leer && hoch !== null) {
      feld = beliebt ? (hoch ? 'renner' : 'zugpferd') : (hoch ? 'raetsel' : 'ladenhueter');
    }
    tafel.punkte[a.id] = {
      anteil: r3(anteil), beliebt, hoch, feld,
      hinweis: hinweisText(feld, a, tafel, schnittDb, ohneKosten, o.gemischt),
    };
  }
  return tafel;
}

/* Ein konkreter Satz je Feld. Beim Zugpferd steht dabei, wie viel mehr der
   Preis bräuchte, um den Durchschnitt der Gruppe zu erreichen. */
function hinweisText(feld, a, tafel, schnittDb, ohneKosten, gemischt) {
  if (ohneKosten) return 'Wareneinsatz fehlt.';
  if (tafel.leer) return 'Keine Verkäufe im Zeitraum.';
  if (feld === 'renner') return 'Halten. Gut sichtbar lassen, Rezept und Preis nicht ändern.';
  if (feld === 'zugpferd') {
    // Über alle Gruppen hinweg wäre ein Betrag schief (Dip gegen Burger)
    if (gemischt) return 'Preis prüfen oder Rezept günstiger machen. Genauer in der eigenen Gruppe.';
    const fehlt = Math.max(0.1, Math.ceil((schnittDb - a.db) * (1 + (a.satz || SATZ_SPEISE) / 100) * 10 - 1e-9) / 10);
    return 'Preis prüfen: rund ' + fmtEur(fehlt) + ' mehr bringt den Schnitt der Gruppe. Oder Rezept günstiger machen.';
  }
  if (feld === 'raetsel') return 'Besser platzieren: oben auf der Karte, im Menü vorschlagen oder am Truck empfehlen.';
  if (feld === 'ladenhueter') return 'Von der Karte nehmen? Sonst Rezept günstiger machen und neu vorstellen.';
  return 'Zu wenig Daten für eine Einordnung.';
}

/**
 * Auswertung über einen Zeitraum.
 * @param {object} sk      speisekarte.js
 * @param {object} summe   Ergebnis von tageswerte.summiere()
 * @param {object} kosten  Store kosten/artikel
 */
function auswerten(sk, summe, kosten) {
  const s = summe || { artikel: {}, haupt: {} };
  const artikel = artikelListe(sk).map((a) => {
    const [qty, brutto] = (s.artikel && s.artikel[a.id]) || [0, 0];
    const nettoKarte = netto(a.preis, a.satz);
    const nettoUmsatz = netto(brutto, a.satz);
    const nettoSchnitt = qty > 0 ? nettoUmsatz / qty : nettoKarte;
    const cost = kostenWert(kosten, a.id);
    const db = cost === null ? null : nettoSchnitt - cost;
    return {
      ...a,
      qty,
      haupt: (s.haupt && s.haupt[a.id]) || 0,
      umsatz: r2(brutto),
      nettoUmsatz: r2(nettoUmsatz),
      nettoKarte: r2(nettoKarte),
      nettoSchnitt: r2(nettoSchnitt),
      cost: cost === null ? null : r2(cost),
      db: db === null ? null : r2(db),
      quote: cost === null || !(nettoSchnitt > 0) ? null : r3(cost / nettoSchnitt),
      updatedAt: (kosten && kosten[a.id] && kosten[a.id].updatedAt) || null,
    };
  });
  const tafeln = {};
  for (const g of GRUPPEN.concat([{ id: 'alle' }])) {
    const liste = artikel.filter((a) => !a.extra && (g.id === 'alle' || a.cat === g.id));
    tafeln[g.id] = vierFelder(liste, { gemischt: g.id === 'alle' });
  }
  return { artikel, tafeln };
}

/**
 * Beliebte Artikel ohne Wareneinsatz (für den Wochenbericht): je Gruppe nach
 * der Beliebtheits-Regel der Tafel, sortiert nach Stück.
 */
function beliebtOhneKosten(auswertung) {
  const out = [];
  for (const g of GRUPPEN) {
    const tafel = auswertung.tafeln[g.id];
    if (!tafel || tafel.leer) continue;
    for (const a of auswertung.artikel) {
      if (a.cat !== g.id || a.cost !== null) continue;
      const p = tafel.punkte[a.id];
      if (p && p.beliebt) out.push({ id: a.id, name: a.name, qty: a.qty });
    }
  }
  return out.sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name, 'de'));
}

module.exports = {
  auswerten, vierFelder, netto, satzFuer, artikelListe, erlaubteIds, kostenWert, beliebtOhneKosten,
  GRUPPEN, FELDER, SATZ_SPEISE, SATZ_GETRAENK, BELIEBT_FAKTOR,
};
