/* ====================================================================
   GRILL'N CHILL – Mehrsprachigkeit (i18n)
   Sprachen: Deutsch (de), English (en), Türkçe (tr), Italiano (it),
   Español (es), Português (pt), Français (fr), Nederlands (nl)
   Rechtstexte (AGB/Datenschutz/Impressum) bleiben bewusst auf Deutsch.
   ==================================================================== */

const I18N = {
  de: {
    "nav.menu": "Speisekarte", "nav.about": "Über uns", "nav.location": "Standort",
    "nav.open": "Geöffnet", "nav.opens": "Öffnet {time}", "nav.closed": "Geschlossen",
    "sig.eyebrow": "Chef-Empfehlung", "sig.desc": "Unser Smashburger mit Double Patty, geschmolzenem Käse und Special-Topping – kross gebraten auf heißem Stahl.", "sig.cta": "In den Warenkorb", "sig.note": "100 % Halal · Double Patty inklusive · frisch in ca. 15 Minuten",
    "sig2.eyebrow": "Alltime Classic", "sig2.desc": "Der Klassiker, der nie enttäuscht – Beef-Patty, geschmolzener Käse, knackiger Salat, Tomate, Zwiebel und unsere Burgersauce.", "sig2.note": "100 % Halal · auch als Veggie/Vegan · Double Patty möglich",
    "sig3.eyebrow": "Go-to Beilage", "sig3.desc": "Goldbraun, außen knusprig, innen fluffig – dazu ein Dip deiner Wahl. Passt einfach immer.", "sig3.note": "Vegan · inklusive 1 Dip nach Wahl", "fab.view": "Warenkorb ansehen", "toast.offline": "Du bist offline – Bestellen geht wieder, sobald du verbunden bist.", "toast.online": "Wieder online.", "a11y.skip": "Direkt zur Speisekarte", "a11y.close": "Schließen", "a11y.more": "Mehr", "a11y.less": "Weniger", "a11y.cart_open": "Warenkorb öffnen", "a11y.prev_review": "Vorherige Bewertung", "a11y.next_review": "Nächste Bewertung", "sig.prev": "Vorheriges Produkt", "sig.next": "Nächstes Produkt", "a11y.lang": "Sprache wählen", "a11y.menu_open": "Menü öffnen", "a11y.zones": "Lieferzonen-Info", "a11y.home": "Grilln Chill Startseite", "a11y.to_top": "Nach oben", "a11y.cookies": "Cookie-Einstellungen", "a11y.guests": "Gästezahl", "a11y.delete": "Löschen", "tab.home": "Start", "tab.menu": "Menü", "tab.catering": "Catering", "tab.location": "Standort", "tab.account": "Konto", "push.enable": "Benachrichtigungen aktivieren", "push.done": "Benachrichtigungen aktiviert.", "push.denied": "Benachrichtigungen sind im Browser blockiert.", "push.error": "Aktivierung nicht möglich – bitte später erneut versuchen.", "sig4.eyebrow": "Special der Woche", "sig4.note": "Nur für kurze Zeit",
    "nav.catering": "Catering", "nav.faq": "FAQ", "nav.cart": "Warenkorb",
    "nav.rent": "Foodtruck mieten", "nav.contact": "Kontakt", "nav.claim": "Streetfood mit Charakter",

    "hero.h1a": "Halal Burger in Bielefeld", "hero.h1b": "Streetfood mit Charakter.",
    "hero.lead": "Saftige Halal-Burger, knusprige Pommes und ehrliches Streetfood – frisch zubereitet in Bielefeld Brackwede. Bestelle direkt hier und spare 5 € mit dem Code GRILL5 (ab 20 € Bestellwert).",
    "hero.cta_order": "Jetzt bestellen", "hero.cta_catering": "Foodtruck mieten",
    "hero.reviews": "{count} Bewertungen auf Google", "hero.badge_code": "Code GRILL5", "hero.badge_discount": "5 € Rabatt",
    "promo.bar_main": "Spare 5 € mit Code", "promo.bar_sub": "(ab 20 € Bestellwert · max. 3× pro Kunde · nur online)",
    "hero.trust_halal": "100% Halal", "hero.trust_prep": "Min Zubereitung", "hero.trust_delivery": "Lieferung in Bielefeld",

    "ticker.save": "Spare 5 € mit Code GRILL5", "ticker.halal": "100% Halal",
    "ticker.fresh": "Frisch und schnell", "ticker.local": "Lokal aus Brackwede",
    "ticker.rating": "{rating} bei {count} Bewertungen", "ticker.delivery": "Lieferung im ganzen Bielefeld",

    "comparison.eyebrow": "Dein Direkt-Bestellvorteil", "comparison.h2": "Warum direkt bei uns bestellen?",
    "comparison.lead": "Lieferplattformen nehmen bis zu 30 % Provision pro Bestellung. Direkt bei uns sparst du bares Geld – und das Geld bleibt vor Ort.",
    "comparison.recommended": "★ EMPFOHLEN ★", "comparison.direct": "Direkt bei uns", "comparison.fee_lieferando": "+ 1,99 € Liefergebühr",
    "comparison.fee_direct": "+ 2,50 € Liefergebühr (Brackwede)", "comparison.fee_uber": "+ 2,49 € Liefergebühr",
    "comparison.min15": "Mindestbestellwert 15 €", "comparison.min18": "Mindestbestellwert 18 €",
    "comparison.savings": "✓ Spare 5 € mit Code GRILL5",
    "comparison.note": "Beispielrechnung Classic Cheeseburger ab 20 € Bestellwert. Mit Code GRILL5 sparst du 5 € ab 20 € Bestellwert – nur online, bis zu 3× pro Kunde.",

    "menu.eyebrow": "Unsere Speisekarte", "menu.h2": "Bestellterminal",
    "menu.lead": "Wähle deine Lieblinge, leg sie in den Warenkorb und entscheide, ob du abholen oder liefern lassen willst. Code GRILL5 für 5 € Rabatt ab 20 € Bestellwert nicht vergessen.",
    "menu.filter_all": "Alles", "menu.filter_burger": "Burger", "menu.filter_veggie": "Veggie/Vegan",
    "menu.filter_menus": "Menüs", "menu.filter_sides": "Snacks & Beilagen", "menu.filter_dips": "Dips", "menu.filter_drinks": "Getränke",
    "menu.halal_title": "100 % Halal", "menu.halal_text": "Alle unsere Burger sind halal. Wir beziehen unser Fleisch ausschließlich von zertifizierten Halal-Lieferanten.",
    "menu.veggie_title": "Veggie & Vegan", "menu.veggie_text": "Unsere Burger Classic, Cheese, Chili-Cheese und White BBQ gibt es auch als eigene Veggie/Vegan-Variante – ohne Aufpreis. Du findest sie direkt im Menü unter „Veggie/Vegan“. Alle Veggie-Burger sind gleichzeitig vegan.",
    "menu.double_title": "Double Patty", "menu.double_text": "Alle Burger können auch mit Double Patty bestellt werden – einfach im Bestellterminal auf der Karte auswählen. Aufpreis: +2,50 €. Beim Kubis Special ist das Double Patty bereits inklusive.",
    "menu.allergen_title": "Allergene & Zusatzstoffe",
    "menu.allergen1": "Glutenhaltiges Getreide", "menu.allergen2": "Krebstiere", "menu.allergen3": "Eier", "menu.allergen4": "Fische", "menu.allergen5": "Erdnüsse", "menu.allergen6": "Sojabohnen", "menu.allergen7": "Milch (einschl. Laktose)", "menu.allergen8": "Schalenfrüchte (Nüsse)", "menu.allergen9": "Sellerie", "menu.allergen10": "Senf", "menu.allergen11": "Sesamsamen", "menu.allergen12": "Schwefeldioxid und Sulfite", "menu.allergen13": "Lupinen", "menu.allergen14": "Weichtiere", "menu.zusatz1": "mit Farbstoff", "menu.zusatz2": "mit Konservierungsstoff", "menu.zusatz3": "mit Antioxidationsmittel", "menu.zusatz4": "mit Geschmacksverstärker", "menu.zusatz5": "geschwefelt", "menu.zusatz6": "geschwärzt", "menu.zusatz7": "gewachst", "menu.zusatz8": "mit Phosphat", "menu.zusatz9": "mit Süßungsmittel", "menu.zusatz10": "enthält eine Phenylalaninquelle", "menu.zusatz11": "koffeinhaltig", "menu.zusatz12": "chininhaltig", "menu.traces": "Kann Spuren enthalten von", "badge.additives": "Zusatzstoffe", "badge.traces_short": "Spuren", "menu.allergen_note": "Hast du eine Allergie, die nicht aufgeführt ist? Gib uns gerne im Notiz-Feld Bescheid – wir tun unser Bestes.",

    "story.eyebrow": "Unsere Story", "story.h2": "Streetfood mit Charakter aus Brackwede",
    "story.p1": "Bei Grilln Chill gibt's ehrliches Essen: Burger aus frischen Zutaten, gegrillt, sobald du bestellst. Modernes Streetfood aus Brackwede, ohne Schnickschnack.",
    "story.p2": "Hinter Grilln Chill stecken 12 Jahre Gastronomie und 6 Jahre Foodtruck. Dieses Handwerk schmeckst du in jedem Burger.",
    "story.p3": "Alle unsere Burger sind 100 % halal. Unser Fleisch kommt ausschließlich von Lieferanten mit Halal-Zertifikat.",
    "story.p4": "Iss direkt am Truck, hol ab oder lass dir liefern. Dein Essen kommt in jedem Fall frisch vom Grill.",
    "story.years": "Jahre", "story.stat1": "Gastronomie-Erfahrung", "story.stat2": "Foodtruck-Erfahrung", "story.stat3": "Bei {count} Bewertungen", "story.stat4": "Halal & frisch",
    "story.caption_role": "Inhaber & Foodtruck-Gründer",
    "status.open": "Jetzt geöffnet · bis {time} Uhr", "status.closed_today": "Geschlossen · Öffnet heute um {time}", "status.closed_tomorrow": "Geschlossen · Öffnet morgen um {time}", "status.closed_day": "Geschlossen · Öffnet {day} um {time}", "status.holiday": "Geschlossen wegen Feiertag",

    "location.eyebrow": "📍 Standort", "location.h2": "Hier findest du uns",
    "location.lead": "Unser Standort in Bielefeld Brackwede – komm vorbei oder lass dir's bequem liefern.",
    "location.hours_title": "Öffnungszeiten", "location.loading": "Wird geladen…",
    "location.mon": "Montag", "location.tue": "Dienstag", "location.wed": "Mittwoch", "location.thu": "Donnerstag",
    "location.fri": "Freitag", "location.fri_delivery": "Lieferung ab 14:30 Uhr", "location.sat": "Samstag", "location.sun": "Sonntag", "location.closed": "Ruhetag", "location.today": "Heute", "cookie.title": "🍪 Cookies & Datenschutz", "cookie.text": "Wir verwenden Cookies, um unsere Website zu betreiben und dein Erlebnis zu verbessern. Notwendige Cookies sind für den Bestellvorgang erforderlich. Optionale Cookies helfen uns, die Seite zu verbessern.", "cookie.more": "Mehr in unserer Datenschutzerklärung", "cookie.needed": "Notwendig", "cookie.needed_desc": "Bestellvorgang, Warenkorb, Sicherheit", "cookie.stats": "Statistik", "cookie.stats_desc": "Anonyme Nutzungsanalyse", "cookie.marketing": "Marketing", "cookie.marketing_desc": "Personalisierte Inhalte & Karten-Einbettung", "cookie.details": "Details", "cookie.reject": "Nur notwendige", "cookie.accept": "Alle akzeptieren",
    "location.zones_title": "🛵 Wir liefern in folgende Stadtteile",
    "location.zones_show": "Liefergebiete anzeigen", "location.zones_hide": "Liefergebiete ausblenden",

    "catering.eyebrow": "Foodtruck Catering", "catering.h2": "Wir bringen den Grill zu deiner Feier",
    "catering.lead": "Hochzeit, Firmenfeier, Geburtstag oder Sommerfest: Unser Foodtruck kommt zu dir, und wir grillen frisch vor den Augen deiner Gäste.", "catering.fun_progress": "Schritt {n} von 3", "catering.fun_step1": "Dein Event", "catering.fun_step2": "Paket", "catering.fun_step3": "Kontakt", "catering.fun_next": "Weiter", "catering.fun_back": "Zurück", "catering.fun_err": "Bitte fülle die markierten Felder aus.", "catering.f_contactpref": "Wie erreichen wir dich am besten?", "catering.f_pref_phone": "Telefon",
    "catering.feat1": "Saftige Burger, Pommes & Sides – live zubereitet",
    "catering.feat2": "Vollständig autark – wir brauchen nur Stellplatz und Steckdose",
    "catering.feat3": "Vegetarische & vegane Optionen verfügbar",
    "catering.feat4": "Ab 30 Personen – flexible Pakete bis 150 Gäste",
    "catering.feat5": "Bielefeld & ganz OWL (Gütersloh, Herford, Osnabrück, ...)",
    "catering.form_title": "Unverbindlich anfragen",
    "catp.karte_label": "Unsere Event-Karte:", "catp.karte_items": "Classic · Cheeseburger · Chili-Cheese · Crispy Chicken · Veggie Classic (100 % Gemüse-Patty, auf Wunsch vegan)", "catp.karte_note": "Kuratiert für kurze Wartezeiten – frisch gegrillt, nicht vorgehalten. Den Kubis Special gibt es exklusiv am Truck.",
    "catp.per": "pro Person", "catp.min30": "ab 30 Personen", "catp.min40": "ab 40 Personen", "catp.badge": "Beliebteste Wahl", "catp.cta": "Paket anfragen",
    "catp.p1f1": "1 Burger nach Wahl aus der Event-Karte", "catp.p1f2": "Pommes mit Dip nach Wahl", "catp.p2f1": "1 Burger nach Wahl – Double Patty inklusive",
    "catp.p3f1": "2 Stunden Burger-Flatrate aus der Event-Karte", "catp.p3f2": "Pommes inklusive – niemand geht hungrig heim", "catp.p3f3": "Double Patty optional +2,50 €",
    "catp.pausch_title": "Event-Pauschale", "catp.pausch_text": "300 € pro Einsatz (Fr, Sa & Feiertage: 450 €) – enthält Anfahrt bis 25 km, kompletten Auf- und Abbau, Equipment, Personal und bis zu 2,5 Stunden Ausgabezeit. Darüber hinaus: 1 €/km bzw. 89 € je weitere Stunde.",
    "catp.drinks_title": "Getränke", "catp.drinks_text": "Getränke bringen wir beim Catering nicht mit – darum kümmert sich der Gastgeber bzw. Auftraggeber selbst. Wir konzentrieren uns voll auf den Grill.",
    "catp.cond_title": "Buchung", "catp.cond_text": "50 % Anzahlung bei Buchung – damit ist euer Termin verbindlich reserviert. Vegetarier-/Vegan-Anteil fragen wir vorab ab. Sonntags sind wir exklusiv für Events unterwegs.",
    "catp.footnote": "Genannte Preise für Privatkunden inkl. MwSt. Firmenkunden erhalten ein Netto-Angebot. Verbindlich ist das individuelle Angebot, das du nach deiner Anfrage erhältst.",
    "catering.f_package": "Wunsch-Paket", "catering.f_pkg_open": "Noch offen – beratet mich",
    "catering.f_name": "Dein Name *", "catering.f_email": "E-Mail *", "catering.f_phone": "Telefon *",
    "catering.f_date": "Datum *", "catering.f_guests": "Gäste *", "catering.f_guests_ph": "Bitte wählen",
    "catering.f_location": "Veranstaltungsort *", "catering.f_location_ph": "z.B. Bielefeld, Sennestadt",
    "catering.f_msg": "Was sollen wir wissen?", "catering.f_msg_ph": "Anlass, besondere Wünsche, Allergien, ...",
    "catering.f_consent": "Ich bin damit einverstanden, dass meine Angaben zur Bearbeitung der Anfrage verwendet werden.",
    "catering.f_privacy": "Datenschutz", "catering.f_submit": "Anfrage senden",
    "catering.f_hint": "Wir melden uns schnellstmöglich bei dir zurück.",

    "franchise.eyebrow": "Partner werden", "franchise.h2": "Gemeinsam wachsen?",
    "franchise.lead": "Wir wachsen Schritt für Schritt – und sind offen für Kooperationen: Event-Partnerschaften, Standort-Ideen, Zusammenarbeit mit Unternehmen und Vereinen aus der Region. Erzähl uns, was dir vorschwebt.",
    "franchise.p1_t": "Bewährtes Ertragsmodell", "franchise.p1_d": "Kalkulierbare Wareneinsätze, attraktive Margen pro Burger und ein klarer Weg zur Profitabilität – ohne Lieferdienst-Provisionen.",
    "franchise.p2_t": "Schlüsselfertiges Konzept", "franchise.p2_d": "Von der Truck-Konzeption über die Speisekarte und Lieferanten bis zum Marketing und dieser Bestell-Plattform – du startest mit einem kompletten System.",
    "franchise.p3_t": "Starke, halal-zertifizierte Marke", "franchise.p3_d": "5,0★ bei über 180 Bewertungen, klare Positionierung und ein wachsender Stammkundenkreis – du übernimmst eine Marke mit Substanz.",
    "franchise.p4_t": "Persönliche Begleitung", "franchise.p4_d": "Wir teilen unser Know-how aus Konzeption und Realisation und begleiten dich beim Aufbau deines eigenen Standorts.",
    "franchise.cta_p": "Klingt nach deiner unternehmerischen Zukunft? Dann lass uns sprechen – ganz unverbindlich und vertraulich.",
    "franchise.cta_btn": "Kontakt aufnehmen",
    "franchise.cta_sub_a": "Schreib uns an", "franchise.cta_sub_b": "– wir melden uns mit allen Infos zu Investition, Standorten und Konditionen.",

    "faq.eyebrow": "FAQ", "faq.h2": "Häufig gestellte Fragen",
    "faq.q1": "Sind eure Burger halal?",
    "faq.a1": "Ja, zu 100 % – zertifiziert durch Halal Certification Germany (HCG), Zertifikat Nr. HCG00279. Das gilt für unser gesamtes Sortiment, am Truck wie bei Lieferung und Catering. Das Original-Siegel findest du an unserer Ausgabe.",
    "faq.q2": "Gibt es alle Burger auch als Double Patty?",
    "faq.a2": "Ja! Du kannst jeden Burger mit Double Patty bestellen – einfach im Bestellterminal direkt auf der Burger-Karte „Double Patty\“ auswählen. Aufpreis: 2,50 €. Beim Kubis Special ist das Double Patty bereits inklusive.",
    "faq.q3": "Wohin liefert ihr?",
    "faq.a3": "Wir liefern nach Brackwede, Senne, Sennestadt, Gadderbaum, Quelle, Ummeln, Schildesche, Jöllenbeck, Heepen, Stieghorst, Avenwedde und Isselhorst.",
    "faq.q4": "Wie funktioniert der Rabatt mit Code GRILL5?",
    "faq.a4": "Mit dem Code GRILL5 bekommst du 5 € Rabatt ab 20 € Bestellwert. Der Code ist nur online (über diese Website) einlösbar, bis zu 3× pro Kunde nutzbar und dauerhaft gültig (bis auf Widerruf). Einfach im Warenkorb-Feld eingeben und „Einlösen“ klicken.",
    "faq.q5": "Wofür sind wir bekannt?",
    "faq.a5": "Für unsere Burger: saftige Patties, frisch vom Grill, dazu knusprige Nuggets und Pommes. Auf der Karte stehen Klassiker wie der Classic Burger und eigene Kreationen wie das Kubis Special oder der Sucuk Burger.",
    "faq.q6": "Habt ihr Optionen bei Allergien?",
    "faq.a6": "Sag uns bei der Bestellung Bescheid, wenn du eine Allergie hast. Wir sagen dir genau, was in jedem Gericht steckt. Jeden Burger gibt es auch vegetarisch oder vegan, ohne Aufpreis.",
    "faq.q7": "Warum direkt bestellen statt über Lieferando?",
    "faq.a7": "Lieferando und Uber Eats nehmen pro Bestellung zwischen 14 % und 30 % Provision von uns. Wenn du direkt bestellst, fallen diese Kosten weg – das geben wir 1:1 als Rabatt an dich weiter (Code GRILL5: 5 € ab 20 € Bestellwert, nur online). Du sparst, wir behalten faire Margen, und das Geld bleibt in der Region.",
    "faq.q8": "Wie wird die Liefergebühr berechnet?",
    "faq.a8_intro": "Wir berechnen die Liefergebühr fair nach Luftlinien-Entfernung zu unserem Standort in der Gütersloher Straße 122:",
    "faq.a8_z1": "Bis 3 km (Brackwede, Quelle): 15 € Mindestbestellwert · 2,50 € Liefergebühr",
    "faq.a8_z2": "3–5 km (Gadderbaum, Senne, Ummeln): 25 € Mindestbestellwert · 3,50 € Liefergebühr",
    "faq.a8_z3": "5–13 km (Schildesche, Heepen, Stieghorst, Isselhorst, Avenwedde): 50 € Mindestbestellwert · 5,00 € Liefergebühr",
    "faq.a8_outro": "Die Berechnung erfolgt automatisch nach Eingabe deiner Lieferadresse im Checkout.",
    "faq.q9": "Wie lange dauert die Zubereitung & Lieferung?",
    "faq.a9": "Wir grillen alles frisch – plane bei Abholung etwa 15 Minuten ein. Bei Lieferung kommt natürlich die Fahrtzeit dazu (insgesamt 30–45 Minuten je nach Stadtteil). Sobald deine Bestellung eingeht, melden wir uns mit der voraussichtlichen Zeit.",
    "faq.q10": "Kann ich für ein Event vorbestellen?",
    "faq.a10": "Für kleinere Vorbestellungen (z.B. eine Familie oder ein Team) nutze einfach unser Bestellterminal und gib die gewünschte Abholzeit an. Für größere Events ab 30 Personen empfehlen wir unser Foodtruck-Catering – fülle dafür einfach das Anfrageformular aus.", "faq.q11": "Kann ich Gutscheine kaufen oder verschenken?", "faq.a11": "Ja! Unter grillnchill-foodtruck.de/gutscheine wählst du einen Betrag zwischen 10 und 200 €, zahlst sicher online – und der Gutschein-Code kommt automatisch per E-Mail. Eingelöst wird er im Gutschein-Feld des Warenkorbs, ab einem Bestellwert in Gutscheinhöhe. Gutscheine sind 3 Jahre gültig; eine Barauszahlung ist nicht möglich.", "faq.q12": "Wann hat Grilln Chill geöffnet?", "faq.a12": "Montag bis Samstag von 12:00 bis 20:30 Uhr, Sonntag ist Ruhetag. Freitags liefern wir erst ab 14:30 Uhr – Abholung geht ab 12:00 Uhr, und deine Bestellung kannst du jederzeit mit Wunschzeit vorbestellen.",

    "footer.tagline": "Streetfood mit Charakter aus Bielefeld Brackwede. Frisch gegrillt, chillig serviert.",
    "footer.col_menu": "Menü", "footer.menu_speisekarte": "Speisekarte", "footer.menu_order": "Online bestellen",
    "footer.menu_catering": "Foodtruck Catering", "footer.menu_franchise": "Partner werden", "footer.menu_location": "Standort & Zeiten",
    "footer.col_service": "Service", "footer.service_terms": "AGB", "footer.service_withdrawal": "Widerrufsbelehrung", "footer.service_cookies": "Cookies",
    "footer.col_contact": "Kontakt", "footer.rights": "Alle Rechte vorbehalten",

    "cart.title": "Dein Warenkorb", "cart.empty": "Dein Warenkorb ist leer", "cart.empty_hint": "Füge etwas Leckeres aus der Speisekarte hinzu!",
    "cart.repeat_last": "Letzte Bestellung wiederholen", "loyalty.title": "Stempelkarte", "loyalty.line": "Treuebonus", "loyalty.hint": "Noch {n} bis zu {amount} Treuebonus.", "loyalty.redeem": "Treuebonus einlösen (−{amount})", "loyalty.applied": "Treuebonus angewendet (−{amount})", "loyalty.reward_min": "Treuebonus {amount} bereit – ab {min} Bestellwert einlösbar.",
    "cart.upsell_title": "Fehlt noch etwas?", "cart.upsell_min": "Fast geschafft – noch {rest} bis zum Mindestbestellwert", "cart.upsell_add": "hinzufügen",
    "cart.edit": "Bearbeiten",
    "menu.tag_meal": "SPAR-MENÜ", "menu.meal_suffix": "Menü", "menu.meal_desc": "Beilage + Getränk + Dip nach Wahl",
    "badge.halal": "Halal", "badge.veggie": "Veggie / Vegan möglich", "badge.allergens": "Allergene", "menu.single": "Single", "menu.double": "Double Patty",
    "cart.subtotal": "Zwischensumme", "cart.how": "Wie möchtest du bestellen?", "cart.total": "Gesamt", "cart.total_nodelivery": "Gesamt (ohne Lieferung)",
    "cart.checkout": "Weiter zur Kasse →", "cart.pickup": "Abholung", "cart.delivery": "Lieferung",
    "grp.entry": "Gruppenlink erstellen", "grp.entry_title": "Team-Bestellung fürs Büro oder die Familie", "grp.entry_sub": "Einer teilt den Link, alle wählen selbst – eine Lieferung, eine Rechnung.", "grp.entry_host": "Deine Gruppenbestellung öffnen", "grp.entry_join": "Du bestellst mit bei: {host}", "grp.title": "Gruppenbestellung", "grp.intro": "Für Büro, Familie oder Verein: Erstell einen Link, alle wählen selbst ihre Burger – und du schließt alles in einer Bestellung mit einer Lieferung ab.", "grp.host_label": "Name der Gruppe", "grp.host_ph": "z. B. Büro Meyer / Mittagsrunde", "grp.create": "Gruppenlink erstellen", "grp.host_intro": "Teile den Link mit deinem Team ({host}). Jede Person wählt selbst – du siehst hier alles live und schließt am Ende gesammelt ab.", "grp.copy": "Kopieren", "grp.whatsapp": "Link per WhatsApp teilen", "grp.list_title": "Bestellungen ({n})", "grp.refresh": "Aktualisieren", "grp.empty": "Noch keine Beiträge – sobald jemand über den Link bestellt, erscheint es hier.", "grp.sum": "Zwischensumme", "grp.import": "Alle übernehmen & zur Kasse", "grp.end": "Gruppe verwerfen", "grp.end_confirm": "Gruppenbestellung wirklich verwerfen? Der Link wird ungültig für dich.", "grp.share_text": "Wir bestellen zusammen bei Grilln Chill ({host}) – wähl hier deine Burger:", "grp.join_intro": "Du bestellst mit bei „{host}“. So geht's:", "grp.join_s1": "Wähle deine Burger & Beilagen ganz normal aus der Karte.", "grp.join_s2": "Tippe im Warenkorb auf „An die Gruppe senden“.", "grp.join_s3": "Fertig – bezahlt und geliefert wird gesammelt über den Gastgeber.", "grp.join_go": "Los geht's – zur Speisekarte", "grp.name_prompt": "Dein Name für die Gruppenbestellung:", "grp.sent_title": "Drin!", "grp.sent_text": "Deine Auswahl ist bei „{host}“ angekommen. Der Gastgeber schließt die Bestellung gesammelt ab.", "grp.sent_ok": "Alles klar", "grp.sent_again": "Noch etwas vergessen? Wähle einfach weiter und sende erneut – deine Auswahl wird dann ersetzt.", "acc.nav": "Mein Konto", "acc.title": "Mein Konto", "acc.intro": "Melde dich mit deiner E-Mail-Adresse an – wir senden dir einen 6-stelligen Code, kein Passwort nötig. Du siehst deine Stempelkarte und gespeicherte Adressen auf jedem Gerät.", "acc.send_code": "Code senden", "acc.code_sent": "Wir haben einen 6-stelligen Code an {email} gesendet (10 Minuten gültig). Schau auch im Spam-Ordner nach.", "acc.login_btn": "Anmelden", "acc.back": "Andere E-Mail-Adresse verwenden", "acc.privacy_hint": "Dein Konto ist freiwillig. Gespeichert werden nur E-Mail, Name, Telefon und deine Adressen – löschbar jederzeit auf Anfrage.", "acc.settings": "Einstellungen", "acc.settings_app": "App-Einstellungen", "acc.set_lang": "Sprache", "acc.set_push": "Benachrichtigungen", "acc.set_push_na": "Auf diesem Gerät nicht verfügbar oder im Browser blockiert.", "acc.set_pay": "Zahlungsarten", "acc.set_pay_info": "Bezahlt wird pro Bestellung sicher über SumUp – Karte, Apple Pay oder Google Pay – oder bar/EC bei Abholung. Deine Kartendaten werden nicht auf der Website gespeichert.", "acc.too_soon": "Der Code wurde gerade erst gesendet – bitte kurz warten.", "acc.wrong_code": "Der Code stimmt nicht – bitte prüfen.", "acc.code_expired": "Der Code ist abgelaufen – bitte neu anfordern.", "acc.error": "Das hat nicht geklappt – bitte erneut versuchen.", "acc.hello": "Hey {name}!", "acc.loyalty_sync": "Deine Stempelkarte zählt automatisch bei jeder Bestellung mit dieser E-Mail-Adresse – auf allen Geräten.", "acc.reward_ready": "{n}× {amount} Treuebonus verfügbar – löse ihn im Warenkorb ein!", "acc.addresses": "Gespeicherte Adressen", "acc.no_addresses": "Noch keine Adresse gespeichert – nach deiner nächsten Lieferbestellung merken wir sie uns automatisch.", "acc.add_address": "+ Adresse hinzufügen", "so.name_ph": "Name, z. B. „Donnerstag Büro\"", "so.src_cart": "Aktueller Warenkorb ({n} Artikel)", "so.cancel": "Abbrechen", "so.title": "Dauerbestellung", "so.intro": "Lege deine gewohnte Bestellung als Dauerbestellung an. Wir bestellen nichts von allein – du bekommst nur eine Erinnerung, wenn du sie einschaltest.", "so.empty": "Noch keine Dauerbestellung.", "so.add": "Neue Dauerbestellung", "so.need_cart": "Leg zuerst etwas in den Warenkorb – daraus wird die Reihe.", "so.from_cart": "Übernimmt die Artikel, die gerade im Warenkorb liegen.", "so.save": "Bestellung anlegen", "so.saved": "Angelegt", "so.items": "Artikel", "so.paused": "pausiert", "so.next": "nächste {when}", "so.order_now": "Jetzt bestellen", "so.pause": "Pausieren", "so.resume": "Fortsetzen", "so.remind_label": "Erinnerung am Vorabend", "so.remind_optin": "Erinnerung am Vorabend per E-Mail (kannst du jederzeit abschalten)", "so.remind_on": "Erinnerungen eingeschaltet", "so.remind_off": "Erinnerungen abgeschaltet", "so.delete_confirm": "Dauerbestellung wirklich löschen?", "so.items_gone": "Die Artikel gibt es leider nicht mehr.", "so.day_so": "So", "so.day_mo": "Mo", "so.day_di": "Di", "so.day_mi": "Mi", "so.day_do": "Do", "so.day_fr": "Fr", "so.day_sa": "Sa", "acc.birthday_once": "Der Geburtstag lässt sich noch einmal ändern – danach ist er fest. Am Truck können wir ihn für dich korrigieren.", "acc.birthday_locked": "Geburtstag gespeichert. Änderungen sind nicht mehr möglich – am Truck korrigieren wir ihn gern für dich.", "acc.adr_home": "Zuhause", "acc.adr_work": "Arbeit", "acc.adr_suggest": "Vorschläge:", "acc.adr_rename": "Umbenennen", "acc.adr_save_name": "Name speichern", "acc.adr_cancel": "Abbrechen", "acc.adr_name_needed": "Bitte gib der Adresse einen Namen.", "acc.adr_label_ph": "Bezeichnung (z. B. Zuhause, Arbeit)", "acc.adr_incomplete": "Bitte mindestens Straße und PLZ angeben.", "acc.adr_default_label": "Zuhause", "acc.save": "Speichern", "acc.save_address": "Adresse speichern", "map.consent_text": "Gütersloher Str. 122, 33649 Bielefeld. Mit dem Laden der Karte werden Daten an Google übertragen.", "map.load_btn": "Karte laden", "map.open_ext": "In Google Maps öffnen", "acc.history": "Letzte Bestellungen", "acc.reorder": "Nochmal bestellen", "acc.reorder_gone": "Diese Artikel sind aktuell nicht verfügbar.", "acc.no_details": "Details zu dieser älteren Bestellung liegen nicht mehr vor.", "acc.birthday_ph": "Geburtstag (TT.MM.)", "acc.birthday_hint": "Am Geburtstag gibt es 5 € Bonus auf deine Stempelkarte – automatisch.", "acc.ref_title": "Freunde werben, Burger kassieren", "acc.qr_title": "Deine Kundenkarte", "acc.qr_text": "Am Truck vorzeigen: Wir scannen den Code, schreiben deinen Einkauf gut und lösen Boni direkt ein.", "acc.qr_zoom": "Tippen zum Vergrößern", "acc.level": "Level", "ui.close": "Schließen", "acc.wallet_google": "Zu Google Wallet", "acc.wallet_apple": "Zu Apple Wallet", "acc.ref_text": "Teile deinen Code: Deine Freunde sparen 5 € auf ihre erste Bestellung (ab 15 €) – und du bekommst 5 € auf deine Stempelkarte, sobald sie bestellt haben.", "acc.ref_share": "Teilen", "acc.ref_copied": "Empfehlung kopiert – einfach einfügen und abschicken!", "acc.ref_share_text": "5 € geschenkt bei Grill'n Chill! Bestell mit meinem Code {code} online und spar bei deiner ersten Bestellung:", "acc.ref_earned": "Schon {n}× erfolgreich empfohlen – stark!", "acc.delete": "Konto löschen", "acc.delete_confirm": "Konto wirklich endgültig löschen?\n\nGespeicherte Adressen, dein Empfehlungs-Code und deine Stempelkarte (inkl. Guthaben) werden dauerhaft entfernt. Das kann nicht rückgängig gemacht werden.", "acc.saved": "Gespeichert!", "acc.logout": "Abmelden", "grp.closed": "Diese Gruppenbestellung ist bereits abgeschlossen.", "grp.error": "Das hat nicht geklappt – bitte versuch es erneut.", "grp.note_head": "Gruppenbestellung „{host}“", "grp.cart_btn": "Zur Gruppenbestellung hinzufügen", "shop.paused_title": "Bestellungen pausiert", "shop.paused_default": "Wir nehmen gerade keine Online-Bestellungen an. Bitte schau später wieder vorbei.", "shop.paused_notice": "Wir nehmen aktuell keine Bestellungen an. Bitte versuche es später erneut.", "shop.paused_cart": "Bestellungen sind aktuell pausiert.", "shop.wait": "Aktuelle Wartezeit: ca. {min} Min.", "shop.soldout": "Ausverkauft", "shop.soldout_notice": "Dieser Artikel ist leider ausverkauft.", "shop.soldout_cart": "Ein Artikel in deinem Warenkorb ist ausverkauft. Bitte entferne ihn, um fortzufahren.",
    "cart.min_delivery": "Mindestbestellwert für Lieferung", "cart.add_more": "hinzufügen", "cart.test_mode": "🔧 Test-Modus",
    "cart.remove": "Entfernen", "cart.removed": "Entfernt", "cart.undo": "Rückgängig", "cart.swipe_hint": "Zum Entfernen nach links wischen", "cart.promo_placeholder": "Promo-Code (z.B. GRILL5)", "cart.promo_redeem": "Einlösen", "cart.promo_invalid": "Code ungültig",
    "checkout.pay_cash": "Bei Lieferung / Abholung bezahlen", "checkout.submit_cash": "Bestellung aufgeben", "checkout.submit_online": "Jetzt online bezahlen",
    "checkout.hint_cash": "Wir senden dir eine Bestätigung per E-Mail. Bezahlung bei Lieferung/Abholung.", "checkout.hint_online": "Du wirst sicher zu SumUp weitergeleitet. Bezahlung mit Karte, Apple Pay oder Google Pay.",
    "co.tab_pickup": "Abholen", "co.tab_delivery": "Liefern", "co.discount": "Rabatt", "co.delivery_fee": "Liefergebühr", "co.total_nodelivery": "Gesamt (ohne Lieferung)",
    "co.submit_error": "Da ist leider etwas schiefgelaufen. Bitte versuch es erneut oder ruf uns kurz an.", "co.need_fields": "Bitte füll die markierten Felder noch aus.", "co.need_agb": "Bitte bestätige noch die AGB und die Datenschutzerklärung.", "co.need_address": "Bitte gib zuerst deine Lieferadresse ein – erst dann steht die Liefergebühr fest.", "co.step1": "Warenkorb", "co.step2": "Optionen", "co.step3": "Deine Daten", "co.step_aria": "Schritt {n} von 3", "co.title_options": "Optionen", "a11y.back": "Zurück", "grp.discard": "Gruppe verwerfen", "grp.discard_confirm": "Gruppenbestellung wirklich verwerfen? Bereits abgegebene Bestellungen der Gruppe gehen dabei verloren.",
    "co.min_warn": "Mindestbestellwert für Lieferung: {min} · noch {rest} hinzufügen", "co.title_details": "Deine Daten", "co.back_cart": "← Zurück zum Warenkorb",
    "co.promo_note": "Hinweis: Code {code} ist nur online (über diese Website) einlösbar und gültig bis 20.07.2026.",
    "co.name": "Name *", "co.name_ph": "Dein Name", "co.phone": "Telefon *", "co.company": "Firma (optional)", "co.company_ph": "Firmenname für die Rechnung", "co.company_note": "Trage eine Firma ein, wenn du eine Rechnung brauchst.", "co.inv_title": "Rechnungsadresse", "co.inv_note": "Die Rechnung schicken wir dir automatisch per E-Mail.", "co.phone_ph": "0521 12345678", "co.email": "E-Mail *", "co.email_ph": "dein@email.de",
    "co.email_hint": "Deine Bestellbestätigung und alle Updates schicken wir dir per E-Mail.",
    "co.street": "Straße & Hausnummer *", "co.street_ph": "Musterstraße 12", "co.zip": "PLZ *", "co.city": "Ort *",
    "co.pickup_time": "Abholzeit *", "co.pt_asap": "So schnell wie möglich (ca. 15 Min)", "co.pt_30": "In 30 Minuten", "co.pt_45": "In 45 Minuten", "co.pt_60": "In 1 Stunde", "co.pt_90": "In 1,5 Stunden",
    "co.today": "heute", "co.tomorrow": "morgen", "co.preorder_when": "{day} ab {time} Uhr", "co.preorder_slot": "Vorbestellung", "co.preorder_banner": "Wir haben gerade <strong>geschlossen</strong>. Deine Bestellung nehmen wir als Vorbestellung für {when} auf.", "co.delivery_cutoff": "Lieferung heute nicht mehr möglich (nur bis 1 Std. vor Ladenschluss). Abholung ist weiterhin möglich.", "co.delivery_from": "Freitags liefern wir <strong>ab {time} Uhr</strong>. Bestell jetzt, wir planen deine Lieferung für {time} Uhr ein. Abholung geht sofort.",
    "co.note": "Notiz (optional)", "co.note_ph": "z.B. Allergien, Klingel, ohne Zwiebel ...",
    "co.pay_title": "Bezahlung *", "co.pay_cash_title": "Bar / EC vor Ort", "co.pay_online_title": "Online bezahlen", "co.pay_online_sub": "Karte · Apple Pay · Google Pay · sicher via SumUp", "co.recommended": "EMPFOHLEN",
    "co.tip_title": "Trinkgeld fürs Team (optional)", "co.tip_none": "Kein", "co.tip_hint": "Trinkgeld nur bei Online-Zahlung. 100 % gehen ans Team. 💛", "co.tip_label": "Trinkgeld",
    "co.agb_a": "Ich akzeptiere die", "co.agb_terms": "AGB", "co.agb_and": "und", "co.agb_privacy": "Datenschutzerklärung", 
    "co.zone_hint": "<strong>Zone 1 (bis 3 km)</strong>: ab 15\u00a0\u20ac \u00b7 <strong>Zone 2 (3\u20135 km)</strong>: ab 25\u00a0\u20ac<br><strong>Zone 3 (5\u201313 km)</strong>: ab 50\u00a0\u20ac",
    "co.fee_check_title": "Liefergebühr & Zone prüfen", "co.fee_check_carry": "Diese Adresse wird automatisch in die Bestellung übernommen – du musst sie nicht erneut eingeben.",
    "geo.use": "Meinen Standort verwenden", "geo.locating": "Standort wird ermittelt …", "geo.ok": "Adresse übernommen – bitte kurz prüfen.", "geo.denied": "Standortzugriff ist für diese Seite blockiert. In Safari: „aA“ in der Adresszeile → Website-Einstellungen → Standort. Oder Adresse einfach unten eintippen.", "geo.fail": "Standort nicht gefunden – bitte Adresse manuell eingeben.",
    "zone.checking": "🔍 Adresse wird geprüft …", "zone.notfound": "⚠️ Adresse konnte nicht gefunden werden. Bitte prüfen.",
    "zone.outside": "❌ Adresse außerhalb unseres Liefergebiets ({km} km). Maximale Entfernung: {max} km. Bitte hol deine Bestellung ab oder kontaktiere uns für Catering.",
    "zone.min_fee": "Mindestbestellwert: {min} · Liefergebühr: {fee}",
    "co.creating_payment": "Erstelle Zahlungsseite ...", "co.sending": "Sende Bestellung ...",
    "co.pay_not_completed": "Zahlung nicht abgeschlossen. Dein Warenkorb und deine Daten sind gespeichert – du kannst es erneut versuchen oder vor Ort zahlen.", "co.pay_checking": "Dein Zahlungsstatus wird noch geprüft. Falls du bereits bezahlt hast, bekommst du die Bestätigung in wenigen Minuten per E-Mail – bitte NICHT erneut bezahlen. Beim nächsten Laden der Seite prüfen wir automatisch nach.",
    "co.min_online": "Online-Zahlung ab 1,00 € möglich. Bitte füge noch etwas hinzu oder zahle vor Ort.",
    "co.success_title": "Bestellung eingegangen!", "co.success_thanks": "Vielen Dank für deine Bestellung!", "co.status_link": "Bestellstatus live verfolgen",
    "co.success_body": "Wir haben deine Bestellung erhalten und kümmern uns sofort darum. Eine Bestätigung mit allen Details ist auf dem Weg in dein E-Mail-Postfach.",
    "co.success_pickup": "Abholbereit in ca. 15 Minuten", "co.success_delivery": "Lieferung in ca. 30–45 Minuten",
    "co.success_spam": "Keine E-Mail erhalten? Schau im Spam-Ordner nach oder ruf uns an:", "co.new_order": "Neue Bestellung",
    "co.s_order_no": "Bestellnummer", "co.s_payment": "Zahlung", "co.s_pay_online": "Online bezahlt", "co.s_pay_onsite": "Vor Ort (bar/EC)", "co.s_total": "Gesamt", "co.s_pickup_label": "Abholadresse", "co.s_delivery_label": "Deine Lieferadresse", "co.s_pickup_time": "Abholzeit", "co.s_pickup_note": "Bitte nenne deine Bestellnummer am Truck.", "co.s_maps": "In Google Maps öffnen", "co.s_check_mail": "Bitte checke jetzt dein E-Mail-Postfach – die Bestätigung & Status-Updates kommen per Mail.", "co.s_home": "Zur Startseite",
    "co.s_tip": "Trinkgeld",
    "promo.placeholder": "Promo-Code (z.B. GRILL5)", "promo.placeholder_short": "Promo-Code eingeben", "promo.expired": "Aktion beendet", "promo.redeem": "Einlösen", "promo.invalid": "Code ungültig", "promo.voucher_applied": "Gutschein {code} aktiv ({value} Rabatt)", "promo.voucher_min": "Gutschein {code}: gilt ab {min} Bestellwert", "promo.voucher_used": "Code bereits eingelöst", "promo.voucher_applied_pct": "Gutschein {code}: {pct} % Rabatt (−{value})", "promo.voucher_mode_pickup": "Gutschein {code} gilt nur bei Abholung.", "promo.voucher_mode_delivery": "Gutschein {code} gilt nur bei Lieferung.", "promo.voucher_limit": "Dieser Gutschein ist leider aufgebraucht.", "promo.voucher_used_you": "Du hast diesen Gutschein bereits eingelöst.", "promo.voucher_customer_limit": "Diesen Code kannst du maximal {max}× einlösen – dein Limit ist erreicht.", "promo.ref_self": "Netter Versuch! Der eigene Empfehlungs-Code zählt leider nicht.", "promo.ref_not_first": "Empfehlungs-Codes gelten nur für die allererste Bestellung.", "promo.voucher_not_started": "Dieser Gutschein ist noch nicht gültig.", "promo.voucher_removed": "Der Gutschein ist nicht mehr gültig und wurde entfernt – bitte prüfe den neuen Gesamtbetrag.", "promo.voucher_expired": "Code abgelaufen", "co.voucher": "Gutschein", "co.email_note": "Für Bestellbestätigung & Status-Updates. Wir informieren dich gelegentlich per E-Mail über eigene Angebote – Abmeldung jederzeit möglich.", "promo.remove": "Entfernen",
    "promo.quick_chip": "{code} anwenden", "promo.have_code": "Anderen Code eingeben",
    "promo.applied": "Code {code} angewendet", "promo.until": "Code {code} – noch {rest} bis Rabatt", "promo.savings": "💸 Du sparst {amount} mit Code {code}!",
    "delivery.info_main": "🛵 Liefergebühr wird im nächsten Schritt nach Adresseingabe automatisch berechnet",
    "delivery.info_short": "Liefergebühr wird nach Adresseingabe berechnet",
    "zone.z1": "Zone 1 – bis 3 km", "zone.z2": "Zone 2 – 3 bis 5 km", "zone.z3": "Zone 3 – 5 bis 13 km",
    "reviews.title": "Was unsere Kunden sagen", "halal.title": "100 % Halal – zertifiziert, nicht nur versprochen", "halal.text": "Unser gesamtes Sortiment ist halal-zertifiziert durch Halal Certification Germany (HCG) – Zertifikat Nr. HCG00279. Das gilt am Truck, bei jeder Lieferung und bei jedem Catering. Das Original-Siegel findest du direkt an unserer Ausgabe.", "halal.sub": "Dazu gibt es jeden Burger auch als Veggie- oder Vegan-Variante – ohne Aufpreis.", "gift.eyebrow": "Burger verschenken", "gift.h2": "Das Geschenk, das nach Burger schmeckt", "gift.lead": "Betrag wählen (10–200 €), sicher zahlen – der Gutschein-Code kommt sofort automatisch per E-Mail. 3 Jahre gültig.", "gift.cta": "Gutschein kaufen", "reviews.subtitle": "{rating} bei {count} Bewertungen auf Google", "reviews.via_google": "Google-Rezension", "reviews.google_btn": "Bewerte uns auf Google",
    "co.min_warn_zone": "Mindestbestellwert für {zone}: {min} · noch {rest} hinzufügen",
    "success.title": "🎉 Bestellung eingegangen!", "success.thanks": "Vielen Dank für deine Bestellung!", "success.body": "Wir haben deine Bestellung erhalten und kümmern uns sofort darum. Eine Bestätigung mit allen Details ist auf dem Weg in dein E-Mail-Postfach.",
    "success.pickup": "⏱️ Abholbereit in ca. 15 Minuten", "success.delivery": "🛵 Lieferung in ca. 30–45 Minuten", "success.new_order": "Neue Bestellung",
    "config.title": "Mach ein Menü draus!", "config.side": "Beilage wählen", "config.drink": "Getränk wählen", "config.dip": "Dip wählen", "config.add": "Als Menü hinzufügen", "config.skip": "Nein danke, nur den Burger",
    "config.qty": "Menge",
    "dip.title": "Wähle deinen Dip", "dip.sub": "Zu {product} ist 1 Dip inklusive – welcher darf es sein?", "dip.add": "Hinzufügen",
    "config.edit_title": "Menü bearbeiten", "config.edit_sub": "– passe deine Auswahl an", "config.save": "Änderungen speichern", "dip.edit_title": "Dip ändern", "dip.save": "Speichern",
    "config.incl": "inkl.", "config.add_price": "Als Menü hinzufügen ·", "config.upsell_full": "Ergänze deinen <b>{burger}</b> um Beilage, Getränk & Dip – für nur <b>+{price}</b>.", "config.menu_sub": "+ Beilage + Getränk + Dip", "config.menu_sub_short": "Beilage, Getränk & Dip für nur",
    "banner.veggie_title": "Veggie & Vegan", "banner.veggie_text": "Alle hier gezeigten Burger gibt es als Veggie-Variante (ohne Aufpreis), alle sind gleichzeitig vegan.", "banner.veggie_note": "Bitte gib „Veggie\u201c im Notiz-Feld der Bestellung an.",
    "banner.menu_title": "Spar-Menüs", "banner.menu_text": "Mach aus jedem Burger ein Menü", "banner.menu_note": "Beilage, Getränk und Dip wählst du beim Hinzufügen.",
  },

};

