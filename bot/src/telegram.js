// Sending, and the little markup the bot uses. HTML rather than MarkdownV2, because an address and a number
// need no escaping in HTML beyond three characters, while MarkdownV2 would have every underscore and full stop
// in a sentence escaped by hand and one miss would swallow a message.
//
// The bot token arrives as a secret named TELEGRAM_BOT_TOKEN. It is read from env at the moment of the call and
// never logged, never put in a URL that gets logged by this code, and never returned to a caller. No token,
// no secret and no example of either appears anywhere in this repository.

const API = "https://api.telegram.org/bot";

/** the three characters HTML cares about */
export const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** monospace, for an address or an amount */
export const code = s => "<code>" + esc(s) + "</code>";

/** a link whose text is its own words, never the raw url twice */
export const link = (text, href) => '<a href="' + esc(href) + '">' + esc(text) + "</a>";

/**
 * One message. Returns true when Telegram accepted it, false otherwise; a failure is never thrown at a webhook,
 * because Telegram retries anything that is not a two hundred and a retry storm is worse than a missed line.
 */
export async function sendMessage(env, chatId, text, options = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return false;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    link_preview_options: { is_disabled: options.preview !== true },
    disable_notification: options.quiet === true
  };
  if (options.replyTo) body.reply_parameters = { message_id: options.replyTo, allow_sending_without_reply: true };
  try {
    const r = await fetch(API + token + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * Carry out what the router decided. The router returns plain objects and never sends anything itself, so every
 * command can be read in a test without a network and without a bot token.
 */
export async function perform(env, actions) {
  let sent = 0;
  for (const a of actions || []) {
    if (!a || a.kind !== "send") continue;
    if (await sendMessage(env, a.chat, a.text, a)) sent++;
  }
  return sent;
}
