# Google-Rezensionen automatisch (Business-Schnittstelle)

Stand: 07.11.2026

## Worum es geht

Die Website holt Sterne, Anzahl und Rezensionen bisher über die Places API. Die liefert nur 5 Rezensionen, die Google als „relevant“ auswählt, nie die neuesten. Neue Rezensionen mussten wir deshalb von Hand nachtragen.

Die Business-Schnittstelle (Google Business Profile API) liefert alle Rezensionen, die neuesten zuerst. Ist sie verbunden, holt die Website jeden Morgen um 05:20 Uhr die 30 neuesten, übersetzt neue Texte einmal in die 8 Sprachen und zeigt sie im Karussell. Von Hand nachtragen fällt dann weg.

Bis alles verbunden ist, läuft die Seite wie bisher über die Places API weiter.

## Wer was macht

Google lässt die Schnittstelle nur für ein Konto zu, das **Inhaber oder Manager** des Unternehmensprofils ist. Inhaber ist Kubi.

Am einfachsten macht Kubi dich einmal zum Manager, danach erledigst du alles allein:

1. Kubi öffnet sein Unternehmensprofil (Google-Suche „Mein Unternehmen“ oder Google Maps → Profilbild → Ihr Unternehmensprofil).
2. ⋮ → **Unternehmensprofil-Einstellungen** → **Personen und Zugriff** → **Hinzufügen**.
3. Deine Adresse eintragen, Rolle **Manager**, einladen. Du nimmst die Einladung per Mail an.

Ohne diesen Schritt muss Kubi die Schritte 2 und 6 mit seinem eigenen Konto machen.

## 1. Cloud-Projekt wählen

Für den Antrag brauchst du ein Google-Cloud-Projekt und dessen **Projektnummer** (Cloud Console → Dashboard → Karte „Projektinformationen“).

Nimm am besten ein eigenes Projekt in deinem Konto, zum Beispiel „grillnchill-website“. Die Business-Schnittstelle kostet nichts und braucht kein Abrechnungskonto.

## 2. Zugang bei Google beantragen

Das dauert am längsten, deshalb zuerst.

- Formular: <https://support.google.com/business/contact/api_default>
- Im Auswahlfeld **Application for Basic API Access** wählen.
- E-Mail: die Adresse, die Inhaber oder Manager des Profils ist.
- Unternehmen: Grill'n Chill, Website `https://grillnchill-foodtruck.de`
- Projektnummer aus Schritt 1.
- Anwendungsfall, zum Beispiel:

  > We run our own website for our food truck Grill'n Chill in Bielefeld (grillnchill-foodtruck.de). We want to show our latest Google reviews on that website. Once a day the site reads the reviews of our single location (accounts.locations.reviews.list). No other data, no third-party clients, no resale.

Google antwortet per Mail. Bis zur Freigabe steht das Kontingent der Schnittstellen auf 0. Voraussetzungen laut Google: Das Profil ist verifiziert und seit mindestens 60 Tagen aktiv, und das Unternehmen hat eine Website. Beides trifft zu.

## 3. Schnittstellen aktivieren

Cloud Console → **APIs und Dienste** → **Bibliothek**, im Projekt aus Schritt 1:

- My Business Account Management API
- My Business Business Information API
- Google My Business API (erscheint erst nach der Freigabe)

## 4. Zustimmungsbildschirm einrichten

Cloud Console → **Google Auth Platform** (früher „OAuth-Zustimmungsbildschirm“):

- **Branding:** App-Name „Grill'n Chill Website“, Support-Mail, Startseite `https://grillnchill-foodtruck.de`, autorisierte Domain `grillnchill-foodtruck.de`.
- **Zielgruppe:** Extern.
- **Wichtig:** Status auf **In Produktion** stellen („App veröffentlichen“). Im Testmodus beendet Google die Verbindung nach 7 Tagen.