let currentLang = 'de';

function detectLang() {
  try {
    const saved = localStorage.getItem('gnc_lang');
    // Nicht-deutsche Pakete werden lazy geladen -> auch LANG_PACKS zulassen, sonst geht die gespeicherte Wahl verloren
    if (saved && (I18N[saved] || LANG_PACKS[saved])) return saved;
  } catch (e) {}
  const nav = (navigator.language || navigator.userLanguage || 'de').toLowerCase();
  const known = ['tr', 'en', 'it', 'es', 'pt', 'fr', 'nl'];
  for (const l of known) { if (nav.startsWith(l)) return l; }
  return 'de';
}

function t(key) {
  return (I18N[currentLang] && I18N[currentLang][key])
      || (I18N.de && I18N.de[key])
      || key;
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const val = t(key);
    if (val) el.textContent = val;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    const val = t(key);
    if (val) el.setAttribute('placeholder', val);
  });
  // Screenreader-Labels mitübersetzen (Sprachmix DE/EN vermeiden)
  document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
    const val = t(el.getAttribute('data-i18n-aria'));
    if (val) el.setAttribute('aria-label', val);
  });
  document.documentElement.setAttribute('lang', currentLang);
  if (typeof updateLangDd === 'function') updateLangDd();
  if (typeof highlightToday === 'function') highlightToday();   // „Heute"-Label mitübersetzen
  if (typeof updateHeroReviews === 'function') updateHeroReviews();
  if (typeof updateNavStatus === 'function') updateNavStatus();
  if (typeof renderSignatureSlide === 'function') renderSignatureSlide();
  if (typeof updateCartFab === 'function') updateCartFab();
}

