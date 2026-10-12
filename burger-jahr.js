/* ====================================================================
   GRILL'N CHILL - BURGER-JAHR
   Abzeichen im Konto und der Jahresrueckblick als Story.
   ====================================================================

   Daten kommen von netlify/functions/kunden-jahr.js (nur das eigene Konto).
   Die Datei bringt ihr eigenes CSS und alle Texte in acht Sprachen mit
   und braucht keine Bibliothek. Syntax ES5.

   EINBINDEN (index.html)
   ----------------------
     <script src="burger-jahr.js" defer></script>

     GNCJahr.init({
       getAccount: function () { return (ACCOUNT && ACCOUNT.token) ? { email: ACCOUNT.email, token: ACCOUNT.token } : null; },
       lang: function () { return currentLang; }
     });
     GNCJahr.renderBadges(document.getElementById('accBadges'));   // z. B. in renderAccount()

   renderBadges zeigt oberhalb der Abzeichen von selbst einen Hinweis mit
   Knopf "Ansehen", wenn der Rueckblick offen ist (1.12. bis 15.1.). Wer den
   Knopf woanders will: GNCJahr.available() abfragen, GNCJahr.open() rufen,
   init({ teaser: false }) blendet den eingebauten Hinweis aus.

   API
   ---
     GNCJahr.init(opts)                opts: { getAccount, lang, t?, teaser? }
     GNCJahr.renderBadges(el) -> Promise
     GNCJahr.open()           -> Promise<boolean>
     GNCJahr.available()      -> boolean (aus dem Zwischenspeicher)
     GNCJahr.load(force?)     -> Promise<daten|null>
     GNCJahr.refresh()        -> Promise (Zwischenspeicher leeren, neu laden)
     GNCJahr.close()
   Ereignis: window 'gncjahr:update' (detail: { available }) nach jedem Laden.

   opts.t (optional): Uebersetzungsfunktion der Seite. Liefert sie fuer
   'jahr.<schluessel>' einen Text, gewinnt der vor den Texten hier.

   TESTEN
   ------
   ?jahr=1 an der URL schickt preview: true mit. Der Server oeffnet dann das
   Fenster auch ausserhalb Dezember/Januar.

   TEILEN
   ------
   Das Bild (1080 x 1920) entsteht im Canvas. Reihenfolge:
     1. iOS-App: window.webkit.messageHandlers.gncShareImage.postMessage({ dataUrl, text })
     2. Web Share mit Datei (navigator.canShare({ files }))
     3. Bild anzeigen mit Hinweis "lange druecken"
   Kein <a download>: in der App und auf iOS fuehrt das ins Leere.
   ==================================================================== */

