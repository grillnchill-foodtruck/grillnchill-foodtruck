# Grill'n Chill Logo als Vektordatei

Das Logo gab es bisher nur als Rasterbild. Die beste Vorlage hat 1024 px mit einem Logo-Kreis von 796 px (JPEG). Bei 10 cm Druckbreite sind das rund 200 dpi, für Planen, Folie oder Gravur reicht das nicht. Die Dateien hier sind Vektoren und lassen sich ohne Verlust beliebig groß ausgeben.

## Dateien

| Datei | Zweck |
|---|---|
| `grillnchill-logo.svg` / `.pdf` | Farbe. Druck, Bildschirm, Aufkleber, Plane |
| `grillnchill-logo-schwarz.svg` / `.pdf` | Einfarbig schwarz. Stempel, Gravur, Folie auf hellem Grund |
| `grillnchill-logo-weiss.svg` / `.pdf` | Einfarbig weiß. Folie und Druck auf dunklem Grund (auf weißem Papier unsichtbar, das ist richtig) |

Alle Dateien enthalten nur Flächen, keine Konturen und keine eingebetteten Bilder. Die einfarbigen Fassungen sind eine einzige Fläche mit Aussparungen, so wie Folienplotter und Stempelhersteller sie brauchen. Die PDFs haben eine Seite von 100 × 100 mm und sind frei skalierbar.

## Farben

RGB-Werte sind gemessen bzw. aus der Vorlage übernommen. Die CMYK-Werte sind eine Näherung für gestrichenes Papier. Die Druckerei soll aus RGB mit ihrem eigenen Profil umrechnen und vorher einen Proof zeigen.

| Farbe | Hex | RGB | CMYK (Näherung) |
|---|---|---|---|
| Creme (Außenring, Schrift) | `#F1E6C6` | 241 230 198 | 3 7 25 0 |
| Nachtblau (Band, Truck, Schriftkontur) | `#08131D` | 8 19 29 | 90 70 50 80 |
| Orange, Verlauf oben | `#CE4A08` | 206 74 8 | 5 80 100 5 |
| Flammenrot | `#B02E0A` | 176 46 10 | 15 90 100 10 |
| Orange (Flammen, Burger) | `#DC5A0E` | 220 90 14 | 0 75 100 0 |
| Hellorange (Brötchen) | `#EC7E26` | 236 126 38 | 0 60 90 0 |
| Rauch | `#E86F16` | 232 111 22 | 0 65 95 0 |
| Patty | `#68261A` | 104 38 26 | 30 85 85 50 |
| Windschutzscheibe | `#2E3A44` | 46 58 68 | 75 60 45 45 |

Der Hintergrund im Kreis ist ein Verlauf von `#CE4A08` (oben) nach `#08131D` (ab der Burger-Oberkante). Die Website nutzt leicht andere Töne (Creme `#F5E9D0`, Orange `#E85A24`). Für das Logo gelten die Werte oben.

## Größe und Abstand

- Farbe: im Druck ab 25 mm Durchmesser, am Bildschirm ab 64 px. Darunter das Logo nicht verwenden, der Schriftzug wird zu klein.
- Einfarbig, Stempel und Gravur: ab 25 mm.
- Einfarbig, Folienschnitt: ab 60 mm. Dort ist die äußere Linie 0,5 mm breit. Sesamkörner und Lichtkanten am Truck erreichen 0,5 mm erst bei etwa 130 mm. Für kleinere Folien diese Feinteile vom Grafiker entfernen lassen.
- Schutzzone: rundum mindestens 10 % des Durchmessers frei lassen.

## Schrift

Der Schriftzug ist mit Bebas Neue gesetzt (SIL Open Font License 1.1, frei auch für Logos), je Buchstabe auf die Breite des Originals gezogen und verstärkt, dann in Flächen umgewandelt. Eine Schriftdatei braucht man zum Öffnen nicht.

## Wie nah am Original

Ringe, Farben, Aufteilung und Größenverhältnisse stimmen. Gemessen im Kreis, deckungsgleich übereinandergelegt: mittlerer Farbabstand ΔE 9, Median 3,6. Bei der Hälfte der Fläche liegt der Abstand unter 3,6, das fällt nebeneinander kaum auf. Drei von vier Pixeln liegen unter ΔE 10.

Sichtbare Unterschiede:

- Schrift: Das Original nutzt eine KI-gezeichnete Schrift mit leicht ausgestellten Enden. Bebas Neue ist gerader und etwas gleichmäßiger. Wer es genauer will, lässt einen Grafiker eine passende lizenzierte Schrift wählen oder die Buchstaben nachzeichnen.
- Truck: Silhouette und Windschutzscheibe sind nachgezeichnet. Die feinen Lichtkanten und orangen Spiegelungen sind im Original nur 2 bis 3 Pixel breit. Sie sind geglättet, wirken aber in großen Formaten etwas weich. Hier lohnt sich Nacharbeit am meisten.
- Rauch: als wenige ruhige Flächen statt der feinen Schwaden im Original.
- Burger und Flammen: nachgezeichnet, in vier Tönen statt der Verläufe im Original. In der einfarbigen Fassung ist die Mittellage (Käse, Patty) zerklüftet, ein Grafiker sollte sie vereinfachen.
- Einfarbig: Die äußere Linie ist bewusst kräftiger als im Farblogo, damit sie beim Folienschnitt hält. Der Truck endet unter der Schrift, damit Brötchen und Truck nicht verschmelzen.

Für eine endgültige Druckvorlage (z. B. Truckbeschriftung) einmal einem Grafiker geben: Lichtkanten am Truck, Mittellage des Burgers, Schriftwahl.