/* ---- Lazy-Load der Sprachpakete – DE ist immer sofort da ---- */
const LANG_PACKS = {
  en: 'i18n-en.js', tr: 'i18n-tr.js',
  it: 'i18n-it.js', es: 'i18n-es.js', pt: 'i18n-pt.js', fr: 'i18n-fr.js',
  nl: 'i18n-nl.js',
};
// Locale je Sprache (Datumsformatierung etc.)
const LANG_LOCALES = { de: 'de-DE', en: 'en-GB', tr: 'tr-TR', it: 'it-IT', es: 'es-ES', pt: 'pt-PT', fr: 'fr-FR', nl: 'nl-NL' };
const LANG_LOADING = {};
const LANG_FAILED = {}; // Pakete, deren Laden fehlgeschlagen ist -> nicht endlos neu versuchen
function ensureLang(lang, cb) {
  if (I18N[lang] || !LANG_PACKS[lang]) { if (cb) cb(); return; }
  if (LANG_LOADING[lang]) { LANG_LOADING[lang].push(cb); return; }
  LANG_LOADING[lang] = [cb];
  function flush() {
    var q = LANG_LOADING[lang] || [];
    delete LANG_LOADING[lang];
    for (var i = 0; i < q.length; i++) { if (q[i]) q[i](); }
  }
  var sc = document.createElement('script');
  sc.src = LANG_PACKS[lang];
  sc.onload = flush;
  sc.onerror = function () { LANG_FAILED[lang] = true; flush(); }; // Fehler markieren statt wie Erfolg behandeln
  document.head.appendChild(sc);
}

