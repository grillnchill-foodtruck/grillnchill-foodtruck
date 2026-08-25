#!/usr/bin/env node
/**
 * werkzeug/push-fcm-test.js
 * ----------------------------------------------------------------------------
 * Prüft den iOS-Versandweg (lib/fcm.js) ohne Netz: ein erzeugtes Dienstkonto
 * signiert das JWT, Googles Endpunkte werden nachgestellt. Geprüft wird die
 * Signatur, der Token-Tausch, der Themen-Versand und dass der Baustein ohne
 * Einrichtung leise aussteigt statt den Web-Push mitzureißen.
 *   node werkzeug/push-fcm-test.js
 * ----------------------------------------------------------------------------
 */
const crypto = require('crypto');
const path = require('path');
const { sendeAnIOS } = require(path.join(__dirname, '..', 'netlify', 'functions', 'lib', 'fcm.js'));

const gruen = (t) => '\x1b[32m' + t + '\x1b[0m';
const rot = (t) => '\x1b[31m' + t + '\x1b[0m';
let fehler = 0;
const pruefe = (n, ok, d) => { if (!ok) fehler++; console.log('  ' + (ok ? gruen('✅') : rot('❌')) + ' ' + n.padEnd(50) + (d || '')); };

(async () => {
  console.log('\niOS-Versand (FCM)\n' + '─'.repeat(70) + '\n');

  // 1) Ohne Einrichtung: leiser Ausstieg
  delete process.env.FIREBASE_SERVICE_ACCOUNT;
  let r = await sendeAnIOS('Titel', 'Text', '/');
  pruefe('ohne Dienstkonto: leiser Ausstieg', r.ok === false && r.grund === 'nicht_eingerichtet');

  // 2) Mit erzeugtem Dienstkonto: JWT + Tausch + Versand
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  process.env.FIREBASE_SERVICE_ACCOUNT = JSON.stringify({
    client_email: 'test@grilln-chill-26a54.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    project_id: 'grilln-chill-26a54',
  });
  const rufe = [];
  const holen = async (url, opt) => {
    rufe.push({ url: String(url), opt });
    if (String(url).includes('oauth2.googleapis.com')) {
      // JWT aus der Anfrage pruefen
      const assertion = decodeURIComponent(String(opt.body).split('assertion=')[1]);
      const [k, d, sig] = assertion.split('.');
      const ok = crypto.verify('RSA-SHA256', Buffer.from(k + '.' + d), publicKey,
        Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
      const daten = JSON.parse(Buffer.from(d.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
      pruefe('JWT korrekt signiert', ok);
      pruefe('richtiger Geltungsbereich', daten.scope.includes('firebase.messaging'));
      return { ok: true, json: async () => ({ access_token: 'test-token', expires_in: 3600 }) };
    }
    if (String(url).includes('fcm.googleapis.com')) {
      const m = JSON.parse(opt.body).message;
      // Inhalt nur beim ersten Versand pruefen – der zweite testet den Token-Cache
      if (rufe.filter(x => x.url.includes('fcm')).length === 1) {
        pruefe('richtiges Projekt im Pfad', String(url).includes('grilln-chill-26a54'));
        pruefe('Thema "alle"', m.topic === 'alle');
        pruefe('Titel und Text dabei', m.notification.title === 'Angebot' && m.notification.body === 'Heute Special');
        pruefe('Zugangs-Token im Kopf', opt.headers.Authorization === 'Bearer test-token');
      }
      return { ok: true, json: async () => ({ name: 'projects/x/messages/1' }) };
    }
    throw new Error('unerwarteter Abruf: ' + url);
  };
  r = await sendeAnIOS('Angebot', 'Heute Special', '/', holen);
  pruefe('Versand meldet Erfolg', r.ok === true);

  // 3) Zweiter Versand nutzt den gemerkten Token (kein zweiter Tausch)
  const vorher = rufe.filter(x => x.url.includes('oauth2')).length;
  await sendeAnIOS('Zweite', 'Nachricht', '/', holen);
  const nachher = rufe.filter(x => x.url.includes('oauth2')).length;
  pruefe('Token wird wiederverwendet', vorher === nachher, vorher + ' Tauschvorgaenge');

  console.log('\n' + '─'.repeat(70));
  console.log(fehler === 0 ? gruen('ERGEBNIS: ✅ iOS-Versandweg vollstaendig geprueft.')
    : rot('ERGEBNIS: ❌ ' + fehler + ' Pruefung(en) fehlgeschlagen.'));
  process.exit(fehler === 0 ? 0 : 1);
})();