Eine Prüfung der App durch Google braucht es nicht. Bei der Anmeldung zeigt Google dann den Hinweis „Google hat diese App nicht überprüft“. Für die eigene Website ist das in Ordnung: **Erweitert** → **Weiter zu grillnchill-foodtruck.de**.

## 5. OAuth-Client anlegen

Google Auth Platform → **Clients** → **Client erstellen**:

- Typ: **Webanwendung**
- Name: Grill'n Chill Website
- Autorisierte Weiterleitungs-URI, genau so:

  ```
  https://grillnchill-foodtruck.de/google-profil/rueckruf
  ```

Danach zeigt Google die **Client-ID** und den **Clientschlüssel**.

## 6. In Netlify eintragen

Netlify → die Grill'n-Chill-Site → **Site configuration** → **Environment variables**:

| Name | Wert |
| --- | --- |
| `GOOGLE_PROFIL_CLIENT_ID` | Client-ID aus Schritt 5 |
| `GOOGLE_PROFIL_CLIENT_SECRET` | Clientschlüssel aus Schritt 5, als geheim markieren |

Danach einen neuen Deploy auslösen (Deploys → Trigger deploy). Ohne neuen Deploy sehen die Functions die Werte nicht.

Den Clientschlüssel nie ins Repo, in Chats oder Mails kopieren.

## 7. Verbinden

1. Admin-Tool **im Browser** öffnen (Safari oder Chrome, nicht in der App, dort lässt Google keine Anmeldung zu).
2. Reiter **Feedback** → Abschnitt **Google-Rezensionen automatisch** → **Mit Google verbinden**.
3. Mit dem Inhaber- oder Manager-Konto anmelden und den Zugriff erlauben.

Danach zeigt der Abschnitt einen dieser Zustände:

| Anzeige | Bedeutung |
| --- | --- |
| Wartet auf Google | Verbunden, die Freigabe aus Schritt 2 fehlt noch. Läuft von selbst los, sobald sie da ist. Telegram meldet sich. |
| API fehlt | Eine Schnittstelle aus Schritt 3 ist nicht aktiviert. Der Name steht dabei. |
| Falsches Konto | Das Konto verwaltet das Profil nicht. Trennen und mit dem richtigen Konto verbinden. |
| Neu verbinden | Google hat die Verbindung beendet (Passwort geändert, Zugriff entzogen oder App noch im Testmodus). |
| Läuft | Alles gut. Zeigt den letzten Abruf, Anzahl, Sterne und die neueste Rezension. |

## 8. Übersetzung (optional)

Neue Rezensionen übersetzt die Website über die **Cloud Translation API**, mit demselben Schlüssel wie die Places API (`GOOGLE_PLACES_API_KEY`, Kubis Projekt mit Abrechnung). Dafür in diesem Projekt:

- **Cloud Translation API** aktivieren.
- Ist der Schlüssel auf bestimmte APIs beschränkt, die Cloud Translation API dort ergänzen.

Google berechnet die ersten 500.000 Zeichen im Monat nicht. Unsere Rezensionen brauchen davon einen kleinen Bruchteil. Fehlt die Übersetzung, zeigt jede Sprache den Originaltext, und der Admin-Abschnitt weist darauf hin.

## Technik

- `netlify/functions/lib/google-profil.js`: Anmeldung, Abruf, Übersetzung, Status
- `netlify/functions/google-profil.js`: Admin-Aktionen und Rücksprung von Google
- `netlify/functions/google-reviews-daily.js`: holt das Profil vor den Places-Abrufen
- `netlify/functions/lib/google-bewertungen.js`: mischt die Profil-Rezensionen in jede Sprache
- Der Refresh-Token liegt verschlüsselt im Blob `google-reviews/profil:verbindung`. Der Schlüssel stammt aus `GOOGLE_PROFIL_CLIENT_SECRET`. Wer das Secret wechselt, muss neu verbinden.
- Test: `node werkzeug/google-profil-test.js`