function setLang(lang) {
  // Nur nachladen, wenn das Paket noch nicht (endgültig) fehlgeschlagen ist -> verhindert Endlos-Retry
  if (lang !== 'de' && !I18N[lang] && LANG_PACKS[lang] && !LANG_FAILED[lang]) {
    ensureLang(lang, function () { setLang(lang); });
    return;
  }
  if (!I18N[lang]) return; // Paket nicht ladbar -> Abbruch ohne Retry (t() faellt ohnehin auf DE zurueck, gespeicherte Wahl bleibt erhalten)
  currentLang = lang;
  document.documentElement.lang = lang;
  try { localStorage.setItem('gnc_lang', lang); } catch (e) {}
  applyTranslations();
  if (typeof renderMenu === 'function') renderMenu();
  if (typeof renderCart === 'function') renderCart();
  if (typeof updateOpenStatus === 'function') updateOpenStatus();
  if (typeof renderReviews === 'function') renderReviews();
}

function initI18n() {
  var want = detectLang();
  if (want !== 'de' && !I18N[want] && LANG_PACKS[want]) {
    // Erst Deutsch zeigen (sofort lesbar), Zielsprache lädt im Hintergrund nach
    currentLang = 'de';
    applyTranslations();
    if (typeof renderMenu === 'function') renderMenu();
    ensureLang(want, function () { setLang(want); });
    return;
  }
  currentLang = want;
  applyTranslations();
  // Dynamische Inhalte in der Startsprache rendern (Produktnamen etc.)
  if (typeof renderMenu === 'function') renderMenu();
  if (typeof renderCart === 'function') renderCart();
  if (typeof updateOpenStatus === 'function') updateOpenStatus();
  if (typeof renderReviews === 'function') renderReviews();
}

