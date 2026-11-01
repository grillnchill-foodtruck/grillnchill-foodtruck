/**
 * lib/burger-pass-post.js
 * ----------------------------------------------------------------------------
 * Mails zum Burger-Pass in der Sprache, in der gekauft wurde (8 Sprachen):
 *   kauf     nach bestätigter Zahlung
 *   letztes  wenn nur noch 1 Menü übrig ist
 *   ablauf   7 Tage vor Ablauf, solange noch Menüs übrig sind
 * Versand über Brevo wie die übrigen Kundenmails (account.js). Wirft nie,
 * Rückgabe true bei Erfolg.
 * ----------------------------------------------------------------------------
 */

const SPRACHEN = ['de', 'en', 'tr', 'it', 'es', 'pt', 'fr', 'nl'];
const LOCALE = { de: 'de-DE', en: 'en-GB', tr: 'tr-TR', it: 'it-IT', es: 'es-ES', pt: 'pt-PT', fr: 'fr-FR', nl: 'nl-NL' };

const T = {
  de: {
    hallo: 'Hallo {kunde},',
    kauf_betreff: 'Dein {name} ist aktiv',
    kauf_text: 'dein {name} ist freigeschaltet: {menus} Menüs, gültig bis {datum}.',
    so: 'So löst du ein: Leg online ein Burger-Menü in den Warenkorb und tipp auf „Pass-Menü einlösen“. Am Truck zeigst du den QR-Code aus deinem Konto.',
    regel: 'Gratis ist das Grundmenü mit einfachem Patty, ohne Kubis Special. Double Patty und Süßkartoffelpommes kosten den Aufpreis. Der Pass verlängert sich nicht.',
    letztes_betreff: 'Noch 1 Menü auf deinem {name}',
    letztes_text: 'auf deinem {name} ist noch 1 Menü, gültig bis {datum}.',
    ablauf_betreff: 'Dein {name} läuft am {datum} ab',
    ablauf_text: 'auf deinem {name} sind noch {n} Menüs. Sie gelten bis {datum}, danach verfallen sie.',
    neu: 'Wenn du magst, holst du dir danach einen neuen Pass.',
    knopf_konto: 'Zum Konto', knopf_neu: 'Neuen Pass holen',
    fuss: 'Bestellnummer {ref}',
  },
  en: {
    hallo: 'Hi {kunde},',
    kauf_betreff: 'Your {name} is active',
    kauf_text: 'your {name} is ready: {menus} meals, valid until {datum}.',
    so: 'How to use it: online, add a burger meal to your cart and tap “Redeem pass meal”. At the truck, show the QR code from your account.',
    regel: 'The free meal is the basic meal with a single patty, Kubis Special excluded. Double patty and sweet potato fries cost the usual extra. The pass does not renew.',
    letztes_betreff: '1 meal left on your {name}',
    letztes_text: 'your {name} has 1 meal left, valid until {datum}.',
    ablauf_betreff: 'Your {name} expires on {datum}',
    ablauf_text: 'your {name} still has {n} meals. They are valid until {datum} and expire after that.',
    neu: 'If you like, get a new pass afterwards.',
    knopf_konto: 'Go to my account', knopf_neu: 'Get a new pass',
    fuss: 'Order number {ref}',
  },
  tr: {
    hallo: 'Merhaba {kunde},',
    kauf_betreff: '{name} aktif',
    kauf_text: '{name} hazır: {menus} menü, {datum} tarihine kadar geçerli.',
    so: 'Nasıl kullanılır: Online siparişte sepete bir burger menüsü ekle ve „Pass menüsünü kullan“ düğmesine dokun. Truck’ta hesabındaki QR kodunu göster.',
    regel: 'Ücretsiz olan, tek köfteli temel menüdür, Kubis Special hariç. Double patty ve tatlı patates kızartması için ek ücret ödenir. Pass kendiliğinden uzamaz.',
    letztes_betreff: '{name} üzerinde 1 menü kaldı',
    letztes_text: '{name} üzerinde 1 menü kaldı, {datum} tarihine kadar geçerli.',
    ablauf_betreff: '{name} {datum} tarihinde sona eriyor',
    ablauf_text: '{name} üzerinde hâlâ {n} menü var. {datum} tarihine kadar geçerli, sonra sona erer.',
    neu: 'İstersen ardından yeni bir pass alabilirsin.',
    knopf_konto: 'Hesabıma git', knopf_neu: 'Yeni pass al',
    fuss: 'Sipariş numarası {ref}',
  },
  it: {
    hallo: 'Ciao {kunde},',
    kauf_betreff: 'Il tuo {name} è attivo',
    kauf_text: 'il tuo {name} è pronto: {menus} menù, valido fino al {datum}.',
    so: 'Come si usa: online aggiungi un menù burger al carrello e tocca „Usa menù del pass“. Al truck mostra il codice QR del tuo account.',
    regel: 'Gratis è il menù base con un solo patty, escluso il Kubis Special. Doppio patty e patatine dolci costano il supplemento. Il pass non si rinnova.',
    letztes_betreff: 'Ti resta 1 menù sul tuo {name}',
    letztes_text: 'sul tuo {name} resta 1 menù, valido fino al {datum}.',
    ablauf_betreff: 'Il tuo {name} scade il {datum}',
    ablauf_text: 'sul tuo {name} restano {n} menù. Valgono fino al {datum}, poi scadono.',
    neu: 'Se vuoi, dopo puoi prendere un nuovo pass.',
    knopf_konto: 'Vai al mio account', knopf_neu: 'Prendi un nuovo pass',
    fuss: 'Numero d’ordine {ref}',
  },
  es: {
    hallo: 'Hola {kunde}:',
    kauf_betreff: 'Tu {name} está activo',
    kauf_text: 'tu {name} ya está listo: {menus} menús, válido hasta el {datum}.',
    so: 'Cómo usarlo: online, añade un menú de hamburguesa al carrito y toca „Canjear menú del pase“. En el food truck, enseña el código QR de tu cuenta.',
    regel: 'Gratis es el menú básico con una sola carne, sin Kubis Special. Doble carne y batata frita cuestan el suplemento. El pase no se renueva.',
    letztes_betreff: 'Te queda 1 menú en tu {name}',
    letztes_text: 'en tu {name} queda 1 menú, válido hasta el {datum}.',
    ablauf_betreff: 'Tu {name} caduca el {datum}',
    ablauf_text: 'en tu {name} quedan {n} menús. Valen hasta el {datum} y después caducan.',
    neu: 'Si quieres, luego puedes conseguir un pase nuevo.',
    knopf_konto: 'Ir a mi cuenta', knopf_neu: 'Conseguir un pase nuevo',
    fuss: 'Número de pedido {ref}',
  },
  pt: {
    hallo: 'Olá {kunde},',
    kauf_betreff: 'O teu {name} está ativo',
    kauf_text: 'o teu {name} está pronto: {menus} menus, válido até {datum}.',
    so: 'Como usar: online, junta um menu de hambúrguer ao carrinho e toca em „Usar menu do passe“. No food truck, mostra o código QR da tua conta.',
    regel: 'Grátis é o menu base com um só hambúrguer, sem o Kubis Special. Hambúrguer duplo e batata-doce frita pagam o suplemento. O passe não renova.',
    letztes_betreff: 'Resta 1 menu no teu {name}',
    letztes_text: 'no teu {name} resta 1 menu, válido até {datum}.',
    ablauf_betreff: 'O teu {name} expira a {datum}',
    ablauf_text: 'no teu {name} ainda há {n} menus. Valem até {datum} e depois expiram.',
    neu: 'Se quiseres, depois podes comprar um passe novo.',
    knopf_konto: 'Ir para a minha conta', knopf_neu: 'Comprar passe novo',
    fuss: 'Número da encomenda {ref}',
  },
  fr: {
    hallo: 'Bonjour {kunde},',
    kauf_betreff: 'Ton {name} est actif',
    kauf_text: 'ton {name} est prêt : {menus} menus, valable jusqu’au {datum}.',
    so: 'Comment l’utiliser : en ligne, ajoute un menu burger au panier et touche « Utiliser un menu du pass ». Au food truck, montre le code QR de ton compte.',
    regel: 'Le menu offert est le menu de base avec un seul steak, sans le Kubis Special. Double steak et frites de patate douce coûtent le supplément. Le pass ne se renouvelle pas.',
    letztes_betreff: 'Il te reste 1 menu sur ton {name}',
    letztes_text: 'il reste 1 menu sur ton {name}, valable jusqu’au {datum}.',
    ablauf_betreff: 'Ton {name} expire le {datum}',
    ablauf_text: 'il reste {n} menus sur ton {name}. Ils sont valables jusqu’au {datum}, ensuite ils expirent.',
    neu: 'Si tu veux, prends ensuite un nouveau pass.',
    knopf_konto: 'Aller à mon compte', knopf_neu: 'Prendre un nouveau pass',
    fuss: 'Numéro de commande {ref}',
  },
  nl: {
    hallo: 'Hoi {kunde},',
    kauf_betreff: 'Je {name} is actief',
    kauf_text: 'je {name} staat klaar: {menus} menu’s, geldig tot {datum}.',
    so: 'Zo gebruik je hem: leg online een burgermenu in je winkelwagen en tik op „Pass-menu inwisselen“. Bij de truck laat je de QR-code uit je account zien.',
    regel: 'Gratis is het basismenu met één burger, zonder Kubis Special. Dubbele burger en zoete-aardappelfriet kosten de meerprijs. De pass verlengt niet vanzelf.',
    letztes_betreff: 'Nog 1 menu op je {name}',
    letztes_text: 'op je {name} staat nog 1 menu, geldig tot {datum}.',
    ablauf_betreff: 'Je {name} verloopt op {datum}',
    ablauf_text: 'op je {name} staan nog {n} menu’s. Ze gelden tot {datum}, daarna vervallen ze.',
    neu: 'Als je wilt, haal je daarna een nieuwe pass.',
    knopf_konto: 'Naar mijn account', knopf_neu: 'Nieuwe pass halen',
    fuss: 'Bestelnummer {ref}',
  },
};

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function sprache(l) { return SPRACHEN.includes(l) ? l : 'de'; }

