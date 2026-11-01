/**
 * lib/wegwerf-domains.js
 * ----------------------------------------------------------------------------
 * Bekannte Wegwerf-Maildienste (Postfächer, die man ohne Anmeldung für ein
 * paar Minuten bekommt). Wer mit jeder Bestellung eine neue Adresse von dort
 * nimmt, umgeht das Limit "max. 3× pro Kunde" bei GRILL5 und anderen Codes
 * mit Kundenlimit. Für solche Adressen lehnen voucher-check.js und
 * lib/preisberechnung.js diese Codes ab (Grund 'wegwerf'). Bestellen geht
 * weiterhin, nur ohne den Code.
 *
 * Die Liste ist von Hand gepflegt (Stand November 2026), nichts wird aus dem
 * Netz geladen. Sie enthält bewusst KEINE Weiterleitungsdienste mit festen
 * Adressen wie Apples "E-Mail verbergen" (privaterelay.appleid.com), Firefox
 * Relay, DuckDuckGo, SimpleLogin oder addy.io: Dahinter stehen echte Konten,
 * und "Mit Apple anmelden" liefert genau solche Adressen.
 *
 * Subdomains zählen mit: x.mailinator.com gilt wie mailinator.com.
 * Neue Dienste: Domain klein geschrieben in WEGWERF eintragen.
 * ----------------------------------------------------------------------------
 */