/* ====================================================================
   SPRACH-DROPDOWN (Flaggen)
   ==================================================================== */
const LANGS = [
  { code: 'de', label: 'Deutsch' },
  { code: 'en', label: 'English' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'it', label: 'Italiano' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' },
  { code: 'fr', label: 'Français' },
  { code: 'nl', label: 'Nederlands' },
];
const LANG_FLAGS = {
  de: '<svg viewBox="0 0 60 40" aria-hidden="true"><rect width="60" height="13.33" fill="#000"/><rect y="13.33" width="60" height="13.33" fill="#DD0000"/><rect y="26.66" width="60" height="13.34" fill="#FFCE00"/></svg>',
  en: '<svg viewBox="0 0 60 40" aria-hidden="true"><rect width="60" height="40" fill="#012169"/><path d="M0 0 60 40M60 0 0 40" stroke="#fff" stroke-width="8"/><path d="M0 0 60 40M60 0 0 40" stroke="#C8102E" stroke-width="4"/><path d="M30 0v40M0 20h60" stroke="#fff" stroke-width="13"/><path d="M30 0v40M0 20h60" stroke="#C8102E" stroke-width="8"/></svg>',
  tr: '<svg viewBox="0 0 60 40" aria-hidden="true"><rect width="60" height="40" fill="#E30A17"/><circle cx="22" cy="20" r="10" fill="#fff"/><circle cx="25" cy="20" r="8" fill="#E30A17"/><polygon points="39.5,20 35.8,21.3 35.7,25.2 33.3,22.1 29.6,23.2 31.8,20 29.6,16.8 33.3,17.9 35.7,14.8 35.8,18.7" fill="#fff"/></svg>',
  it: '<svg viewBox="0 0 60 40" aria-hidden="true"><rect width="20" height="40" fill="#009246"/><rect x="20" width="20" height="40" fill="#fff"/><rect x="40" width="20" height="40" fill="#CE2B37"/></svg>',
  es: '<svg viewBox="0 0 60 40" aria-hidden="true"><rect width="60" height="40" fill="#F1BF00"/><rect width="60" height="10" fill="#AA151B"/><rect y="30" width="60" height="10" fill="#AA151B"/></svg>',
  pt: '<svg viewBox="0 0 60 40" aria-hidden="true"><rect width="60" height="40" fill="#DA291C"/><rect width="24" height="40" fill="#046A38"/><circle cx="24" cy="20" r="7.5" fill="none" stroke="#FFE900" stroke-width="2.5"/><circle cx="24" cy="20" r="4" fill="#fff" stroke="#DA291C" stroke-width="1.5"/></svg>',
  fr: '<svg viewBox="0 0 60 40" aria-hidden="true"><rect width="20" height="40" fill="#002395"/><rect x="20" width="20" height="40" fill="#fff"/><rect x="40" width="20" height="40" fill="#ED2939"/></svg>',
  nl: '<svg viewBox="0 0 60 40" aria-hidden="true"><rect width="60" height="13.33" fill="#AE1C28"/><rect y="13.33" width="60" height="13.33" fill="#fff"/><rect y="26.66" width="60" height="13.34" fill="#21468B"/></svg>',
};

function buildLangDd() {
  const list = document.getElementById('langDdList');
  if (!list) return;
  list.innerHTML = LANGS.map(l =>
    '<li role="option" id="langOpt-' + l.code + '"><button type="button" class="lang-dd-opt" data-lang="' + l.code + '" lang="' + l.code + '" onclick="setLang(\'' + l.code + '\'); toggleLangDd(false);">' + LANG_FLAGS[l.code] + '<span>' + l.label + '</span></button></li>'
  ).join('');
  updateLangDd();
}

function toggleLangDd(force) {
  const dd = document.getElementById('langSwitch');
  const btn = document.getElementById('langDdBtn');
  const list = document.getElementById('langDdList');
  if (!dd || !btn || !list) return;
  const open = (typeof force === 'boolean') ? force : list.hidden;
  list.hidden = !open;
  dd.classList.toggle('open', open);
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function updateLangDd() {
  const flag = document.getElementById('langDdFlag');
  const code = document.getElementById('langDdCode');
  if (flag) flag.innerHTML = LANG_FLAGS[currentLang] || LANG_FLAGS.de;
  if (code) code.textContent = currentLang.toUpperCase();
  document.querySelectorAll('.lang-dd-opt').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-lang') === currentLang);
  });
}

