# Unterschrift bei der Online-Annahme von Catering-Angeboten

Stand: 26.11.2026 · Status: von Pasquale freigegeben
Seite: `grillnchill-foodtruck.de/angebot` (angebot.html), Function `angebot.js`, `lib/catering-angebot.js`

## Ziel

Nimmt ein Kunde ein Catering-Angebot online an, unterschreibt er im Feld auf der Angebotsseite. Das Datum ist immer der heutige Tag. Unterschrift, Name, Zeitpunkt und eine Prüfsumme über den Angebotsinhalt belegen, wer welche Fassung wann angenommen hat. Rechtlich ist das eine einfache elektronische Unterschrift. Ein Catering-Vertrag braucht keine Schriftform, die Unterschrift dient als Beweis.

Bewusst nicht: Signaturdienst (Yousign, Skribble, DocuSign), qualifizierte Signatur, Unterschrift bei telefonischer Annahme von Hand.

## Ablauf für den Kunden

1. Annahme-Karte wie heute: Rechnungsadresse, dann neu das Feld „Unterschrift“, dann der AGB-Haken und „Angebot annehmen“.
2. Der Kunde unterschreibt mit Finger oder Maus. Daneben: „Löschen“, „Lieber Namen tippen“ und „Datum: 27.11.2026“ (heute, nicht änderbar).
3. „Lieber Namen tippen“ ersetzt das Feld durch ein Textfeld. Der getippte Name zählt als Unterschrift. Das ist die Alternative für Tastatur und Screenreader.
4. Ohne Unterschrift kein Annehmen: Hinweis direkt am Feld, Fokus aufs Feld.
5. Nach der Annahme zeigt die Seite „Unterschrieben am 27.11.2026 um 14:32 von Ayşe Yılmaz.“ und die Unterschrift.

## Daten

- Linienzug statt Bild: `striche: [[x0, y0, x1, y1, …], …]`, ganze Zahlen in einem Feld von 1000 × 300. Höchstens 60 Striche und 1200 Punkte. Mindestens 8 Punkte und eine Ausdehnung von 60 × 30, damit ein Punkt keine Unterschrift ist.
- Oder getippt: `getippt: 'Name'`, 2 bis 80 Zeichen. Genau eines von beiden.
- Kein Tempo, kein Druck: Die Daten sind keine biometrischen Daten.
- Gespeichert in `a.annahme.unterschrift = { striche | getippt, name, am, angebotHash }`. `name` kommt aus der Rechnungsadresse, `am` vom Server.
- `angebotHash`: SHA-256 über kanonisches JSON aus Nummer, Rechnungsadresse, Eventdaten, Positionen, Summen, Anzahlung, Gültigkeit und Hinweis.

## Nach der Annahme

- Angebots-PDF: Statt „So nimmst du an“ steht der Block „Angenommen und unterschrieben“ mit Zeitpunkt (Berlin), Name, Unterschrift und gekürzter Prüfsumme.
- Bestätigungsmail an den Kunden mit diesem PDF im Anhang. Kopie mit PDF an `OWNER_EMAIL`, falls gesetzt.
- Telegram an Kubi: Zeile „Unterschrieben von …“ (mit Vermerk, wenn getippt).
- Admin (Catering, Angebot öffnen): Unterschrift, Zeitpunkt, Name, gekürzte Prüfsumme.

## Technik

- `netlify/functions/lib/unterschrift.js`: `pruefen(u)`, `angebotHash(a)`, `zeitText(iso)`, `hashKurz(hex)`, `zeichnenPdf(doc, u, x, y, w, h, { latin1 })`.
- `unterschrift.js` (Seite, für angebot.html und admin.html): Feld zum Zeichnen (Pointer Events, Mindestabstand 4 Einheiten, glatte Linien) und `svg(u)` zur Anzeige.
- `angebot.js`: Anfragegröße 16 KB statt 8 KB, `saeubern` mit `maxListe: 2400`, Prüfung der Unterschrift nach Haken und Adresse, Fehler `unterschrift_fehlt`.
- Texte in allen 8 Sprachen der Angebotsseite. AGB § 11 und Datenschutz Abschnitt 10 bekommen je einen Satz (legal-page-generator). Service-Worker-Version hochzählen.

## Tests

- `werkzeug/unterschrift-test.js`: Prüfregeln, Prüfsumme (stabil, reagiert auf Betrag), Zeittext Berlin, PDF-Zeichnung ergibt gültiges PDF.
- `werkzeug/catering-angebot-test.js`: Annahme ohne oder mit kaputter Unterschrift 400 und Angebot bleibt offen, mit Unterschrift gespeichert samt Name, Zeit, Prüfsumme; getippte Variante; Kundenansicht ohne Prüfsumme; Mail mit PDF-Anhang; Kopie an Kubi; Telegram-Zeile.
- `werkzeug/csp-test.js` nach `seiten-bauen.js`. Im Browser und im iOS-Simulator: Zeichnen mit dem Finger, Löschen, Sprache wechseln behält die Unterschrift, Tastatur-Weg.
