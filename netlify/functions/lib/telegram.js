/**
 * lib/telegram.js
 * ----------------------------------------------------------------------------
 * Eine Nachricht an Kubis Telegram-Chat, für alle Functions gleich:
 *
 *     const { telegram } = require('./lib/telegram');
 *     await telegram('<b>Neue Bewertung</b> 2 Sterne', { html: true });
 *
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. Fehlt eins davon, passiert
 * nichts. Wirft nie: Eine Benachrichtigung darf keine Bestellung und keinen
 * Zeitplan-Lauf scheitern lassen. Rückgabe true, wenn Telegram angenommen hat.
 *
 * Bei html: true Nutzereingaben vorher mit esc() entschärfen.
 * ----------------------------------------------------------------------------
 */

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function telegram(text, opts = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat || !text) return false;
  try {
    const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chat,
        text: String(text).slice(0, 4000),
        parse_mode: opts.html ? 'HTML' : undefined,
        disable_web_page_preview: true,
      }),
    });
    return r.ok;
  } catch (e) {
    console.error('telegram:', e.message);
    return false;
  }
}

module.exports = { telegram, esc };