// Außenklick & Escape schließen das Dropdown
document.addEventListener('click', function (e) {
  const dd = document.getElementById('langSwitch');
  if (dd && !dd.contains(e.target)) toggleLangDd(false);
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') toggleLangDd(false);
});
buildLangDd();

/* ====================================================================
   PRODUKT-ÜBERSETZUNGEN (Name + Beschreibung pro Produkt-ID)
   Deutsch kommt direkt aus dem MENU-Array (Fallback), hier nur EN/TR.
   ==================================================================== */
const PRODUCTS_I18N = {
};

// Übersetzten Produktnamen holen (Fallback: Original aus MENU)
// Produkt-Tags (BELIEBT, SCHARF, ...) je Sprache, Schlüssel = deutsches Original-Label
const TAGS_I18N = {
};
// Übersetztes Tag-Label holen (Fallback: deutsches Original)
function tagLabel(label) {
  if (currentLang !== 'de' && TAGS_I18N[currentLang] && TAGS_I18N[currentLang][label]) {
    return TAGS_I18N[currentLang][label];
  }
  return label;
}

function productName(item) {
  if (currentLang !== 'de' && PRODUCTS_I18N[currentLang] && PRODUCTS_I18N[currentLang][item.id]) {
    return PRODUCTS_I18N[currentLang][item.id].name;
  }
  return item.name;
}
// Übersetzte Produktbeschreibung holen (Fallback: Original aus MENU)
function productDesc(item) {
  if (currentLang !== 'de' && PRODUCTS_I18N[currentLang] && PRODUCTS_I18N[currentLang][item.id]) {
    return PRODUCTS_I18N[currentLang][item.id].desc;
  }
  return item.desc;
}