(function () {
  'use strict';
  if (window.GNCJahr) return;

  var doc = document;
  var API = '/.netlify/functions/kunden-jahr';
  var CACHE_KEY = 'gnc_jahr_v1';

  /* Linien-Symbole je Abzeichen (24er-Raster, wie die Symbole der App).
     Dieselben Pfade zeichnet auch das Teilen-Bild (Path2D). */
  var ICO = {
    'erster-burger': ['M4 11c0-4 3.6-6.5 8-6.5S20 7 20 11', 'M3.5 14.5h17', 'M4 18c1.5 1.6 4.5 2.5 8 2.5s6.5-.9 8-2.5'],
    'stammgast': ['M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z'],
    'grill-profi': ['M12 22c4 0 7-2.7 7-6.6 0-3.1-1.8-5.4-3.6-7.2-.3 1.7-1.2 2.9-2.4 3.4.3-3.4-1.4-6.6-4.5-8.6.3 3-1.3 5-2.8 6.9C4.7 11.4 5 13.4 5 15.4 5 19.3 8 22 12 22z', 'M12 22c-1.7 0-3-1.2-3-2.8 0-1.8 1.4-2.9 3-4.7 1.6 1.8 3 2.9 3 4.7 0 1.6-1.3 2.8-3 2.8z'],
    'smash-10': ['M12 3l1.8 4.2L18 5.5l-1.7 4.3L21 12l-4.7 2.2 1.7 4.3-4.2-1.7L12 21l-1.8-4.2L6 18.5l1.7-4.3L3 12l4.7-2.2L6 5.5l4.2 1.7z'],
    'veggie-fan': ['M5 19c0-8 5-13 14-14 0 9-5 14-13 14z', 'M5 19l7-7'],
    'dip-sammler': ['M4 11.5h16a8 8 0 0 1-16 0z', 'M9.5 8c0-1.5 1-2 1-3.5', 'M13.5 8c0-1.5 1-2 1-3.5'],
    'freitagsritual': ['M5 6.5h14A1.5 1.5 0 0 1 20.5 8v11a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V8A1.5 1.5 0 0 1 5 6.5z', 'M3.5 10.5h17', 'M8 4v4M16 4v4', 'M9.5 15.2l1.8 1.8 3.4-3.4'],
    'mittagspause': ['M12 3.5a8.5 8.5 0 1 0 0 17a8.5 8.5 0 1 0 0-17z', 'M12 7.5V12l3 2'],
    'spaetschicht': ['M19 14.5A7.5 7.5 0 1 1 9.5 5a6 6 0 0 0 9.5 9.5z'],
    'double-trouble': ['M5 8.5c0-2.5 3-4 7-4s7 1.5 7 4z', 'M4.5 12h15', 'M4.5 15.5h15', 'M5 19.5h14']
  };
  var ICO_STERN = ['M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9z'];
  function icoPfade(id) { return ICO[id] || ICO_STERN; }
  function icoSvg(id) {
    var p = icoPfade(id), h = '';
    for (var i = 0; i < p.length; i++) h += '<path d="' + p[i] + '"/>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + h + '</svg>';
  }
  var TTL = 15 * 60 * 1000;
  var DAUER_MS = 6500;   // Anzeigedauer je Folie bei automatischem Weiterblaettern

  /* ------------------------------------------------------------------
     TEXTE
     ------------------------------------------------------------------ */
  var LOCALES = { de: 'de-DE', en: 'en-GB', tr: 'tr-TR', it: 'it-IT', es: 'es-ES', pt: 'pt-PT', fr: 'fr-FR', nl: 'nl-NL' };

  var STR = {
    de: {
      badges_h: 'Abzeichen', loading: 'Abzeichen werden geladen.', error: 'Abzeichen sind gerade nicht erreichbar.',
      earned: 'Erreicht', count: '{n} von {total}',
      aria_earned: '{title}: erreicht. {desc}', aria_progress: '{title}: {have} von {need}. {desc}',
      teaser_kicker: 'Jahresrückblick', teaser_title: 'Dein Burger-Jahr {year}', teaser_btn: 'Ansehen',
      story_label: 'Dein Burger-Jahr {year}', slide: 'Folie', slide_of: 'Folie {n} von {total}',
      close: 'Schließen', prev: 'Zurück', next: 'Weiter',
      s1_kicker: 'Dein Burger-Jahr', orders_one: 'Bestellung', orders_other: 'Bestellungen',
      burgers_one: '1 Burger', burgers_other: '{n} Burger', days_one: 'an 1 Tag', days_other: 'an {n} Tagen',
      sub_line: '{burgers} {days}',
      s2_kicker: 'Dein Favorit', times_one: 'einmal bestellt', times_other: '{n} mal bestellt',
      s2_none: 'Du probierst gern alles.',
      s3_kicker: 'Deine Burger-Zeit',
      dp_mittag: 'Mittags-Typ', dp_mittag_sub: 'Die meisten Bestellungen kamen vor 14 Uhr.',
      dp_nachmittag: 'Nachmittags-Typ', dp_nachmittag_sub: 'Am liebsten zwischen 14 und 18 Uhr.',
      dp_abend: 'Abend-Typ', dp_abend_sub: 'Am liebsten ab 18 Uhr.',
      s4_kicker: 'Dein Rhythmus', fav_day: 'Lieblingstag', fav_month: 'Lieblingsmonat',
      streak: 'Längste Serie', first: 'Erste Bestellung', weeks_one: '1 Woche', weeks_other: '{n} Wochen am Stück',
      s5_kicker: 'Deine Abzeichen', s5_big: '{n} von {total}', s5_sub: 'Abzeichen gesammelt',
      s5_none: 'Die ersten Abzeichen warten schon auf dich.',
      s6_title: 'Danke, dass du dabei warst', s6_sub: 'Bis bald am Truck.',
      share: 'Teilen', share_busy: 'Bild wird erstellt.', share_err: 'Das Bild konnte nicht erstellt werden.',
      save_hint: 'Lange drücken oder Rechtsklick, um das Bild zu sichern.', back: 'Zurück zur Story',
      img_alt: 'Dein Burger-Jahr {year} als Bild',
      share_text: "Mein Burger-Jahr {year} bei Grill'n Chill: {orders}.", share_fav: 'Favorit: {name}.',
      empty_title: 'Noch keine Bestellungen in {year}',
      empty_sub: 'Sobald du bei uns bestellst, füllt sich dein Burger-Jahr.',
      img_title: 'Mein Burger-Jahr', lbl_fav: 'Favorit'
    },
    en: {
      badges_h: 'Badges', loading: 'Loading badges.', error: 'Badges are not available right now.',
      earned: 'Earned', count: '{n} of {total}',
      aria_earned: '{title}: earned. {desc}', aria_progress: '{title}: {have} of {need}. {desc}',
      teaser_kicker: 'Year in review', teaser_title: 'Your Burger Year {year}', teaser_btn: 'View',
      story_label: 'Your Burger Year {year}', slide: 'Slide', slide_of: 'Slide {n} of {total}',
      close: 'Close', prev: 'Back', next: 'Next',
      s1_kicker: 'Your Burger Year', orders_one: 'order', orders_other: 'orders',
      burgers_one: '1 burger', burgers_other: '{n} burgers', days_one: 'on 1 day', days_other: 'on {n} days',
      sub_line: '{burgers} {days}',
      s2_kicker: 'Your favourite', times_one: 'ordered once', times_other: 'ordered {n} times',
      s2_none: 'You like to try everything.',
      s3_kicker: 'Your burger time',
      dp_mittag: 'Lunch person', dp_mittag_sub: 'Most of your orders came in before 2 pm.',
      dp_nachmittag: 'Afternoon person', dp_nachmittag_sub: 'Your sweet spot is between 2 and 6 pm.',
      dp_abend: 'Evening person', dp_abend_sub: 'You like it best after 6 pm.',
      s4_kicker: 'Your rhythm', fav_day: 'Favourite day', fav_month: 'Favourite month',
      streak: 'Longest streak', first: 'First order', weeks_one: '1 week', weeks_other: '{n} weeks in a row',
      s5_kicker: 'Your badges', s5_big: '{n} of {total}', s5_sub: 'badges collected',
      s5_none: 'Your first badges are waiting for you.',
      s6_title: 'Thanks for being part of it', s6_sub: 'See you at the truck.',
      share: 'Share', share_busy: 'Creating image.', share_err: 'The image could not be created.',
      save_hint: 'Long press or right click to save the image.', back: 'Back to the story',
      img_alt: 'Your Burger Year {year} as an image',
      share_text: "My Burger Year {year} at Grill'n Chill: {orders}.", share_fav: 'Favourite: {name}.',
      empty_title: 'No orders in {year} yet',
      empty_sub: 'As soon as you order with us, your Burger Year fills up.',
      img_title: 'My Burger Year', lbl_fav: 'Favourite'
    },
    tr: {
      badges_h: 'Rozetler', loading: 'Rozetler yükleniyor.', error: 'Rozetlere şu anda ulaşılamıyor.',
      earned: 'Kazanıldı', count: '{n}/{total}',
      aria_earned: '{title}: kazanıldı. {desc}', aria_progress: '{title}: {have}/{need}. {desc}',
      teaser_kicker: 'Yılın özeti', teaser_title: '{year} Burger Yılın', teaser_btn: 'Göster',
      story_label: '{year} Burger Yılın', slide: 'Slayt', slide_of: 'Slayt {n}/{total}',
      close: 'Kapat', prev: 'Geri', next: 'İleri',
      s1_kicker: 'Burger Yılın', orders_one: 'sipariş', orders_other: 'sipariş',
      burgers_one: '1 burger', burgers_other: '{n} burger', days_one: '1 günde', days_other: '{n} günde',
      sub_line: '{days} {burgers}',
      s2_kicker: 'Favorin', times_one: 'bir kez sipariş edildi', times_other: '{n} kez sipariş edildi',
      s2_none: 'Her şeyi denemeyi seviyorsun.',
      s3_kicker: 'Burger saatin',
      dp_mittag: 'Öğlenci', dp_mittag_sub: "Siparişlerinin çoğu 14:00'ten önceydi.",
      dp_nachmittag: 'Öğleden sonracı', dp_nachmittag_sub: 'En çok 14:00 ile 18:00 arası.',
      dp_abend: 'Akşamcı', dp_abend_sub: "En çok 18:00'den sonra.",
      s4_kicker: 'Ritmin', fav_day: 'Favori gün', fav_month: 'Favori ay',
      streak: 'En uzun seri', first: 'İlk sipariş', weeks_one: '1 hafta', weeks_other: 'Art arda {n} hafta',
      s5_kicker: 'Rozetlerin', s5_big: '{n}/{total}', s5_sub: 'rozet toplandı',
      s5_none: 'İlk rozetlerin seni bekliyor.',
      s6_title: 'Bizimle olduğun için teşekkürler', s6_sub: 'Truckta görüşmek üzere.',
      share: 'Paylaş', share_busy: 'Görsel hazırlanıyor.', share_err: 'Görsel oluşturulamadı.',
      save_hint: 'Görseli kaydetmek için uzun bas veya sağ tıkla.', back: 'Hikayeye dön',
      img_alt: '{year} Burger Yılın görseli',
      share_text: "Grill'n Chill'de {year} Burger Yılım: {orders}.", share_fav: 'Favori: {name}.',
      empty_title: '{year} yılında henüz sipariş yok',
      empty_sub: 'Bizden sipariş verdiğinde Burger Yılın dolmaya başlar.',
      img_title: 'Burger Yılım', lbl_fav: 'Favori'
    },
    it: {
      badges_h: 'Badge', loading: 'Caricamento dei badge.', error: 'I badge non sono disponibili al momento.',
      earned: 'Ottenuto', count: '{n} di {total}',
      aria_earned: '{title}: ottenuto. {desc}', aria_progress: '{title}: {have} di {need}. {desc}',
      teaser_kicker: 'Il tuo anno', teaser_title: 'Il tuo anno burger {year}', teaser_btn: 'Guarda',
      story_label: 'Il tuo anno burger {year}', slide: 'Diapositiva', slide_of: 'Diapositiva {n} di {total}',
      close: 'Chiudi', prev: 'Indietro', next: 'Avanti',
      s1_kicker: 'Il tuo anno burger', orders_one: 'ordine', orders_other: 'ordini',
      burgers_one: '1 burger', burgers_other: '{n} burger', days_one: 'in 1 giorno', days_other: 'in {n} giorni',
      sub_line: '{burgers} {days}',
      s2_kicker: 'Il tuo preferito', times_one: 'ordinato una volta', times_other: 'ordinato {n} volte',
      s2_none: 'Ti piace provare di tutto.',
      s3_kicker: "La tua ora del burger",
      dp_mittag: 'Tipo da pranzo', dp_mittag_sub: 'La maggior parte degli ordini è arrivata prima delle 14.',
      dp_nachmittag: 'Tipo da pomeriggio', dp_nachmittag_sub: 'Preferisci tra le 14 e le 18.',
      dp_abend: 'Tipo da sera', dp_abend_sub: 'Preferisci dopo le 18.',
      s4_kicker: 'Il tuo ritmo', fav_day: 'Giorno preferito', fav_month: 'Mese preferito',
      streak: 'Serie più lunga', first: 'Primo ordine', weeks_one: '1 settimana', weeks_other: '{n} settimane di fila',
      s5_kicker: 'I tuoi badge', s5_big: '{n} di {total}', s5_sub: 'badge raccolti',
      s5_none: 'I tuoi primi badge ti aspettano.',
      s6_title: 'Grazie per averci scelto', s6_sub: 'Ci vediamo al truck.',
      share: 'Condividi', share_busy: 'Creazione immagine.', share_err: "Non è stato possibile creare l'immagine.",
      save_hint: "Tieni premuto o fai clic destro per salvare l'immagine.", back: 'Torna alla storia',
      img_alt: 'Il tuo anno burger {year} come immagine',
      share_text: "Il mio anno burger {year} da Grill'n Chill: {orders}.", share_fav: 'Preferito: {name}.',
      empty_title: 'Ancora nessun ordine nel {year}',
      empty_sub: 'Appena ordini da noi, il tuo anno burger si riempie.',
      img_title: 'Il mio anno burger', lbl_fav: 'Preferito'
    },
    es: {
      badges_h: 'Insignias', loading: 'Cargando insignias.', error: 'Las insignias no están disponibles ahora.',
      earned: 'Conseguida', count: '{n} de {total}',
      aria_earned: '{title}: conseguida. {desc}', aria_progress: '{title}: {have} de {need}. {desc}',
      teaser_kicker: 'Tu resumen del año', teaser_title: 'Tu año burger {year}', teaser_btn: 'Ver',
      story_label: 'Tu año burger {year}', slide: 'Diapositiva', slide_of: 'Diapositiva {n} de {total}',
      close: 'Cerrar', prev: 'Atrás', next: 'Siguiente',
      s1_kicker: 'Tu año burger', orders_one: 'pedido', orders_other: 'pedidos',
      burgers_one: '1 hamburguesa', burgers_other: '{n} hamburguesas', days_one: 'en 1 día', days_other: 'en {n} días',
      sub_line: '{burgers} {days}',
      s2_kicker: 'Tu favorito', times_one: 'pedido una vez', times_other: 'pedido {n} veces',
      s2_none: 'Te gusta probarlo todo.',
      s3_kicker: 'Tu hora burger',
      dp_mittag: 'De mediodía', dp_mittag_sub: 'La mayoría de tus pedidos llegaron antes de las 14:00.',
      dp_nachmittag: 'De tarde', dp_nachmittag_sub: 'Lo tuyo es entre las 14:00 y las 18:00.',
      dp_abend: 'De noche', dp_abend_sub: 'Lo tuyo es a partir de las 18:00.',
      s4_kicker: 'Tu ritmo', fav_day: 'Día favorito', fav_month: 'Mes favorito',
      streak: 'Racha más larga', first: 'Primer pedido', weeks_one: '1 semana', weeks_other: '{n} semanas seguidas',
      s5_kicker: 'Tus insignias', s5_big: '{n} de {total}', s5_sub: 'insignias conseguidas',
      s5_none: 'Tus primeras insignias te están esperando.',
      s6_title: 'Gracias por estar ahí', s6_sub: 'Nos vemos en el truck.',
      share: 'Compartir', share_busy: 'Creando imagen.', share_err: 'No se pudo crear la imagen.',
      save_hint: 'Mantén pulsado o haz clic derecho para guardar la imagen.', back: 'Volver a la historia',
      img_alt: 'Tu año burger {year} como imagen',
      share_text: "Mi año burger {year} en Grill'n Chill: {orders}.", share_fav: 'Favorito: {name}.',
      empty_title: 'Aún no hay pedidos en {year}',
      empty_sub: 'En cuanto pidas con nosotros, tu año burger se irá llenando.',
      img_title: 'Mi año burger', lbl_fav: 'Favorito'
    },
    pt: {
      badges_h: 'Conquistas', loading: 'A carregar conquistas.', error: 'As conquistas não estão disponíveis agora.',
      earned: 'Conquistada', count: '{n} de {total}',
      aria_earned: '{title}: conquistada. {desc}', aria_progress: '{title}: {have} de {need}. {desc}',
      teaser_kicker: 'O teu resumo do ano', teaser_title: 'O teu ano burger {year}', teaser_btn: 'Ver',
      story_label: 'O teu ano burger {year}', slide: 'Diapositivo', slide_of: 'Diapositivo {n} de {total}',
      close: 'Fechar', prev: 'Anterior', next: 'Seguinte',
      s1_kicker: 'O teu ano burger', orders_one: 'encomenda', orders_other: 'encomendas',
      burgers_one: '1 hambúrguer', burgers_other: '{n} hambúrgueres', days_one: 'em 1 dia', days_other: 'em {n} dias',
      sub_line: '{burgers} {days}',
      s2_kicker: 'O teu favorito', times_one: 'encomendado uma vez', times_other: 'encomendado {n} vezes',
      s2_none: 'Gostas de provar de tudo.',
      s3_kicker: 'A tua hora burger',
      dp_mittag: 'Pessoa do almoço', dp_mittag_sub: 'A maioria das encomendas chegou antes das 14h.',
      dp_nachmittag: 'Pessoa da tarde', dp_nachmittag_sub: 'Preferes entre as 14h e as 18h.',
      dp_abend: 'Pessoa da noite', dp_abend_sub: 'Preferes depois das 18h.',
      s4_kicker: 'O teu ritmo', fav_day: 'Dia favorito', fav_month: 'Mês favorito',
      streak: 'Maior sequência', first: 'Primeira encomenda', weeks_one: '1 semana', weeks_other: '{n} semanas seguidas',
      s5_kicker: 'As tuas conquistas', s5_big: '{n} de {total}', s5_sub: 'conquistas reunidas',
      s5_none: 'As tuas primeiras conquistas estão à tua espera.',
      s6_title: 'Obrigado por fazeres parte', s6_sub: 'Até breve no truck.',
      share: 'Partilhar', share_busy: 'A criar imagem.', share_err: 'Não foi possível criar a imagem.',
      save_hint: 'Mantém premido ou clica com o botão direito para guardar a imagem.', back: 'Voltar à história',
      img_alt: 'O teu ano burger {year} como imagem',
      share_text: "O meu ano burger {year} no Grill'n Chill: {orders}.", share_fav: 'Favorito: {name}.',
      empty_title: 'Ainda sem encomendas em {year}',
      empty_sub: 'Assim que encomendares connosco, o teu ano burger começa a encher.',
      img_title: 'O meu ano burger', lbl_fav: 'Favorito'
    },
    fr: {
      badges_h: 'Badges', loading: 'Chargement des badges.', error: 'Les badges ne sont pas disponibles pour le moment.',
      earned: 'Obtenu', count: '{n} sur {total}',
      aria_earned: '{title} : obtenu. {desc}', aria_progress: '{title} : {have} sur {need}. {desc}',
      teaser_kicker: "Ton bilan de l'année", teaser_title: 'Ton année burger {year}', teaser_btn: 'Voir',
      story_label: 'Ton année burger {year}', slide: 'Diapositive', slide_of: 'Diapositive {n} sur {total}',
      close: 'Fermer', prev: 'Retour', next: 'Suivant',
      s1_kicker: 'Ton année burger', orders_one: 'commande', orders_other: 'commandes',
      burgers_one: '1 burger', burgers_other: '{n} burgers', days_one: 'en 1 jour', days_other: 'en {n} jours',
      sub_line: '{burgers} {days}',
      s2_kicker: 'Ton favori', times_one: 'commandé une fois', times_other: 'commandé {n} fois',
      s2_none: 'Tu aimes tout goûter.',
      s3_kicker: 'Ton heure burger',
      dp_mittag: 'Team midi', dp_mittag_sub: 'La plupart de tes commandes sont arrivées avant 14 h.',
      dp_nachmittag: 'Team après-midi', dp_nachmittag_sub: 'Tu préfères entre 14 h et 18 h.',
      dp_abend: 'Team soirée', dp_abend_sub: 'Tu préfères après 18 h.',
      s4_kicker: 'Ton rythme', fav_day: 'Jour préféré', fav_month: 'Mois préféré',
      streak: 'Plus longue série', first: 'Première commande', weeks_one: '1 semaine', weeks_other: "{n} semaines d'affilée",
      s5_kicker: 'Tes badges', s5_big: '{n} sur {total}', s5_sub: 'badges obtenus',
      s5_none: "Tes premiers badges t'attendent.",
      s6_title: "Merci d'avoir été là", s6_sub: 'À bientôt au truck.',
      share: 'Partager', share_busy: "Création de l'image.", share_err: "L'image n'a pas pu être créée.",
      save_hint: "Appuie longuement ou fais un clic droit pour enregistrer l'image.", back: 'Retour à la story',
      img_alt: 'Ton année burger {year} en image',
      share_text: "Mon année burger {year} chez Grill'n Chill : {orders}.", share_fav: 'Favori : {name}.',
      empty_title: 'Pas encore de commande en {year}',
      empty_sub: 'Dès ta première commande, ton année burger se remplit.',
      img_title: 'Mon année burger', lbl_fav: 'Favori'
    },
    nl: {
      badges_h: 'Badges', loading: 'Badges worden geladen.', error: 'Badges zijn nu niet beschikbaar.',
      earned: 'Behaald', count: '{n} van {total}',
      aria_earned: '{title}: behaald. {desc}', aria_progress: '{title}: {have} van {need}. {desc}',
      teaser_kicker: 'Jaaroverzicht', teaser_title: 'Jouw burgerjaar {year}', teaser_btn: 'Bekijken',
      story_label: 'Jouw burgerjaar {year}', slide: 'Dia', slide_of: 'Dia {n} van {total}',
      close: 'Sluiten', prev: 'Terug', next: 'Volgende',
      s1_kicker: 'Jouw burgerjaar', orders_one: 'bestelling', orders_other: 'bestellingen',
      burgers_one: '1 burger', burgers_other: '{n} burgers', days_one: 'op 1 dag', days_other: 'op {n} dagen',
      sub_line: '{burgers} {days}',
      s2_kicker: 'Jouw favoriet', times_one: 'één keer besteld', times_other: '{n} keer besteld',
      s2_none: 'Jij probeert graag alles.',
      s3_kicker: 'Jouw burgertijd',
      dp_mittag: 'Lunchtype', dp_mittag_sub: 'De meeste bestellingen kwamen voor 14 uur.',
      dp_nachmittag: 'Middagtype', dp_nachmittag_sub: 'Het liefst tussen 14 en 18 uur.',
      dp_abend: 'Avondtype', dp_abend_sub: 'Het liefst na 18 uur.',
      s4_kicker: 'Jouw ritme', fav_day: 'Favoriete dag', fav_month: 'Favoriete maand',
      streak: 'Langste reeks', first: 'Eerste bestelling', weeks_one: '1 week', weeks_other: '{n} weken op rij',
      s5_kicker: 'Jouw badges', s5_big: '{n} van {total}', s5_sub: 'badges verzameld',
      s5_none: 'Je eerste badges wachten op je.',
      s6_title: 'Bedankt dat je erbij was', s6_sub: 'Tot snel bij de truck.',
      share: 'Delen', share_busy: 'Afbeelding wordt gemaakt.', share_err: 'De afbeelding kon niet worden gemaakt.',
      save_hint: 'Lang indrukken of rechtsklikken om de afbeelding op te slaan.', back: 'Terug naar het verhaal',
      img_alt: 'Jouw burgerjaar {year} als afbeelding',
      share_text: "Mijn burgerjaar {year} bij Grill'n Chill: {orders}.", share_fav: 'Favoriet: {name}.',
      empty_title: 'Nog geen bestellingen in {year}',
      empty_sub: 'Zodra je bij ons bestelt, vult je burgerjaar zich.',
      img_title: 'Mijn burgerjaar', lbl_fav: 'Favoriet'
    }
  };

  /* Abzeichen: [Titel, Beschreibung] je Sprache. IDs wie in
     netlify/functions/lib/abzeichen.js. Fehlt eine ID, gilt title_de/desc_de
     vom Server. */
  var BT = {
    de: {
      'erster-burger': ['Erster Burger', 'Deine erste Bestellung bei uns.'],
      'stammgast': ['Stammgast', '5 Bestellungen.'],
      'grill-profi': ['Grill-Profi', '25 Bestellungen.'],
      'smash-10': ['10 Smashburger', '10 Kubis Special, unser Smashburger.'],
      'veggie-fan': ['Veggie-Fan', '5 Veggie-Burger.'],
      'dip-sammler': ['Dip-Sammler', 'Jeden Dip mindestens einmal probiert.'],
      'freitagsritual': ['Freitagsritual', 'An jedem Freitag eines Monats bestellt.'],
      'mittagspause': ['Mittagspause', '10 Bestellungen zwischen 11:30 und 14 Uhr.'],
      'spaetschicht': ['Spätschicht', '5 Bestellungen nach 19:30 Uhr.'],
      'double-trouble': ['Double-Trouble', '5 Burger mit Double Patty.']
    },
    en: {
      'erster-burger': ['First Burger', 'Your first order with us.'],
      'stammgast': ['Regular', '5 orders.'],
      'grill-profi': ['Grill Pro', '25 orders.'],
      'smash-10': ['10 Smash Burgers', '10 Kubis Specials, our smash burger.'],
      'veggie-fan': ['Veggie Fan', '5 veggie burgers.'],
      'dip-sammler': ['Dip Collector', 'Tried every dip at least once.'],
      'freitagsritual': ['Friday Ritual', 'Ordered on every Friday of a month.'],
      'mittagspause': ['Lunch Break', '10 orders between 11:30 am and 2 pm.'],
      'spaetschicht': ['Late Shift', '5 orders after 7:30 pm.'],
      'double-trouble': ['Double Trouble', '5 burgers with a double patty.']
    },
    tr: {
      'erster-burger': ['İlk Burger', 'Bizden ilk siparişin.'],
      'stammgast': ['Müdavim', '5 sipariş.'],
      'grill-profi': ['Izgara Ustası', '25 sipariş.'],
      'smash-10': ['10 Smash Burger', '10 Kubis Special, smash burgerimiz.'],
      'veggie-fan': ['Veggie Hayranı', '5 vejetaryen burger.'],
      'dip-sammler': ['Sos Koleksiyoncusu', 'Her sosu en az bir kez denedin.'],
      'freitagsritual': ['Cuma Ritüeli', 'Bir ayın her cumasında sipariş verdin.'],
      'mittagspause': ['Öğle Arası', '11:30 ile 14:00 arasında 10 sipariş.'],
      'spaetschicht': ['Gece Mesaisi', "19:30'dan sonra 5 sipariş."],
      'double-trouble': ['Double Trouble', 'Çift köfteli 5 burger.']
    },
    it: {
      'erster-burger': ['Primo burger', 'Il tuo primo ordine da noi.'],
      'stammgast': ['Cliente abituale', '5 ordini.'],
      'grill-profi': ['Maestro della griglia', '25 ordini.'],
      'smash-10': ['10 Smash Burger', '10 Kubis Special, il nostro smash burger.'],
      'veggie-fan': ['Fan del veggie', '5 burger vegetariani.'],
      'dip-sammler': ['Collezionista di salse', 'Hai provato ogni salsa almeno una volta.'],
      'freitagsritual': ['Rito del venerdì', 'Hai ordinato ogni venerdì di un mese.'],
      'mittagspause': ['Pausa pranzo', '10 ordini tra le 11:30 e le 14:00.'],
      'spaetschicht': ['Turno serale', '5 ordini dopo le 19:30.'],
      'double-trouble': ['Double Trouble', '5 burger con doppio patty.']
    },
    es: {
      'erster-burger': ['Primera hamburguesa', 'Tu primer pedido con nosotros.'],
      'stammgast': ['Cliente habitual', '5 pedidos.'],
      'grill-profi': ['Maestro de la parrilla', '25 pedidos.'],
      'smash-10': ['10 Smash Burgers', '10 Kubis Special, nuestra smash burger.'],
      'veggie-fan': ['Fan veggie', '5 hamburguesas vegetarianas.'],
      'dip-sammler': ['Coleccionista de salsas', 'Probaste cada salsa al menos una vez.'],
      'freitagsritual': ['Ritual del viernes', 'Pediste todos los viernes de un mes.'],
      'mittagspause': ['Pausa del almuerzo', '10 pedidos entre las 11:30 y las 14:00.'],
      'spaetschicht': ['Turno de noche', '5 pedidos después de las 19:30.'],
      'double-trouble': ['Double Trouble', '5 hamburguesas con doble carne.']
    },
    pt: {
      'erster-burger': ['Primeiro hambúrguer', 'A tua primeira encomenda connosco.'],
      'stammgast': ['Cliente habitual', '5 encomendas.'],
      'grill-profi': ['Mestre da grelha', '25 encomendas.'],
      'smash-10': ['10 Smash Burgers', '10 Kubis Special, o nosso smash burger.'],
      'veggie-fan': ['Fã veggie', '5 hambúrgueres vegetarianos.'],
      'dip-sammler': ['Colecionador de molhos', 'Provaste cada molho pelo menos uma vez.'],
      'freitagsritual': ['Ritual de sexta', 'Encomendaste em todas as sextas de um mês.'],
      'mittagspause': ['Pausa de almoço', '10 encomendas entre as 11h30 e as 14h.'],
      'spaetschicht': ['Turno da noite', '5 encomendas depois das 19h30.'],
      'double-trouble': ['Double Trouble', '5 hambúrgueres com carne dupla.']
    },
    fr: {
      'erster-burger': ['Premier burger', 'Ta première commande chez nous.'],
      'stammgast': ['Habitué', '5 commandes.'],
      'grill-profi': ['Pro du grill', '25 commandes.'],
      'smash-10': ['10 Smash Burgers', '10 Kubis Special, notre smash burger.'],
      'veggie-fan': ['Fan de veggie', '5 burgers végétariens.'],
      'dip-sammler': ['Collectionneur de sauces', 'Chaque sauce goûtée au moins une fois.'],
      'freitagsritual': ['Rituel du vendredi', "Commandé chaque vendredi d'un mois."],
      'mittagspause': ['Pause déjeuner', '10 commandes entre 11 h 30 et 14 h.'],
      'spaetschicht': ['Service du soir', '5 commandes après 19 h 30.'],
      'double-trouble': ['Double Trouble', '5 burgers avec double steak.']
    },
    nl: {
      'erster-burger': ['Eerste burger', 'Je eerste bestelling bij ons.'],
      'stammgast': ['Vaste klant', '5 bestellingen.'],
      'grill-profi': ['Grillprofi', '25 bestellingen.'],
      'smash-10': ['10 Smashburgers', '10 Kubis Specials, onze smashburger.'],
      'veggie-fan': ['Veggiefan', '5 veggieburgers.'],
      'dip-sammler': ['Dipverzamelaar', 'Elke dip minstens één keer geprobeerd.'],
      'freitagsritual': ['Vrijdagritueel', 'Elke vrijdag van een maand besteld.'],
      'mittagspause': ['Lunchpauze', '10 bestellingen tussen 11:30 en 14:00 uur.'],
      'spaetschicht': ['Late dienst', '5 bestellingen na 19:30 uur.'],
      'double-trouble': ['Double Trouble', '5 burgers met dubbele patty.']
    }
  };

  /* ------------------------------------------------------------------
     KLEINE HELFER
     ------------------------------------------------------------------ */
  var opts = { getAccount: null, lang: null, t: null, teaser: true };

  function noop() {}
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(str, vars) {
    return String(str).replace(/\{(\w+)\}/g, function (m, k) {
      return (vars && vars[k] != null) ? String(vars[k]) : m;
    });
  }
  function curLang() {
    var l = null;
    try { l = opts.lang ? opts.lang() : null; } catch (e) {}
    if (!l) { try { l = (typeof currentLang !== 'undefined') ? currentLang : null; } catch (e2) {} }
    if (!l) l = doc.documentElement.getAttribute('lang') || 'de';
    l = String(l).toLowerCase().slice(0, 2);
    return STR[l] ? l : 'de';
  }
  function locale() { return LOCALES[curLang()] || 'de-DE'; }
  function T(key, vars) {
    var s = null;
    if (typeof opts.t === 'function') {
      try {
        var x = opts.t('jahr.' + key);
        if (typeof x === 'string' && x && x !== 'jahr.' + key) s = x;
      } catch (e) {}
    }
    if (s == null) {
      var tab = STR[curLang()];
      s = (tab && tab[key] != null) ? tab[key] : (STR.de[key] != null ? STR.de[key] : key);
    }
    return fmt(s, vars);
  }
  function num(n) {
    try { return new Intl.NumberFormat(locale()).format(n); } catch (e) { return String(n); }
  }
  function plural(base, n) { return T(base + (n === 1 ? '_one' : '_other'), { n: num(n) }); }
  function gross(s) {
    s = String(s || '');
    try { return s.charAt(0).toLocaleUpperCase(locale()) + s.slice(1); } catch (e) { return s.charAt(0).toUpperCase() + s.slice(1); }
  }
  function versal(s) {
    try { return String(s).toLocaleUpperCase(locale()); } catch (e) { return String(s).toUpperCase(); }
  }
  var WD_DE = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  var MO_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  function wochentag(i) {
    if (i == null) return '';
    // 04.10.2026 ist ein Sonntag: + i ergibt den Wochentag i (0 = Sonntag)
    try { return gross(new Intl.DateTimeFormat(locale(), { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 9, 4 + i)))); }
    catch (e) { return WD_DE[i] || ''; }
  }
  function monat(m) {
    if (!m) return '';
    try { return gross(new Intl.DateTimeFormat(locale(), { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, m - 1, 15)))); }
    catch (e) { return MO_DE[m - 1] || ''; }
  }
  function datumLang(iso) {
    if (!iso) return '';
    try { return new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'long', timeZone: 'Europe/Berlin' }).format(new Date(iso)); }
    catch (e) { return String(iso).slice(0, 10); }
  }
  function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }
  function previewParam() {
    try { return /[?&]jahr=1(&|#|$)/.test(window.location.search); } catch (e) { return false; }
  }
  function warte(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function hash(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function menuItem(id) {
    var sk = window.SPEISEKARTE;
    if (!sk || !sk.MENU) return null;
    for (var i = 0; i < sk.MENU.length; i++) if (sk.MENU[i].id === id) return sk.MENU[i];
    return null;
  }
  function produktName(fav) {
    if (!fav) return '';
    var l = curLang();
    try {
      /* global PRODUCTS_I18N */
      if (typeof PRODUCTS_I18N !== 'undefined' && PRODUCTS_I18N[l] && PRODUCTS_I18N[l][fav.id] && PRODUCTS_I18N[l][fav.id].name) {
        return PRODUCTS_I18N[l][fav.id].name;
      }
    } catch (e) {}
    var m = menuItem(fav.id);
    return (m && m.name) || fav.name || fav.id;
  }
  function produktBild(fav) {
    var m = fav && menuItem(fav.id);
    if (!m || !m.image) return null;
    return m.image.charAt(0) === '/' ? m.image : '/' + m.image;
  }
  function badgeText(b) {
    var tab = BT[curLang()] || BT.de;
    var t = tab[b.id] || BT.de[b.id];
    return t || [b.title_de || b.id, b.desc_de || ''];
  }
  /* Fest, nicht aus location: in der App, in Vorschauen und auf
     *.netlify.app soll im Bild trotzdem die echte Adresse stehen. */
  function seite() { return 'grillnchill-foodtruck.de'; }

  /* ------------------------------------------------------------------
     DATEN
     ------------------------------------------------------------------ */
  var mem = null;       // { k, at, d }
  var laufend = null;   // { k, p }

  function konto() {
    try {
      var a = opts.getAccount ? opts.getAccount() : null;
      if (a && a.email && a.token) return a;
    } catch (e) {}
    return null;
  }
  function schluessel(a) {
    return hash(String(a.email).toLowerCase() + '|' + a.token + '|' + (previewParam() ? 'p' : ''));
  }
  function sessionLesen() {
    try { return JSON.parse(window.sessionStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { return null; }
  }
  function sessionSchreiben(v) {
    try {
      if (v) window.sessionStorage.setItem(CACHE_KEY, JSON.stringify(v));
      else window.sessionStorage.removeItem(CACHE_KEY);
    } catch (e) {}
  }
  function melden() {
    var detail = { available: available() };
    try {
      var ev;
      if (typeof window.CustomEvent === 'function') ev = new window.CustomEvent('gncjahr:update', { detail: detail });
      else { ev = doc.createEvent('CustomEvent'); ev.initCustomEvent('gncjahr:update', false, false, detail); }
      window.dispatchEvent(ev);
    } catch (e) {}
  }

  function load(force) {
    var a = konto();
    if (!a || typeof fetch !== 'function') { mem = null; return Promise.resolve(null); }
    var k = schluessel(a);
    if (!force) {
      if (mem && mem.k === k && Date.now() - mem.at < TTL) return Promise.resolve(mem.d);
      var ss = sessionLesen();
      if (ss && ss.k === k && ss.d && Date.now() - ss.at < TTL) { mem = ss; return Promise.resolve(ss.d); }
      if (laufend && laufend.k === k) return laufend.p;
    }
    var body = { email: a.email, token: a.token };
    if (previewParam()) body.preview = true;
    var p = fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin'
    }).then(function (r) {
      if (r.status === 401) return null;
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function (d) {
      laufend = null;
      if (!d || !d.ok) { mem = null; sessionSchreiben(null); melden(); return null; }
      mem = { k: k, at: Date.now(), d: d };
      sessionSchreiben(mem);
      melden();
      return d;
    }, function (e) {
      laufend = null;
      throw e;
    });
    laufend = { k: k, p: p };
    return p;
  }

  function refresh() {
    mem = null;
    sessionSchreiben(null);
    return load(true);
  }

  function available() {
    var a = konto();
    if (!a || !mem || mem.k !== schluessel(a)) return false;
    var d = mem.d;
    if (!d || !d.window || !d.window.open) return false;
    return !!((d.review && d.review.orders > 0) || d.preview);
  }

  /* ------------------------------------------------------------------
     CSS
     ------------------------------------------------------------------ */
  var CSS = [
    '.gncj-sr{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
    /* Abzeichen im Konto */
    '.gncj-sec{margin:0 0 1rem;font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;color:#F5E9D0}',
    '.gncj-head{display:flex;align-items:baseline;justify-content:space-between;gap:.5rem;margin:0 0 .55rem}',
    ".gncj-h{font-family:'Bowlby One',Impact,sans-serif;font-weight:400;text-transform:uppercase;font-size:1rem;letter-spacing:.02em;line-height:1.2;color:#F5E9D0;margin:0}",
    '.gncj-count{font-size:.75rem;font-weight:600;color:#9A8E7A;white-space:nowrap}',
    '.gncj-load{font-size:.78rem;color:#9A8E7A;margin:0}',
    '.gncj-grid{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(4.9rem,1fr));gap:.45rem}',
    '.gncj-b{margin:0;padding:0}',
    '.gncj-bb{-webkit-appearance:none;appearance:none;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:.28rem;width:100%;min-height:5.6rem;margin:0;padding:.6rem .3rem .5rem;background:#1C1C1C;border:1px solid #2A2520;border-radius:14px;color:#F5E9D0;font:inherit;text-align:center;cursor:pointer;box-sizing:border-box;transition:border-color .2s,transform .2s}',
    '.gncj-bb:hover{border-color:#3A332C}',
    '.gncj-bb:active{transform:scale(.97)}',
    '.gncj-bb:focus-visible{outline:2px solid #FF7A3D;outline-offset:2px}',
    '.gncj-bb.is-sel{border-color:#FF7A3D}',
    '.gncj-ico{display:block;width:1.75rem;height:1.75rem;color:#9A8E7A;opacity:.55}',
    '.gncj-ico svg,.gncj-chip-ico svg{display:block;width:100%;height:100%}',
    '.gncj-chip-ico{display:inline-block;width:1.15em;height:1.15em;vertical-align:-.2em;margin-right:.4em;color:#FF7A3D}',
    '.gncj-bn{font-size:.68rem;font-weight:700;line-height:1.25;color:#9A8E7A}',
    '.gncj-bp{font-size:.64rem;font-weight:600;line-height:1;color:#9A8E7A;font-variant-numeric:tabular-nums}',
    '.gncj-track{display:block;width:72%;height:3px;border-radius:2px;background:#2A2520;overflow:hidden}',
    '.gncj-track i{display:block;height:100%;background:#E85A24;border-radius:2px}',
    '.gncj-b.is-earned .gncj-bb{background:radial-gradient(120% 90% at 50% 0%,rgba(232,90,36,.28),rgba(232,90,36,0) 70%),#1C1C1C;border-color:rgba(232,90,36,.6)}',
    '.gncj-b.is-earned .gncj-ico{color:#FF7A3D;opacity:1}',
    '.gncj-b.is-earned .gncj-bn{color:#F5E9D0}',
    '.gncj-b.is-earned .gncj-bp{color:#FF7A3D}',
    '.gncj-detail{min-height:1.2em;margin:.55rem 0 0;font-size:.76rem;line-height:1.45;color:#E6D9BC}',
    '.gncj-teaser{display:flex;align-items:center;gap:.8rem;margin:0 0 .9rem;padding:.85rem .9rem;border-radius:14px;border:1px solid rgba(232,90,36,.55);background:radial-gradient(140% 120% at 0% 0%,rgba(232,90,36,.35),rgba(232,90,36,0) 60%),#1C1C1C}',
    '.gncj-teaser-t{flex:1;min-width:0}',
    '.gncj-teaser-k{display:block;font-size:.66rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#FF7A3D;margin-bottom:.15rem}',
    ".gncj-teaser-n{display:block;font-family:'Bowlby One',Impact,sans-serif;font-weight:400;text-transform:uppercase;font-size:1.02rem;line-height:1.2;color:#F5E9D0}",
    '.gncj-teaser-btn{-webkit-appearance:none;appearance:none;flex:none;min-height:44px;padding:0 1.1rem;border:0;border-radius:999px;background:#CC4715;color:#fff;font:700 .85rem/1 Inter,-apple-system,sans-serif;cursor:pointer;transition:background .2s,transform .2s}',
    '.gncj-teaser-btn:hover{background:#E85A24}',
    '.gncj-teaser-btn:active{transform:scale(.97)}',
    '.gncj-teaser-btn:focus-visible{outline:2px solid #F5E9D0;outline-offset:2px}',

    /* Story */
    '.gncj-ov{position:fixed;inset:0;top:0;left:0;right:0;bottom:0;z-index:100000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.9);animation:gncj-in .25s ease-out both}',
    '.gncj-ov.is-closing{animation:gncj-out .2s ease-in both}',
    '@keyframes gncj-in{from{opacity:0}to{opacity:1}}',
    '@keyframes gncj-out{from{opacity:1}to{opacity:0}}',
    '.gncj-story{position:relative;width:100vw;height:100vh;height:100dvh;overflow:hidden;background:#0A0A0A;color:#F5E9D0;font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;touch-action:none;outline:none;-webkit-user-select:none;user-select:none;transition:transform .25s ease,opacity .25s ease;container-type:inline-size}',
    '.gncj-story.is-drag{transition:none}',
    '@media (min-width:640px) and (min-height:640px){.gncj-story{width:auto;height:min(92vh,820px);aspect-ratio:9/16;border-radius:22px;box-shadow:0 30px 80px rgba(0,0,0,.6)}}',
    '.gncj-bars{position:absolute;left:12px;right:12px;top:calc(10px + env(safe-area-inset-top,0px));display:flex;gap:4px;z-index:6;pointer-events:none}',
    '.gncj-bar{flex:1;height:3px;border-radius:3px;background:rgba(245,233,208,.28);overflow:hidden}',
    '.gncj-bar i{display:block;height:100%;width:0;background:#F5E9D0;border-radius:3px}',
    '.gncj-bar.is-done i{width:100%}',
    '.gncj-bar.is-active i{width:100%}',
    '.gncj-ov.is-auto .gncj-bar.is-active i{width:0;animation:gncj-fill var(--gncj-dur,6.5s) linear forwards}',
    '.gncj-ov.is-paused .gncj-bar.is-active i{animation-play-state:paused}',
    '@keyframes gncj-fill{from{width:0}to{width:100%}}',
    '.gncj-top{position:absolute;left:16px;right:6px;top:calc(20px + env(safe-area-inset-top,0px));display:flex;align-items:center;justify-content:space-between;z-index:6;pointer-events:none}',
    ".gncj-brand{font-family:'Bowlby One',Impact,sans-serif;font-size:.8rem;letter-spacing:.04em;color:rgba(245,233,208,.85)}",
    '.gncj-x{-webkit-appearance:none;appearance:none;pointer-events:auto;width:44px;height:44px;display:flex;align-items:center;justify-content:center;border:0;border-radius:50%;background:rgba(10,10,10,.35);color:#F5E9D0;cursor:pointer;padding:0}',
    '.gncj-x:focus-visible{outline:2px solid #FF7A3D;outline-offset:2px}',
    '.gncj-x svg{width:20px;height:20px}',
    '.gncj-tap{-webkit-appearance:none;appearance:none;position:absolute;top:0;bottom:0;z-index:3;margin:0;padding:0;border:0;background:transparent;cursor:pointer;-webkit-tap-highlight-color:transparent}',
    '.gncj-tap-prev{left:0;width:30%}',
    '.gncj-tap-next{right:0;width:70%}',
    '.gncj-tap:focus-visible{outline:2px solid #FF7A3D;outline-offset:-8px;border-radius:18px}',
    '.gncj-slides{position:absolute;top:0;left:0;right:0;bottom:0;z-index:2;pointer-events:none}',
    '.gncj-slide{position:absolute;top:0;left:0;right:0;bottom:0;display:flex;flex-direction:column;justify-content:center;padding:calc(88px + env(safe-area-inset-top,0px)) 28px calc(44px + env(safe-area-inset-bottom,0px));box-sizing:border-box;opacity:0;visibility:hidden;transform:translateX(8%);transition:opacity .4s ease,transform .5s cubic-bezier(.2,.8,.2,1),visibility 0s linear .5s}',
    '.gncj-slide.is-past{transform:translateX(-8%)}',
    '.gncj-slide.is-active{opacity:1;visibility:visible;transform:none;transition-delay:0s}',
    '.gncj-ov.is-rm .gncj-slide{transform:none;transition:opacity .35s ease,visibility 0s linear .35s}',
    '.gncj-ov.is-rm .gncj-slide.is-active{transition-delay:0s}',
    '.gncj-inner{width:100%;max-width:24rem;margin:0 auto;text-align:center}',
    '.gncj-kick{margin:0 0 .6rem;font-size:.78rem;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#FF7A3D}',
    ".gncj-year{margin:0 0 1.4rem;font-family:'Bowlby One',Impact,sans-serif;font-weight:400;font-size:clamp(3.4rem,17vw,5.6rem);font-size:clamp(3.4rem,17cqi,5.6rem);line-height:.95;color:#FF7A3D;background:linear-gradient(180deg,#FF7A3D,#E85A24);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}",
    ".gncj-big{margin:0;font-family:'Bowlby One',Impact,sans-serif;font-weight:400;font-size:clamp(5rem,30vw,8.6rem);font-size:clamp(5rem,30cqi,8.6rem);line-height:.95;color:#F5E9D0;font-variant-numeric:tabular-nums}",
    ".gncj-lbl{margin:.35rem 0 0;font-family:'Bowlby One',Impact,sans-serif;font-weight:400;text-transform:uppercase;font-size:1.35rem;line-height:1.15;color:#F5E9D0}",
    '.gncj-sub{margin:.9rem 0 0;font-size:1rem;font-weight:500;line-height:1.45;color:#E6D9BC}',
    ".gncj-head2{margin:0;font-family:'Bowlby One',Impact,sans-serif;font-weight:400;text-transform:uppercase;letter-spacing:0;text-wrap:balance;font-size:clamp(1.9rem,9vw,2.7rem);font-size:clamp(1.9rem,9cqi,2.7rem);line-height:1.08;color:#F5E9D0;overflow-wrap:break-word;-webkit-hyphens:auto;hyphens:auto}",
    '.gncj-head2.gncj-long{font-size:clamp(1.45rem,6.6vw,2.05rem);font-size:clamp(1.45rem,6.6cqi,2.05rem)}',
    '.gncj-pic{position:relative;display:block;width:min(56vw,13rem);height:min(56vw,13rem);width:min(56cqi,13rem);height:min(56cqi,13rem);margin:0 auto 1.4rem;border-radius:50%;overflow:hidden;background:#140b07;border:4px solid #E85A24;box-shadow:0 0 0 10px rgba(232,90,36,.18),0 24px 60px rgba(0,0,0,.5)}',
    /* Produktbilder haben einen eigenen Rahmen und das Logo unten: Mitte vergroessern */
    '.gncj-pic img{position:absolute;left:-30%;top:-28%;width:160%;height:160%;max-width:none;object-fit:cover}',
    '.gncj-emoji{display:block;font-size:clamp(4.4rem,24vw,6.4rem);font-size:clamp(4.4rem,24cqi,6.4rem);line-height:1;margin:0 0 1.2rem}',
    '.gncj-rows{list-style:none;margin:1.2rem 0 0;padding:0;text-align:left;display:grid;gap:.7rem}',
    '.gncj-row{display:flex;flex-direction:column;gap:.15rem;padding:.85rem 1rem;border-radius:14px;background:rgba(28,28,28,.92);border:1px solid #2A2520}',
    '.gncj-row-k{font-size:.7rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#9A8E7A}',
    ".gncj-row-v{font-family:'Bowlby One',Impact,sans-serif;font-weight:400;text-transform:uppercase;font-size:1.35rem;line-height:1.15;color:#F5E9D0}",
    '.gncj-earned{list-style:none;margin:1.3rem auto 0;padding:0;display:flex;flex-wrap:wrap;justify-content:center;gap:.5rem;max-width:22rem}',
    '.gncj-big-s{font-size:clamp(2.6rem,14vw,4.2rem);font-size:clamp(2.6rem,14cqi,4.2rem);white-space:nowrap;text-transform:uppercase}',
    '.gncj-earned li{display:flex;align-items:center;gap:.35rem;padding:.4rem .7rem;border-radius:999px;background:rgba(28,28,28,.9);border:1px solid rgba(232,90,36,.55);font-size:.78rem;font-weight:700;color:#F5E9D0}',
    '.gncj-rise{animation:none}',
    '.gncj-slide.is-active .gncj-rise{animation:gncj-rise .7s cubic-bezier(.2,.8,.2,1) both}',
    '.gncj-ov.is-rm .gncj-slide.is-active .gncj-rise{animation:none}',
    '@keyframes gncj-rise{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}',
    '.gncj-s0{background:radial-gradient(120% 70% at 50% 0%,rgba(232,90,36,.6),rgba(232,90,36,0) 62%),#0A0A0A}',
    '.gncj-s1{background:radial-gradient(90% 60% at 50% 38%,rgba(255,122,61,.38),rgba(255,122,61,0) 66%),linear-gradient(180deg,#1d0f08,#0A0A0A)}',
    '.gncj-s2.dp-mittag{background:radial-gradient(85% 55% at 50% 30%,rgba(255,201,60,.34),rgba(255,201,60,0) 70%),#0A0A0A}',
    '.gncj-s2.dp-nachmittag{background:radial-gradient(85% 55% at 50% 30%,rgba(255,122,61,.42),rgba(255,122,61,0) 70%),#0A0A0A}',
    '.gncj-s2.dp-abend{background:radial-gradient(85% 55% at 50% 30%,rgba(139,46,15,.7),rgba(139,46,15,0) 72%),linear-gradient(180deg,#0e0c16,#0A0A0A)}',
    '.gncj-s3{background:repeating-linear-gradient(135deg,rgba(232,90,36,.07) 0 22px,rgba(232,90,36,0) 22px 44px),linear-gradient(160deg,#1C1C1C,#0A0A0A)}',
    '.gncj-s4{background:radial-gradient(110% 60% at 50% 100%,rgba(232,90,36,.5),rgba(232,90,36,0) 70%),#0A0A0A}',
    '.gncj-s5{justify-content:flex-start;padding-top:calc(22vh + env(safe-area-inset-top,0px));background:linear-gradient(170deg,#CC4715 0%,#8B2E0F 62%,#2a0f05 100%)}',
    '.gncj-s5 .gncj-kick{color:#F5E9D0}',
    '.gncj-actions{position:absolute;left:0;right:0;bottom:0;z-index:4;display:flex;flex-direction:column;gap:.6rem;padding:0 24px calc(28px + env(safe-area-inset-bottom,0px));opacity:0;visibility:hidden;transition:opacity .3s ease,visibility 0s linear .3s}',
    '.gncj-ov.is-last .gncj-actions{opacity:1;visibility:visible;transition-delay:0s}',
    '.gncj-btn{-webkit-appearance:none;appearance:none;min-height:52px;padding:0 1.2rem;border-radius:999px;font:700 1rem/1 Inter,-apple-system,sans-serif;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:.5rem;transition:transform .2s,background .2s}',
    '.gncj-btn:active{transform:scale(.98)}',
    '.gncj-btn:focus-visible{outline:2px solid #F5E9D0;outline-offset:3px}',
    '.gncj-btn-p{border:0;background:#F5E9D0;color:#0A0A0A}',
    '.gncj-btn-s{border:1.5px solid rgba(245,233,208,.7);background:transparent;color:#F5E9D0}',
    '.gncj-btn[disabled]{opacity:.6;cursor:progress}',
    '.gncj-status{min-height:1.2em;margin:0;text-align:center;font-size:.8rem;color:#F5E9D0}',
    '.gncj-sv{position:absolute;top:0;left:0;right:0;bottom:0;z-index:8;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;padding:calc(24px + env(safe-area-inset-top,0px)) 20px calc(24px + env(safe-area-inset-bottom,0px));background:rgba(10,10,10,.97);overflow:auto;touch-action:pan-y;-webkit-user-select:auto;user-select:auto;-webkit-touch-callout:default}',
    '.gncj-sv img{display:block;max-width:100%;max-height:68vh;width:auto;height:auto;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.6)}',
    '.gncj-sv p{margin:0;max-width:22rem;text-align:center;font-size:.86rem;line-height:1.45;color:#E6D9BC}',
    '@media (prefers-reduced-motion:reduce){.gncj-ov,.gncj-ov.is-closing,.gncj-slide.is-active .gncj-rise{animation:none}.gncj-bb,.gncj-teaser-btn,.gncj-btn,.gncj-story{transition:none}}'
  ].join('\n');

  function stilEinfuegen() {
    if (doc.getElementById('gncj-style')) return;
    var st = doc.createElement('style');
    st.id = 'gncj-style';
    st.appendChild(doc.createTextNode(CSS));
    (doc.head || doc.documentElement).appendChild(st);
  }

  /* ------------------------------------------------------------------
     ABZEICHEN IM KONTO
     ------------------------------------------------------------------ */
  var uid = 0;

  function renderBadges(container) {
    if (!container || typeof container.appendChild !== 'function') return Promise.resolve(null);
    stilEinfuegen();
    if (!konto()) { container.innerHTML = ''; return Promise.resolve(null); }
    var id = 'gncj' + (++uid);
    container.innerHTML = '<section class="gncj-sec" aria-labelledby="' + id + 'h" aria-busy="true">'
      + '<div class="gncj-head"><h4 class="gncj-h" id="' + id + 'h">' + esc(T('badges_h')) + '</h4></div>'
      + '<p class="gncj-load">' + esc(T('loading')) + '</p></section>';
    return load().then(function (d) {
      if (!d) { container.innerHTML = ''; return null; }
      zeichneAbzeichen(container, d, id);
      return d;
    }, function () {
      container.innerHTML = '<section class="gncj-sec" aria-labelledby="' + id + 'h">'
        + '<div class="gncj-head"><h4 class="gncj-h" id="' + id + 'h">' + esc(T('badges_h')) + '</h4></div>'
        + '<p class="gncj-load">' + esc(T('error')) + '</p></section>';
      return null;
    });
  }

  function zeichneAbzeichen(container, d, id) {
    var list = d.badges || [];
    var erreicht = 0;
    var i;
    for (i = 0; i < list.length; i++) if (list[i].earned) erreicht++;

    var h = '<section class="gncj-sec" aria-labelledby="' + id + 'h">';
    if (opts.teaser !== false && available()) {
      h += '<div class="gncj-teaser">'
        + '<div class="gncj-teaser-t"><span class="gncj-teaser-k">' + esc(T('teaser_kicker')) + '</span>'
        + '<span class="gncj-teaser-n">' + esc(T('teaser_title', { year: d.year })) + '</span></div>'
        + '<button type="button" class="gncj-teaser-btn" data-gncj="open">' + esc(T('teaser_btn')) + '</button>'
        + '</div>';
    }
    h += '<div class="gncj-head"><h4 class="gncj-h" id="' + id + 'h">' + esc(T('badges_h')) + '</h4>'
      + '<span class="gncj-count">' + esc(T('count', { n: num(erreicht), total: num(list.length) })) + '</span></div>';
    h += '<ul class="gncj-grid">';
    for (i = 0; i < list.length; i++) {
      var b = list[i];
      var tt = badgeText(b);
      var need = Math.max(1, b.need || 1);
      var have = Math.min(need, Math.max(0, b.have || 0));
      var label = b.earned
        ? T('aria_earned', { title: tt[0], desc: tt[1] })
        : T('aria_progress', { title: tt[0], have: num(have), need: num(need), desc: tt[1] });
      var pct = Math.round(have / need * 100);
      h += '<li class="gncj-b' + (b.earned ? ' is-earned' : '') + '">'
        + '<button type="button" class="gncj-bb" data-i="' + i + '" aria-label="' + esc(label) + '">'
        + '<span class="gncj-ico" aria-hidden="true">' + icoSvg(b.id) + '</span>'
        + '<span class="gncj-bn" aria-hidden="true">' + esc(tt[0]) + '</span>'
        + (b.earned
          ? '<span class="gncj-bp" aria-hidden="true">' + esc(T('earned')) + '</span>'
          : '<span class="gncj-bp" aria-hidden="true">' + esc(num(have) + '/' + num(need)) + '</span>'
            + '<span class="gncj-track" aria-hidden="true"><i style="width:' + pct + '%"></i></span>')
        + '</button></li>';
    }
    h += '</ul><p class="gncj-detail" aria-hidden="true"></p></section>';
    container.innerHTML = h;

    var det = container.querySelector('.gncj-detail');
    var knoepfe = container.querySelectorAll('.gncj-bb');
    for (i = 0; i < knoepfe.length; i++) {
      knoepfe[i].addEventListener('click', function (ev) {
        var btn = ev.currentTarget;
        var b2 = list[Number(btn.getAttribute('data-i'))];
        if (!b2) return;
        for (var j = 0; j < knoepfe.length; j++) knoepfe[j].className = knoepfe[j].className.replace(/\s*is-sel/g, '');
        btn.className += ' is-sel';
        var t2 = badgeText(b2);
        var stand = b2.earned ? T('earned') : (num(Math.min(b2.need, b2.have)) + '/' + num(b2.need));
        if (det) det.textContent = t2[0] + ': ' + t2[1] + ' (' + stand + ')';
      });
    }
    var oeffner = container.querySelector('[data-gncj="open"]');
    if (oeffner) oeffner.addEventListener('click', function () { open(); });
  }

  /* ------------------------------------------------------------------
     STORY
     ------------------------------------------------------------------ */
  var st = null;   // Zustand, solange die Story offen ist

  function earnedImJahr(d) {
    var out = [];
    var list = d.badges || [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b.earned) continue;
      if (b.scope === 'year') { if (b.year === d.year) out.push(b); continue; }
      if (!b.earnedAt || String(b.earnedAt).slice(0, 4) === String(d.year)) out.push(b);
    }
    return out;
  }

  /* Ein Element mit Einblend-Animation. n = Reihenfolge (Verzoegerung). */
  function teil(name, cls, n, inner, extra) {
    return '<' + name + ' class="' + cls + ' gncj-rise" style="animation-delay:' + (n * 90) + 'ms"'
      + (extra ? ' ' + extra : '') + '>' + inner + '</' + name + '>';
  }

  function folien(d) {
    var r = d.review || {};
    var y = d.year;
    var out = [];

    if (!r.orders) {
      out.push({ cls: 'gncj-s0', html:
        teil('p', 'gncj-kick', 0, esc(T('s1_kicker')))
        + teil('p', 'gncj-year', 1, esc(y))
        + teil('h3', 'gncj-head2', 2, esc(T('empty_title', { year: y })))
        + teil('p', 'gncj-sub', 3, esc(T('empty_sub'))) });
      out.push({ cls: 'gncj-s5', html:
        teil('h3', 'gncj-head2', 0, esc(T('s6_title')))
        + teil('p', 'gncj-sub', 1, esc(T('s6_sub'))) });
      return out;
    }

    // 1. Anzahl
    var ordersWort = T(r.orders === 1 ? 'orders_one' : 'orders_other');
    var unter = T('sub_line', { burgers: plural('burgers', r.burgers || 0), days: plural('days', r.distinctDays || 0) });
    out.push({ cls: 'gncj-s0', html:
      teil('p', 'gncj-kick', 0, esc(T('s1_kicker')))
      + teil('p', 'gncj-year', 1, esc(y))
      + teil('p', 'gncj-big gncj-num', 2, esc(num(r.orders)), 'aria-hidden="true"')
      + teil('p', 'gncj-lbl', 3, esc(ordersWort), 'aria-hidden="true"')
      + '<p class="gncj-sr">' + esc(num(r.orders) + ' ' + ordersWort) + '</p>'
      + ((r.burgers || r.distinctDays) ? teil('p', 'gncj-sub', 4, esc(unter)) : '') });

    // 2. Favorit
    var fav = r.favorite;
    var bild = produktBild(fav);
    out.push({ cls: 'gncj-s1', html: fav
      ? teil('p', 'gncj-kick', 0, esc(T('s2_kicker')))
        + (bild ? teil('span', 'gncj-pic', 1, '<img src="' + esc(bild) + '" alt="" draggable="false">', 'aria-hidden="true"') : '')
        + teil('h3', 'gncj-head2' + (produktName(fav).length > 16 ? ' gncj-long' : ''), 2, esc(produktName(fav)))
        + teil('p', 'gncj-sub', 3, esc(plural('times', fav.qty || 0)))
      : teil('p', 'gncj-kick', 0, esc(T('s2_kicker')))
        + teil('span', 'gncj-emoji', 1, '🍔', 'aria-hidden="true"')
        + teil('h3', 'gncj-head2', 2, esc(T('s2_none'))) });

    // 3. Tageszeit
    if (r.daypart) {
      var ico = { mittag: '☀️', nachmittag: '🌤️', abend: '🌙' }[r.daypart] || '🍔';
      out.push({ cls: 'gncj-s2 dp-' + r.daypart, html:
        teil('p', 'gncj-kick', 0, esc(T('s3_kicker')))
        + teil('span', 'gncj-emoji', 1, ico, 'aria-hidden="true"')
        + teil('h3', 'gncj-head2', 2, esc(T('dp_' + r.daypart)))
        + teil('p', 'gncj-sub', 3, esc(T('dp_' + r.daypart + '_sub'))) });
    }

    // 4. Rhythmus
    var zeilen = [];
    if (r.topWeekday != null) zeilen.push([T('fav_day'), wochentag(r.topWeekday)]);
    if (r.topMonth) zeilen.push([T('fav_month'), monat(r.topMonth)]);
    if (r.longestWeekStreak >= 2) zeilen.push([T('streak'), plural('weeks', r.longestWeekStreak)]);
    if (r.firstAt) zeilen.push([T('first'), datumLang(r.firstAt)]);
    if (zeilen.length) {
      var rows = '';
      for (var i = 0; i < zeilen.length; i++) {
        rows += teil('li', 'gncj-row', i + 1,
          '<span class="gncj-row-k">' + esc(zeilen[i][0]) + '</span>'
          + '<span class="gncj-row-v">' + esc(zeilen[i][1]) + '</span>');
      }
      out.push({ cls: 'gncj-s3', html:
        teil('p', 'gncj-kick', 0, esc(T('s4_kicker')))
        + '<ul class="gncj-rows">' + rows + '</ul>' });
    }

    // 5. Abzeichen
    var ab = earnedImJahr(d);
    var total = (d.badges || []).length;
    var chips = '';
    for (var j = 0; j < ab.length; j++) {
      chips += teil('li', 'gncj-chip', 3 + j,
        '<span class="gncj-chip-ico" aria-hidden="true">' + icoSvg(ab[j].id) + '</span>' + esc(badgeText(ab[j])[0]));
    }
    out.push({ cls: 'gncj-s4', html: ab.length
      ? teil('p', 'gncj-kick', 0, esc(T('s5_kicker')))
        + teil('p', 'gncj-big gncj-big-s', 1, esc(T('s5_big', { n: num(ab.length), total: num(total) })))
        + teil('p', 'gncj-lbl', 2, esc(T('s5_sub')))
        + '<ul class="gncj-earned">' + chips + '</ul>'
      : teil('p', 'gncj-kick', 0, esc(T('s5_kicker')))
        + teil('span', 'gncj-emoji', 1, '🏅', 'aria-hidden="true"')
        + teil('h3', 'gncj-head2', 2, esc(T('s5_none'))) });

    // 6. Danke
    out.push({ cls: 'gncj-s5', share: true, html:
      teil('p', 'gncj-kick', 0, esc(T('story_label', { year: y })))
      + teil('h3', 'gncj-head2', 1, esc(T('s6_title')))
      + teil('p', 'gncj-sub', 2, esc(T('s6_sub'))) });
    return out;
  }

  function open() {
    stilEinfuegen();
    if (st) return Promise.resolve(true);
    return load().then(function (d) {
      if (!d || st) return !!st;
      aufbauen(d);
      return true;
    }, function () { return false; });
  }

  function aufbauen(d) {
    var liste = folien(d);
    var n = liste.length;
    var rm = reducedMotion();
    var auto = !rm;
    var ov = doc.createElement('div');
    ov.className = 'gncj-ov' + (rm ? ' is-rm' : '') + (auto ? ' is-auto' : '');
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-labelledby', 'gncjStoryTitle');
    ov.setAttribute('lang', curLang());
    try { ov.style.setProperty('--gncj-dur', (DAUER_MS / 1000) + 's'); } catch (e) {}

    var bars = '';
    var slides = '';
    for (var i = 0; i < n; i++) {
      bars += '<span class="gncj-bar"><i></i></span>';
      slides += '<section class="gncj-slide ' + liste[i].cls + (i === 0 ? ' is-active' : ' is-future') + '"'
        + ' role="group" aria-roledescription="' + esc(T('slide')) + '"'
        + ' aria-label="' + esc(T('slide_of', { n: i + 1, total: n })) + '"'
        + (i === 0 ? '' : ' aria-hidden="true"') + '>'
        + '<div class="gncj-inner">' + liste[i].html + '</div></section>';
    }
    var teilen = liste[n - 1].share;
    ov.innerHTML = '<div class="gncj-story" tabindex="-1">'
      + '<div class="gncj-bars" aria-hidden="true">' + bars + '</div>'
      + '<h2 class="gncj-sr" id="gncjStoryTitle">' + esc(T('story_label', { year: d.year })) + '</h2>'
      + '<div class="gncj-top"><span class="gncj-brand" aria-hidden="true">Grill\'n Chill</span>'
      + '<button type="button" class="gncj-x" aria-label="' + esc(T('close')) + '">'
      + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg>'
      + '</button></div>'
      + '<button type="button" class="gncj-tap gncj-tap-prev" aria-label="' + esc(T('prev')) + '"></button>'
      + '<button type="button" class="gncj-tap gncj-tap-next" aria-label="' + esc(T('next')) + '"></button>'
      + '<div class="gncj-slides">' + slides + '</div>'
      + '<div class="gncj-actions">'
      + (teilen ? '<button type="button" class="gncj-btn gncj-btn-p" data-gncj="share">' + esc(T('share')) + '</button>' : '')
      + '<button type="button" class="gncj-btn gncj-btn-s" data-gncj="close">' + esc(T('close')) + '</button>'
      + '<p class="gncj-status" aria-live="polite"></p>'
      + '</div>'
      + '<p class="gncj-sr gncj-live" aria-live="polite"></p>'
      + '</div>';

    st = {
      d: d, ov: ov, n: n, i: -1, rm: rm, auto: auto, manuell: false,
      story: ov.querySelector('.gncj-story'),
      slides: ov.querySelectorAll('.gncj-slide'),
      bars: ov.querySelectorAll('.gncj-bar'),
      live: ov.querySelector('.gncj-live'),
      status: ov.querySelector('.gncj-status'),
      vorFokus: doc.activeElement,
      overflow: [doc.documentElement.style.overflow, doc.body ? doc.body.style.overflow : ''],
      ptr: null, sperre: 0, pause: {}, share: null, shareP: null, sv: null, zaehlt: false
    };
    for (i = 0; i < n; i++) if (i > 0) setzeInert(st.slides[i], true);

    doc.documentElement.style.overflow = 'hidden';
    if (doc.body) doc.body.style.overflow = 'hidden';
    doc.body.appendChild(ov);

    // Ereignisse
    ov.querySelector('.gncj-x').addEventListener('click', close);
    ov.querySelector('[data-gncj="close"]').addEventListener('click', close);
    var shareBtn = ov.querySelector('[data-gncj="share"]');
    if (shareBtn) shareBtn.addEventListener('click', function () { teilenKlick(shareBtn); });
    ov.querySelector('.gncj-tap-prev').addEventListener('click', function () { if (!gesperrt()) zurueck(); });
    ov.querySelector('.gncj-tap-next').addEventListener('click', function () { if (!gesperrt()) weiter(); });
    st.story.addEventListener('pointerdown', zeigerRunter);
    st.story.addEventListener('pointermove', zeigerZiehen);
    st.story.addEventListener('pointerup', zeigerHoch);
    st.story.addEventListener('pointercancel', zeigerAbbruch);
    st.story.addEventListener('animationend', function (ev) {
      if (!st || !st.auto || st.manuell) return;
      var bar = st.bars[st.i];
      if (bar && ev.target === bar.firstChild && ev.animationName === 'gncj-fill') weiter();
    });
    st.taste = tasteGedrueckt;
    doc.addEventListener('keydown', st.taste, true);
    st.sicht = function () { pausieren('hidden', doc.hidden); };
    doc.addEventListener('visibilitychange', st.sicht);

    gehe(0);
    try { st.story.focus({ preventScroll: true }); } catch (e) { st.story.focus(); }
  }

  function setzeInert(el, an) {
    if (an) { el.setAttribute('aria-hidden', 'true'); el.setAttribute('inert', ''); }
    else { el.removeAttribute('aria-hidden'); el.removeAttribute('inert'); }
  }

  function gehe(i) {
    if (!st) return;
    if (i < 0) i = 0;
    if (i > st.n - 1) { close(); return; }
    var alt = st.i;
    st.i = i;
    for (var j = 0; j < st.n; j++) {
      var s = st.slides[j];
      s.className = s.className.replace(/\s*is-(active|past|future)/g, '') + (j === i ? ' is-active' : (j < i ? ' is-past' : ' is-future'));
      setzeInert(s, j !== i);
      var b = st.bars[j];
      b.className = 'gncj-bar' + (j < i ? ' is-done' : (j === i ? ' is-active' : ''));
    }
    // Fortschritts-Animation neu starten (auch beim Zuruecklaufen)
    var akt = st.bars[i] && st.bars[i].firstChild;
    if (akt) { akt.style.animation = 'none'; void akt.offsetWidth; akt.style.animation = ''; }

    var letzte = i === st.n - 1;
    st.ov.className = st.ov.className.replace(/\s*is-last/g, '') + (letzte ? ' is-last' : '');
    // Auf der letzten Folie laeuft nichts mehr von selbst
    autoSetzen(st.auto && !st.manuell && !letzte);

    if (i === 0 && !st.zaehlt) { st.zaehlt = true; hochzaehlen(); }
    // Teilen-Bild frueh vorbereiten: dann laeuft navigator.share noch im
    // Klick (Safari verlangt das) und muss nicht erst auf das Canvas warten
    if (i >= st.n - 2 && !st.shareP && st.ov.querySelector('[data-gncj="share"]')) {
      var d = st.d;
      st.shareP = bildErstellen(d).then(function (r) { if (st && st.d === d) st.share = r; return r; }, function () { return null; });
    }
    if (alt !== i && st.live) st.live.textContent = T('slide_of', { n: i + 1, total: st.n }) + '. ' + vorlesetext(st.slides[i]);
  }

  /* Text einer Folie fuer die Ansage, ohne rein optische Teile */
  function vorlesetext(el) {
    var c = el.cloneNode(true);
    var weg = c.querySelectorAll('[aria-hidden="true"]');
    for (var i = 0; i < weg.length; i++) if (weg[i].parentNode) weg[i].parentNode.removeChild(weg[i]);
    // Absaetze nicht zusammenkleben: hinter jedes Element ein Leerzeichen
    var alle = c.querySelectorAll('*');
    for (i = 0; i < alle.length; i++) alle[i].appendChild(doc.createTextNode(' '));
    return (c.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function autoSetzen(an) {
    if (!st) return;
    st.ov.className = st.ov.className.replace(/\s*is-auto/g, '') + (an ? ' is-auto' : '');
  }
  function weiter() { if (st) gehe(st.i + 1); }
  function zurueck() { if (st) gehe(st.i - 1); }
  function gesperrt() { return st && (Date.now() - st.sperre < 450); }

  function pausieren(grund, an) {
    if (!st) return;
    if (an) st.pause[grund] = true; else delete st.pause[grund];
    var irgendwas = false;
    for (var k in st.pause) if (Object.prototype.hasOwnProperty.call(st.pause, k)) irgendwas = true;
    st.ov.className = st.ov.className.replace(/\s*is-paused/g, '') + (irgendwas ? ' is-paused' : '');
  }

  function hochzaehlen() {
    if (!st || st.rm || !window.requestAnimationFrame) return;
    var el = st.ov.querySelector('.gncj-num');
    var ziel = (st.d.review && st.d.review.orders) || 0;
    if (!el || ziel < 2) return;
    var t0 = null, dauer = 1000;
    var schritt = function (t) {
      if (!st) return;
      if (t0 === null) t0 = t;
      var p = Math.min(1, (t - t0) / dauer);
      var e = 1 - Math.pow(1 - p, 3);
      el.textContent = num(Math.round(ziel * e));
      if (p < 1) window.requestAnimationFrame(schritt);
    };
    el.textContent = num(0);
    window.requestAnimationFrame(schritt);
  }

  /* --- Gesten ---------------------------------------------------------- */
  function zeigerRunter(ev) {
    if (!st || st.sv) return;
    if (ev.button != null && ev.button > 0) return;
    st.ptr = { x: ev.clientX, y: ev.clientY, t: Date.now(), id: ev.pointerId, dy: 0 };
    pausieren('halten', true);
  }
  function zeigerZiehen(ev) {
    if (!st || !st.ptr || ev.pointerId !== st.ptr.id) return;
    var dx = ev.clientX - st.ptr.x, dy = ev.clientY - st.ptr.y;
    st.ptr.dy = dy;
    if (!st.rm && dy > 8 && dy > Math.abs(dx)) {
      st.story.className = st.story.className.replace(/\s*is-drag/g, '') + ' is-drag';
      st.story.style.transform = 'translateY(' + Math.round(dy * 0.6) + 'px) scale(' + Math.max(0.9, 1 - dy / 2000) + ')';
      st.story.style.opacity = String(Math.max(0.4, 1 - dy / 600));
    }
  }
  function zuruecksetzenZug() {
    if (!st) return;
    st.story.className = st.story.className.replace(/\s*is-drag/g, '');
    st.story.style.transform = '';
    st.story.style.opacity = '';
  }
  function zeigerHoch(ev) {
    if (!st || !st.ptr || ev.pointerId !== st.ptr.id) return;
    var dx = ev.clientX - st.ptr.x, dy = ev.clientY - st.ptr.y;
    var dauer = Date.now() - st.ptr.t;
    st.ptr = null;
    zuruecksetzenZug();
    pausieren('halten', false);
    if (dy > 90 && dy > Math.abs(dx) * 1.2) { st.sperre = Date.now(); close(); return; }
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      st.sperre = Date.now();
      if (dx < 0) weiter(); else zurueck();
      return;
    }
    // Langes Halten pausiert nur und blaettert beim Loslassen nicht
    if (dauer > 400 || Math.abs(dx) > 12 || Math.abs(dy) > 12) st.sperre = Date.now();
  }
  function zeigerAbbruch() {
    if (!st) return;
    st.ptr = null;
    zuruecksetzenZug();
    pausieren('halten', false);
  }

  /* --- Tastatur und Fokusfalle ---------------------------------------- */
  function fokussierbar() {
    if (!st) return [];
    var alle = st.ov.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    var out = [];
    for (var i = 0; i < alle.length; i++) {
      var el = alle[i];
      if (el.disabled) continue;
      if (!el.getClientRects().length) continue;
      try {
        var cs = window.getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      } catch (e) {}
      if (st.sv && !st.sv.contains(el)) continue;
      out.push(el);
    }
    return out;
  }
  function tasteGedrueckt(ev) {
    if (!st) return;
    var k = ev.key;
    if (k === 'Escape' || k === 'Esc') {
      ev.preventDefault();
      ev.stopPropagation();
      if (st.sv) bildSchliessen(); else close();
      return;
    }
    if (k === 'Tab') {
      var f = fokussierbar();
      if (!f.length) { ev.preventDefault(); return; }
      var erst = f[0], letzt = f[f.length - 1];
      var a = doc.activeElement;
      var drin = st.ov.contains(a);
      if (ev.shiftKey && (a === erst || !drin || a === st.story)) { ev.preventDefault(); letzt.focus(); }
      else if (!ev.shiftKey && (a === letzt || !drin)) { ev.preventDefault(); erst.focus(); }
      return;
    }
    if (st.sv) return;
    // Wer mit der Tastatur blaettert, bekommt kein automatisches Weiterblaettern mehr
    if ((k === 'Enter' || k === ' ' || k === 'Spacebar') && ev.target && /gncj-tap/.test(ev.target.className || '')) {
      st.manuell = true;
      return;
    }
    if (k === 'ArrowRight' || k === 'PageDown') { ev.preventDefault(); st.manuell = true; weiter(); }
    else if (k === 'ArrowLeft' || k === 'PageUp') { ev.preventDefault(); st.manuell = true; zurueck(); }
  }

  function close() {
    if (!st) return;
    var s = st;
    st = null;
    doc.removeEventListener('keydown', s.taste, true);
    doc.removeEventListener('visibilitychange', s.sicht);
    var weg = function () {
      if (s.ov.parentNode) s.ov.parentNode.removeChild(s.ov);
      doc.documentElement.style.overflow = s.overflow[0] || '';
      if (doc.body) doc.body.style.overflow = s.overflow[1] || '';
      try { if (s.vorFokus && s.vorFokus.focus && doc.contains(s.vorFokus)) s.vorFokus.focus(); } catch (e) {}
    };
    if (s.rm) { weg(); return; }
    s.ov.className += ' is-closing';
    setTimeout(weg, 190);
  }

  /* ------------------------------------------------------------------
     TEILEN
     ------------------------------------------------------------------ */
  function teilenText(d) {
    var r = d.review || {};
    var t = T('share_text', { year: d.year, orders: num(r.orders || 0) + ' ' + T(r.orders === 1 ? 'orders_one' : 'orders_other') });
    if (r.favorite) t += ' ' + T('share_fav', { name: produktName(r.favorite) });
    return t + ' ' + seite();
  }

  function teilenKlick(btn) {
    if (!st) return;
    var d = st.d;
    var text = teilenText(d);
    if (st.share) { ausfuehren(st.share, text); return; }
    btn.disabled = true;
    if (st.status) st.status.textContent = T('share_busy');
    (st.shareP || bildErstellen(d)).then(function (r) {
      if (!st) return;
      btn.disabled = false;
      if (st.status) st.status.textContent = '';
      if (!r) { if (st.status) st.status.textContent = T('share_err'); return; }
      st.share = r;
      ausfuehren(r, text);
    }, function () {
      if (!st) return;
      btn.disabled = false;
      if (st.status) st.status.textContent = T('share_err');
    });
  }

  function ausfuehren(r, text) {
    var wk = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.gncShareImage;
    if (wk) {
      try { wk.postMessage({ dataUrl: r.dataUrl, text: text }); return; } catch (e) {}
    }
    if (r.file && navigator.share && navigator.canShare) {
      var nutz = { files: [r.file], text: text };
      var geht = false;
      try { geht = navigator.canShare(nutz); } catch (e2) {}
      if (geht) {
        pausieren('teilen', true);
        navigator.share(nutz).then(function () {
          pausieren('teilen', false);
        }, function (err) {
          pausieren('teilen', false);
          if (!err || err.name !== 'AbortError') bildZeigen(r);
        });
        return;
      }
    }
    bildZeigen(r);
  }

  function bildZeigen(r) {
    if (!st || st.sv) return;
    var sv = doc.createElement('div');
    sv.className = 'gncj-sv';
    sv.setAttribute('role', 'group');
    sv.setAttribute('aria-label', T('img_alt', { year: st.d.year }));
    sv.innerHTML = '<img src="' + r.dataUrl + '" alt="' + esc(T('img_alt', { year: st.d.year })) + '">'
      + '<p>' + esc(T('save_hint')) + '</p>'
      + '<button type="button" class="gncj-btn gncj-btn-s">' + esc(T('back')) + '</button>';
    st.story.appendChild(sv);
    st.sv = sv;
    pausieren('bild', true);
    var zur = sv.querySelector('button');
    zur.addEventListener('click', bildSchliessen);
    try { zur.focus({ preventScroll: true }); } catch (e) { zur.focus(); }
  }
  function bildSchliessen() {
    if (!st || !st.sv) return;
    st.sv.parentNode.removeChild(st.sv);
    st.sv = null;
    pausieren('bild', false);
    var b = st.ov.querySelector('[data-gncj="share"]');
    if (b) b.focus();
  }

  /* --- Bild 1080 x 1920 ------------------------------------------------- */
  var BOWLBY = "'Bowlby One', Impact, sans-serif";
  var INTER = "Inter, -apple-system, 'Segoe UI', Roboto, sans-serif";

  function schriftenBereit() {
    if (!doc.fonts || !doc.fonts.load) return Promise.resolve();
    var alle;
    try {
      alle = Promise.all([
        doc.fonts.load('400 80px "Bowlby One"'),
        doc.fonts.load('700 40px Inter'),
        doc.fonts.load('600 40px Inter'),
        doc.fonts.load('500 40px Inter')
      ]).then(function () { return doc.fonts.ready; });
    } catch (e) { return Promise.resolve(); }
    return Promise.race([alle, warte(2500)]).then(noop, noop);
  }
  function bildLaden(src, ms) {
    return new Promise(function (res) {
      if (!src) { res(null); return; }
      var img = new Image();
      var fertig = false;
      var ende = function (x) { if (!fertig) { fertig = true; res(x); } };
      setTimeout(function () { ende(null); }, ms);
      img.onload = function () { ende(img); };
      img.onerror = function () { ende(null); };
      img.src = src;
    });
  }
  function rundRechteck(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y);
    g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r);
    g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r);
    g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }
  function passend(g, text, maxB, start, min, gewicht, familie) {
    var s = start;
    for (; s > min; s -= 4) {
      g.font = gewicht + ' ' + s + 'px ' + familie;
      if (g.measureText(text).width <= maxB) return s;
    }
    g.font = gewicht + ' ' + min + 'px ' + familie;
    return min;
  }
  function kuerzen(g, text, maxB) {
    if (g.measureText(text).width <= maxB) return text;
    var t = String(text);
    while (t.length > 1 && g.measureText(t + '…').width > maxB) t = t.slice(0, -1);
    return t + '…';
  }
  function sperrung(g, px) {
    try { if ('letterSpacing' in g) g.letterSpacing = px + 'px'; } catch (e) {}
  }

  function karte(g, x, y, w, h, k, bilder) {
    g.save();
    rundRechteck(g, x, y, w, h, 36);
    g.fillStyle = 'rgba(28,28,28,0.94)';
    g.fill();
    g.lineWidth = 2;
    g.strokeStyle = 'rgba(232,90,36,0.4)';
    g.stroke();
    // Akzentbalken
    rundRechteck(g, x, y + 36, 8, h - 72, 4);
    g.fillStyle = '#E85A24';
    g.fill();

    var links = x + 52;
    var rechtsFrei = 0;
    var mitte = y + h / 2;

    // rechte Seite: Bild, Emojis oder Text
    if (k.bild) {
      var d = h - 48, bx = x + w - 40 - d, by = y + 24;
      g.save();
      g.beginPath();
      g.arc(bx + d / 2, by + d / 2, d / 2, 0, Math.PI * 2);
      g.closePath();
      g.clip();
      // wie in der Story: nur die Bildmitte, ohne Rahmen und Logo des Produktfotos
      var iw = k.bild.naturalWidth || k.bild.width, ih = k.bild.naturalHeight || k.bild.height;
      var seiteQ = Math.min(iw, ih) * 0.6;
      g.drawImage(k.bild, (iw - seiteQ) / 2, (ih - seiteQ) / 2, seiteQ, seiteQ, bx, by, d, d);
      g.restore();
      g.beginPath();
      g.arc(bx + d / 2, by + d / 2, d / 2, 0, Math.PI * 2);
      g.lineWidth = 6;
      g.strokeStyle = '#E85A24';
      g.stroke();
      rechtsFrei = d + 40;
    } else if (k.emojis && k.emojis.length) {
      // Abzeichen-Symbole als Linien (gleiche Pfade wie im Konto), rechtsbuendig
      var ex = x + w - 44;
      var zeigen = k.emojis.slice(0, 4);
      var gr = 58, sk = gr / 24;
      for (var i = zeigen.length - 1; i >= 0; i--) {
        var pf = icoPfade(zeigen[i]);
        g.save();
        g.translate(ex - gr, mitte - gr / 2);
        g.scale(sk, sk);
        g.lineWidth = 1.7;
        g.lineCap = 'round';
        g.lineJoin = 'round';
        g.strokeStyle = '#FF7A3D';
        for (var q = 0; q < pf.length; q++) {
          try { g.stroke(new window.Path2D(pf[q])); } catch (e) {}
        }
        g.restore();
        ex -= 74;
      }
      rechtsFrei = 74 * zeigen.length + 20;
    } else if (k.rechts) {
      g.textAlign = 'right';
      g.textBaseline = 'alphabetic';
      g.fillStyle = '#FF7A3D';
      passend(g, k.rechts, 330, 42, 26, 700, INTER);
      g.fillText(k.rechts, x + w - 44, y + 146);
      rechtsFrei = Math.min(330, g.measureText(k.rechts).width) + 40;
    }

    var breite = w - 52 - 40 - rechtsFrei;
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    g.fillStyle = '#9A8E7A';
    g.font = '700 30px ' + INTER;
    sperrung(g, 4);
    g.fillText(kuerzen(g, k.label, breite), links, y + 70);
    sperrung(g, 0);
    g.fillStyle = '#F5E9D0';
    passend(g, k.wert, breite, 84, 40, 400, BOWLBY);
    g.fillText(kuerzen(g, k.wert, breite), links, y + 156);
    g.restore();
  }

  function malen(g, W, H, d, bilder) {
    var r = d.review || {};
    g.fillStyle = '#0A0A0A';
    g.fillRect(0, 0, W, H);
    var gr = g.createRadialGradient(W / 2, -160, 40, W / 2, -160, 1300);
    gr.addColorStop(0, 'rgba(255,122,61,0.8)');
    gr.addColorStop(0.42, 'rgba(232,90,36,0.28)');
    gr.addColorStop(1, 'rgba(232,90,36,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);
    var gb = g.createRadialGradient(W * 0.88, H + 120, 20, W * 0.88, H + 120, 950);
    gb.addColorStop(0, 'rgba(139,46,15,0.6)');
    gb.addColorStop(1, 'rgba(139,46,15,0)');
    g.fillStyle = gb;
    g.fillRect(0, 0, W, H);

    if (bilder.logo) g.drawImage(bilder.logo, W / 2 - 88, 104, 176, 176);

    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    var kopf = versal(T('img_title'));
    g.fillStyle = '#F5E9D0';
    sperrung(g, 2);
    passend(g, kopf, 900, 80, 40, 400, BOWLBY);
    g.fillText(kopf, W / 2, 404);
    sperrung(g, 0);
    var yg = g.createLinearGradient(0, 450, 0, 700);
    yg.addColorStop(0, '#FF7A3D');
    yg.addColorStop(1, '#E85A24');
    g.fillStyle = yg;
    g.font = '400 300px ' + BOWLBY;
    g.fillText(String(d.year), W / 2, 700);

    var karten = [];
    karten.push({
      label: versal(T(r.orders === 1 ? 'orders_one' : 'orders_other')),
      wert: num(r.orders || 0),
      rechts: r.burgers ? plural('burgers', r.burgers) : ''
    });
    if (r.favorite) {
      karten.push({
        label: versal(T('lbl_fav')) + '  ' + num(r.favorite.qty || 0) + '×',
        wert: produktName(r.favorite),
        bild: bilder.fav || null
      });
    }
    if (r.topWeekday != null) {
      karten.push({
        label: versal(T('fav_day')),
        wert: wochentag(r.topWeekday),
        rechts: r.daypart ? T('dp_' + r.daypart) : ''
      });
    }
    var ab = earnedImJahr(d);
    var em = [];
    for (var i = 0; i < ab.length; i++) em.push(ab[i].id);
    karten.push({
      label: versal(T('badges_h')),
      wert: T('s5_big', { n: num(ab.length), total: num((d.badges || []).length) }),
      emojis: em
    });

    var cy = 780, ch = 196, gap = 26;
    for (i = 0; i < karten.length; i++) karte(g, 90, cy + i * (ch + gap), 900, ch, karten[i], bilder);

    g.textAlign = 'center';
    g.fillStyle = '#FF7A3D';
    g.font = '700 44px ' + INTER;
    g.fillText(seite(), W / 2, 1806);
    g.fillStyle = 'rgba(245,233,208,0.62)';
    g.font = '500 32px ' + INTER;
    g.fillText("Grill'n Chill Foodtruck Bielefeld", W / 2, 1860);
  }

  function zuBlob(c, dataUrl) {
    return new Promise(function (res) {
      if (c.toBlob) {
        try { c.toBlob(function (b) { res(b || ausDataUrl(dataUrl)); }, 'image/png'); return; } catch (e) {}
      }
      res(ausDataUrl(dataUrl));
    });
  }
  function ausDataUrl(u) {
    try {
      var bin = window.atob(u.split(',')[1]);
      var arr = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: 'image/png' });
    } catch (e) { return null; }
  }

  function bildErstellen(d) {
    var W = 1080, H = 1920;
    var c = doc.createElement('canvas');
    c.width = W;
    c.height = H;
    var g = c.getContext && c.getContext('2d');
    if (!g) return Promise.reject(new Error('kein canvas'));
    var r = d.review || {};
    return schriftenBereit().then(function () {
      return Promise.all([bildLaden('/logo.png', 2000), bildLaden(produktBild(r.favorite), 2000)]);
    }).then(function (b) {
      var bilder = { logo: b[0], fav: b[1] };
      var dataUrl;
      try {
        malen(g, W, H, d, bilder);
        dataUrl = c.toDataURL('image/png');
      } catch (e) {
        // Bild aus fremder Quelle macht das Canvas unlesbar: ohne Bilder neu malen
        g.setTransform(1, 0, 0, 1, 0, 0);
        malen(g, W, H, d, {});
        dataUrl = c.toDataURL('image/png');
      }
      return zuBlob(c, dataUrl).then(function (blob) {
        var file = null;
        try { if (blob) file = new File([blob], 'burger-jahr-' + d.year + '.png', { type: 'image/png' }); } catch (e3) {}
        return { dataUrl: dataUrl, blob: blob, file: file };
      });
    });
  }

  /* ------------------------------------------------------------------
     START
     ------------------------------------------------------------------ */
  function init(o) {
    o = o || {};
    if (typeof o.getAccount === 'function') opts.getAccount = o.getAccount;
    if (typeof o.lang === 'function') opts.lang = o.lang;
    if (typeof o.t === 'function') opts.t = o.t;
    if (o.teaser === false) opts.teaser = false;
    // Im Hintergrund vorladen, damit available() schnell eine Antwort hat
    if (konto()) load().then(noop, noop);
    return window.GNCJahr;
  }

  if (typeof Promise === 'undefined') {
    window.GNCJahr = {
      init: function () { return window.GNCJahr; },
      renderBadges: function () { return null; },
      open: function () { return null; },
      available: function () { return false; },
      load: function () { return null; },
      refresh: function () { return null; },
      close: noop
    };
    return;
  }

  window.GNCJahr = {
    init: init,
    renderBadges: renderBadges,
    open: open,
    available: available,
    load: function (force) { return load(!!force); },
    refresh: refresh,
    close: close
  };
})();