const WEGWERF = [
  // Mailinator und seine Zweitdomains
  'mailinator.com', 'mailinator.net', 'mailinator.org', 'mailinator2.com', 'mailinater.com',
  'notmailinator.com', 'tmailinator.com', 'mailin8r.com', 'binkmail.com', 'bobmail.info',
  'chammy.info', 'devnullmail.com', 'letthemeatspam.com', 'mailismagic.com', 'monumentmail.com',
  'reallymymail.com', 'safetymail.info', 'sendspamhere.com', 'sogetthis.com', 'spambooger.com',
  'spamherelots.com', 'spamhereplease.com', 'spamthisplease.com', 'streetwisemail.com',
  'suremail.info', 'thisisnotmyrealemail.com', 'tradermail.info', 'veryrealemail.com', 'zippymail.info',
  // Guerrilla Mail
  'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz',
  'guerrillamail.de', 'guerrillamail.info', 'guerrillamailblock.com', 'sharklasers.com',
  'grr.la', 'pokemail.net', 'spam4.me',
  // 10 Minute Mail und Verwandte
  '10minutemail.com', '10minutemail.net', '10minutemail.org', '10minutemail.de',
  '10minutemail.co.uk', '10minutemail.info', '10minutemail.be', '10minmail.com',
  '10minutesmail.com', '20minutemail.com', '30minutemail.com', 'zehnminutenmail.de',
  'minuteinbox.com', '10mail.org',
  // Temp-Mail und Varianten
  'temp-mail.org', 'temp-mail.io', 'temp-mail.ru', 'tempmail.com', 'tempmail.net', 'tempmail.de',
  'tempmail.plus', 'tempmail.dev', 'tempmailo.com', 'tempmailaddress.com', 'tempm.com',
  'tempinbox.com', 'tempomail.fr', 'temporaryinbox.com', 'temporary-mail.net', 'tempr.email',
  'tempemail.net', 'tempail.com', 'tmpmail.org', 'tmpmail.net', 'tmpeml.com', 'mytemp.email',
  'mail-temporaire.fr', 'emailtemporar.ro', 'emailtemporario.com.br',
  // YOPmail und seine Zweitdomains
  'yopmail.com', 'yopmail.net', 'yopmail.fr', 'cool.fr.nf', 'jetable.fr.nf', 'courriel.fr.nf',
  'moncourrier.fr.nf', 'monemail.fr.nf', 'monmail.fr.nf', 'nospam.ze.tc', 'nomail.xl.cx',
  'mega.zik.dj', 'speed.1s.fr',
  // TrashMail und Verwandte
  'trashmail.com', 'trashmail.net', 'trashmail.de', 'trashmail.at', 'trashmail.me', 'trashmail.io',
  'trashmail.ws', 'trash-mail.com', 'trash-mail.de', 'trashmailer.com', 'trashymail.com',
  'trashymail.net', 'mytrashmail.com', 'kurzepost.de', 'objectmail.com', 'proxymail.eu',
  'rcpt.at', 'mt2009.com', 'mt2014.com', 'mail4trash.com', 'thetrash.email',
  // Deutsche Wegwerfdienste
  'wegwerfmail.de', 'wegwerfmail.net', 'wegwerfmail.org', 'wegwerfadresse.de', 'wegwerfemail.de',
  'wegwerf-emails.de', 'einmalmail.de', 'sofort-mail.de', 'spoofmail.de', 'spambog.de',
  'spambog.com', 'spambog.ru', 'muellmail.com', 'byom.de', 'emailgo.de', 'dumpmail.de',
  'discardmail.de', 'spaml.de', 'spamfree24.de', 'spamoff.de', 'spaminator.de', 'hidemail.de',
  'messagebeamer.de', 'nervmich.net', 'nervtmich.net', 'twinmail.de', 'cuvox.de', 'einrot.com',
  'spamail.de',
  // Maildrop, Dispostable, Nada und andere Einzeldienste
  'maildrop.cc', 'dispostable.com', 'getnada.com', 'nada.email', 'mailnesia.com', 'mailcatch.com',
  'mailsac.com', 'mintemail.com', 'inboxkitten.com', 'throwawaymail.com', 'throwam.com',
  'burnermail.io', 'discard.email', 'discardmail.com', 'mohmal.com', 'emailondeck.com',
  'fakeinbox.com', 'fakemail.net', 'fakemailgenerator.com', 'emailfake.com', 'mailpoof.com',
  'moakt.com', 'moakt.cc', 'tmail.ws', 'harakirimail.com', 'dropmail.me', 'emltmp.com',
  'yomail.info', 'mail.tm', 'mail.gw', 'linshiyouxiang.net', '33mail.com', 'incognitomail.com',
  'incognitomail.org', 'jetable.org', 'jetable.com', 'jetable.net', 'anonbox.net', 'anonymbox.com',
  'mailexpire.com', 'mailforspam.com', 'mailmetrash.com', 'mailtemp.info', 'mailtothis.com',
  'meltmail.com', 'mailnull.com', 'maileater.com', 'mailzilla.com', 'mailmoat.com',
  'mailshell.com', 'mailsiphon.com', 'mbx.cc', 'deadaddress.com', 'despam.it', 'dontreg.com',
  'dodgeit.com', 'dodgit.com', 'dump-email.info', 'emailias.com', 'emailsensei.com',
  'emailwarden.com', 'explodemail.com', 'filzmail.com', 'frapmail.com', 'get1mail.com',
  'getairmail.com', 'getonemail.com', 'haltospam.com', 'ieatspam.eu', 'ieatspam.info',
  'imails.info', 'inboxclean.com', 'inboxclean.org', 'kasmail.com', 'killmail.com', 'killmail.net',
  'lookugly.com', 'lortemail.dk', 'mailbidon.com', 'mierdamail.com', 'myphantomemail.com',
  'nobulk.com', 'noclickemail.com', 'nogmailspam.info', 'nomail2me.com', 'nospam4.us',
  'nospamfor.us', 'nowmymail.com', 'oneoffemail.com', 'onewaymail.com', 'pookmail.com',
  'putthisinyourspamdatabase.com', 'quickinbox.com', 'recyclemail.dk', 'saynotospams.com',
  'selfdestructingmail.com', 'shiftmail.com', 'skeefmail.com', 'slaskpost.se', 'slopsbox.com',
  'smellfear.com', 'snakemail.com', 'sneakemail.com', 'sofimail.com', 'spam.su', 'spamavert.com',
  'spambob.com', 'spambob.net', 'spambob.org', 'spambox.us', 'spamcannon.com', 'spamcannon.net',
  'spamcorptastic.com', 'spamcowboy.com', 'spamday.com', 'spamdecoy.net', 'spamex.com',
  'spamfree.eu', 'spamfree24.org', 'spamgourmet.com', 'spamgourmet.net', 'spamgourmet.org',
  'spamhole.com', 'spamify.com', 'spamkill.info', 'spaml.com', 'spammotel.com', 'spamobox.com',
  'spamslicer.com', 'spamspot.com', 'spamstack.net', 'spamthis.co.uk', 'spamtrail.com',
  'supergreatmail.com', 'thanksnospam.info', 'tilien.com', 'whyspam.me', 'willselfdestruct.com',
  'wuzupmail.net', 'xemaps.com', 'xents.com', 'xmaily.com', 'zoemail.org', 'mailhazard.com',
  // Generator-Domains von Fake Mail Generator
  'armyspy.com', 'dayrep.com', 'fleckens.hu', 'gustr.com', 'jourrapide.com', 'rhyta.com',
  'superrito.com', 'teleworm.us',
  // 1secmail
  '1secmail.com', '1secmail.net', '1secmail.org', 'esiix.com', 'wwjmp.com', 'xojxe.com',
  'yoggm.com', 'kzccv.com', 'qiott.com', 'vjuum.com', 'laafd.com', 'txcct.com',
];

const MENGE = new Set(WEGWERF);

/** Domain einer Adresse, klein, ohne Punkt am Ende. Ohne @: ''. */
function domainVon(email) {
  const m = String(email || '').trim().toLowerCase();
  const at = m.lastIndexOf('@');
  if (at < 1) return '';
  return m.slice(at + 1).replace(/\.+$/, '');
}

/** true, wenn die Adresse bei einem bekannten Wegwerfdienst liegt (auch Subdomain). */
function istWegwerf(email) {
  let d = domainVon(email);
  if (!d) return false;
  // a.b.mailinator.com -> b.mailinator.com -> mailinator.com
  for (let i = 0; i < 6 && d; i++) {
    if (MENGE.has(d)) return true;
    const p = d.indexOf('.');
    if (p < 0) break;
    d = d.slice(p + 1);
  }
  return false;
}

module.exports = { istWegwerf, domainVon, WEGWERF };