function datumText(iso, lang) {
  try {
    return new Date(iso).toLocaleDateString(LOCALE[sprache(lang)], { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch (e) { return String(iso || '').slice(0, 10); }
}

function fuellen(text, w) {
  return String(text).replace(/\{(\w+)\}/g, (m, k) => (w[k] != null ? w[k] : m));
}

/* Baut Betreff und HTML. art: 'kauf' | 'letztes' | 'ablauf'.
   pass: Pass-Datensatz, extra: { uebrig, kaufOffen } */
function mailBauen(art, pass, extra) {
  const lang = sprache(pass && pass.lang);
  const t = T[lang];
  const site = (process.env.SITE_URL || 'https://grillnchill-foodtruck.de').replace(/\/$/, '');
  const x = extra || {};
  const w = {
    name: pass.name || 'Burger-Pass',
    kunde: (pass.kaeufer && pass.kaeufer.name) || 'Burger-Fan',
    menus: pass.menusGesamt,
    n: x.uebrig != null ? x.uebrig : pass.menusUebrig,
    datum: datumText(pass.gueltigBis, lang),
    ref: pass.bestellnummer || pass.id,
  };
  const betreff = fuellen(t[art + '_betreff'], w);
  const zeilen = [fuellen(t[art + '_text'], w)];
  if (art === 'kauf') zeilen.push(t.so, t.regel);
  else if (x.kaufOffen) zeilen.push(t.neu);
  const knopfText = art !== 'kauf' && x.kaufOffen ? t.knopf_neu : t.knopf_konto;
  const knopfZiel = site + '/?pass=konto';
  const html = `<!DOCTYPE html><html lang="${lang}"><body style="margin:0;padding:0;background:#F5E9D0;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;">
  <div style="max-width:520px;margin:0 auto;background:#0F0D0A;border-radius:14px;overflow:hidden;">
    <div style="background:#CC4715;padding:20px 26px;">
      <div style="font-size:19px;font-weight:800;color:#fff;" lang="en">GRILL'N CHILL</div>
      <div style="font-size:12px;color:#FFD9C4;letter-spacing:1px;text-transform:uppercase;">${esc(w.name)}</div>
    </div>
    <div style="padding:26px;background:#fff;color:#333;font-size:15px;line-height:1.6;">
      <p style="margin:0 0 12px;">${esc(fuellen(t.hallo, w))}</p>
      ${zeilen.map((z) => `<p style="margin:0 0 12px;">${esc(z)}</p>`).join('')}
      <p style="margin:18px 0 6px;"><a href="${esc(knopfZiel)}" style="display:inline-block;background:#CC4715;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:999px;">${esc(knopfText)}</a></p>
      <p style="margin:16px 0 0;color:#888;font-size:12px;">${esc(fuellen(t.fuss, w))}</p>
    </div>
    <div style="padding:14px 26px;background:#0F0D0A;color:#8F8471;font-size:11px;">
      Grill'n Chill Yildiz und Öztas GbR · Gütersloher Straße 122, 33649 Bielefeld
    </div>
  </div></body></html>`;
  return { betreff, html, lang };
}

async function senden(art, pass, extra) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || 'Grilln Chill';
  const an = pass && pass.kaeufer && pass.kaeufer.email;
  if (!apiKey || !senderEmail || !an) return false;
  try {
    const m = mailBauen(art, pass, extra);
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sender: { email: senderEmail, name: senderName },
        to: [{ email: an, name: (pass.kaeufer && pass.kaeufer.name) || undefined }],
        subject: m.betreff,
        htmlContent: m.html,
      }),
    });
    if (!res.ok) console.error('burger-pass Mail ' + art + ': Brevo ' + res.status);
    return res.ok;
  } catch (e) {
    console.error('burger-pass Mail ' + art + ':', e && e.message);
    return false;
  }
}

module.exports = { mailBauen, senden, datumText, SPRACHEN, T };
