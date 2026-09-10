// The router. Every command lands here, and nothing here sends anything: the return value is a list of plain
// actions, so a test can read what the bot would say without a network and without a bot token.
//
// Two rules the shape of this file exists to keep:
//
//   An unknown command is answered with silence. Not "I do not know that one", not a menu: silence. A bot in a
//   room that replies to everything starting with a slash is a bot that argues with other bots.
//
//   Nothing is invented when the chain or the site cannot be read. There are three different states and they
//   get three different sentences: the token does not exist yet, the site could not be read, the chain could
//   not be read. Collapsing them would mean telling somebody there is no token when in fact there is a network
//   fault, which is the exact failure this project spends its whole page arguing against.
//
// The three rule commands sit with the other holder commands, in a direct message, behind a live session, and
// behind the same question about whether there is a token at all. The watcher itself does not need $LINTCHA to
// exist — it reads the factory's log, which exists either way — but a rule is something holding buys, so the
// gate that decides who holds is the gate a rule goes through.
//
// This file still sends nothing. A rule is stored by the watcher, so these three ask the watcher and turn its
// answer into a sentence, which keeps the "what would it say" test possible for them too.

import * as T from "./texts.js";
import { readToken, hasToken, balanceOf, decimalsOf, totalSupply, venueOf, priceInPair } from "./chain.js";
import { getSession, dropSession, newNonce } from "./verify.js";
import { parseRule } from "./rules.js";
import { code, link, esc } from "./telegram.js";
import { formatUnits, shortAddress } from "./texts.js";

/** the commands that answer anywhere, and the ones that only answer in a direct message */
export const PUBLIC_COMMANDS = ["start", "ca", "price", "top", "stats", "site"];
export const PRIVATE_COMMANDS = ["verify", "me", "forget", "rule", "rules", "unrule"];
export const KNOWN_COMMANDS = [...PUBLIC_COMMANDS, ...PRIVATE_COMMANDS];

const send = (chat, text, options = {}) => ({ kind: "send", chat, text, ...options });

/**
 * The command in a message, without its @botname suffix, or null when the text is not a command of ours.
 * Telegram sends "/ca@lintcha_chain_bot" in a room, so the suffix is stripped before the name is compared.
 */
export function commandOf(text) {
  if (typeof text !== "string") return null;
  const m = /^\/([A-Za-z_]+)(@[A-Za-z0-9_]+)?(?:\s|$)/.exec(text.trim());
  if (!m) return null;
  return m[1].toLowerCase();
}

/** Whatever followed the command, whitespace collapsed. Empty string when there was nothing. */
export function argsOf(text) {
  if (typeof text !== "string") return "";
  const m = /^\/[A-Za-z_]+(?:@[A-Za-z0-9_]+)?\s+([\s\S]+)$/.exec(text.trim());
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

const isPrivate = msg => msg && msg.chat && msg.chat.type === "private";

/**
 * What the bot would do with one update.
 * deps: { env, kv, tape }  tape may be null, and then the two feed commands say the feed is not up.
 * Returns an array of actions, empty when the bot stays quiet.
 */
export async function handleUpdate(update, deps) {
  const env = (deps && deps.env) || {};
  const kv = deps && deps.kv;
  const tape = (deps && deps.tape) || null;
  const watch = (deps && deps.watch) || null;

  // somebody joined the room: one greeting, and nothing else ever gets said unprompted
  const joined = update && update.message && update.message.new_chat_members;
  if (Array.isArray(joined) && joined.length) {
    return [send(update.message.chat.id, T.GREETING, { quiet: true })];
  }

  const msg = (update && (update.message || update.edited_message)) || null;
  if (!msg || !msg.chat) return [];
  const chat = msg.chat.id;
  const cmd = commandOf(msg.text);
  if (!cmd) return [];
  if (!KNOWN_COMMANDS.includes(cmd)) return [];                      // silence, on purpose
  if (PRIVATE_COMMANDS.includes(cmd) && !isPrivate(msg)) return [send(chat, T.PRIVATE_ONLY)];

  if (cmd === "start") return [send(chat, T.START)];
  if (cmd === "site") {
    const token = await readToken(env);
    return [send(chat, T.siteText(token.ok ? token : null))];
  }

  // everything below needs to know whether there is a token at all
  const token = await readToken(env);
  if (!token.ok) return [send(chat, T.SITE_UNREADABLE)];
  if (!hasToken(token)) return [send(chat, T.NO_TOKEN_YET)];

  switch (cmd) {
    case "ca": return [send(chat, caText(token))];
    case "price": return [send(chat, await priceText(env, token))];
    case "top": return [send(chat, await topText(tape))];
    case "stats": return [send(chat, await statsText(tape))];
    case "verify": return await verifyActions(env, kv, chat, msg);
    case "me": return await meActions(env, kv, chat, msg, token);
    case "forget": return await forgetActions(kv, chat, msg);
    case "rule": return await ruleActions(kv, watch, chat, msg);
    case "rules": return await rulesActions(kv, watch, chat, msg);
    case "unrule": return await unruleActions(kv, watch, chat, msg);
    default: return [];
  }
}

// ---------------------------------------------------------------- the answers

function caText(token) {
  const lines = [code(token.address), "", "One contract. Any other address with this name is not ours, and this one comes from the site, not from me: " + T.SITE + "token.json"];
  return lines.join("\n");
}

/**
 * Price and market cap, or the reason there is no number.
 * There is no price API here and there will not be one. /start says everything the bot says is read from the
 * chain, so a figure from a third party would make that sentence false. The price is quoted in whatever token
 * the launch paired against, and when the venue's shape is not one this bot can read, it says so.
 */
async function priceText(env, token) {
  const venue = await venueOf(env, token.address);
  if (!venue) return "I cannot see where this token trades yet, so I have no price to give. Nothing here is a guess, so there is no number instead.";
  const dec = await decimalsOf(env, token.address);
  const supply = await totalSupply(env, token.address);
  const pairDec = Number(env.PAIR_DECIMALS || 18);
  const price = await priceInPair(env, venue, dec === null ? 18 : dec, pairDec, String(env.TOKEN_IS_FIRST || "") === "true");
  if (price === null) {
    const lines = ["I cannot read a price from the venue yet."];
    if (supply !== null && dec !== null) lines.push("", "Supply: " + code(formatUnits(supply, dec)));
    lines.push("", "The venue is " + code(shortAddress(venue)) + ". Everything I say is read from the chain, so until I can read that pool there is no number here rather than a number from somewhere else.");
    return lines.join("\n");
  }
  const lines = ["Price: " + code(price.toPrecision(6)) + " of the paired token per $LINTCHA"];
  if (supply !== null && dec !== null) {
    const cap = price * Number(formatUnits(supply, dec).replace(/,/g, ""));
    if (Number.isFinite(cap)) lines.push("Market cap: " + code(cap.toPrecision(6)) + " of the paired token");
    lines.push("Supply: " + code(formatUnits(supply, dec)));
  }
  lines.push("", "Quoted in the token this launch paired against, " + code(shortAddress(venue)) + ", because that is what the chain says. No exchange rate is fetched from anywhere.");
  return lines.join("\n");
}

async function topText(tape) {
  if (!tape) return "The feed is not up, so there is nobody to list yet.";
  const rows = await tape.top();
  if (!rows || !rows.length) return "The feed is up and has seen no buys yet. That is the whole answer; there is no placeholder list.";
  const lines = ["The biggest buyers since the feed went up:", ""];
  rows.forEach((r, i) => lines.push(String(i + 1) + ". " + code(shortAddress(r.wallet)) + " — " + code(r.total) + " over " + r.buys + (r.buys === 1 ? " buy" : " buys")));
  return lines.join("\n");
}

/**
 * What the feed has seen. Sells appear here and nowhere else, which /start says out loud, and the count is a
 * count: no ratio, no verdict, nothing ordered by whether it looks good.
 */
async function statsText(tape) {
  if (!tape) return "The feed is not up, so it has seen nothing yet.";
  const s = await tape.stats();
  if (!s) return "The feed is not up, so it has seen nothing yet.";
  const lines = [
    "What the feed has seen since it went up:",
    "",
    "Buys: " + code(s.buys),
    "Sells: " + code(s.sells) + "  (counted here, never posted to the room)",
    "Wallets that bought: " + code(s.wallets),
    "First time buyers: " + code(s.newWallets),
    "",
    "Blocks read up to " + code(s.lastBlock === null ? "nothing yet" : s.lastBlock) + ".",
    "Rate limited replies from the endpoint: " + code(s.limited) + ", retries " + code(s.retries) + "."
  ];
  if (s.gaps) lines.push("Rounds the watchdog had to restart: " + code(s.gaps) + ".");
  return lines.join("\n");
}

async function verifyActions(env, kv, chat, msg) {
  if (!kv) return [send(chat, T.SITE_UNREADABLE)];
  const who = (msg.from && msg.from.id) || chat;
  const t = await newNonce(kv, who);
  const url = (env.HOLD_PAGE || T.HOLD_PAGE) + "?t=" + t;
  return [send(chat, T.VERIFY_INTRO + "\n\n" + link("Open the check", url), { preview: false })];
}

async function meActions(env, kv, chat, msg, token) {
  if (!kv) return [send(chat, T.SITE_UNREADABLE)];
  const who = (msg.from && msg.from.id) || chat;
  const address = await getSession(kv, who);
  if (!address) return [send(chat, T.NO_SESSION)];
  const dec = await decimalsOf(env, token.address);
  const bal = await balanceOf(env, token.address, address);
  if (dec === null || bal === null) return [send(chat, "I could not read that balance from the chain just now. Nothing is cached, so there is no older number to show you. Try again in a moment.")];
  const lines = [
    "Wallet: " + code(shortAddress(address)),
    "Holding: " + code(formatUnits(bal, dec)) + " $LINTCHA"
  ];
  const venue = await venueOf(env, token.address);
  const price = venue ? await priceInPair(env, venue, dec, Number(env.PAIR_DECIMALS || 18), String(env.TOKEN_IS_FIRST || "") === "true") : null;
  if (price !== null) {
    const whole = Number(formatUnits(bal, dec).replace(/,/g, ""));
    const worth = whole * price;
    if (Number.isFinite(worth)) lines.push("Worth: " + code(worth.toPrecision(6)) + " of the paired token");
  } else {
    lines.push("", "I cannot read a price yet, so there is no value here rather than a made up one.");
  }
  lines.push("", "I know this address and nothing else about you. /forget drops it now; it expires on its own in three days.");
  return [send(chat, lines.join("\n"))];
}

// ---------------------------------------------------------------- rules
//
// The four rules and not one judgment among them. Everything below either stores a string, lists strings, or
// removes one, and the reasons a rule is refused are the reasons it could not be read: an unknown kind, a
// missing argument, something that is not an address, something that is not a count. Nothing is guessed at
// and nothing is silently turned into a different rule than the one asked for.

/** the one gate all three go through: a live holder session, and a watcher to keep the rule in */
async function ruleGate(kv, watch, chat, msg) {
  if (!kv) return { no: [send(chat, T.SITE_UNREADABLE)] };
  const who = (msg.from && msg.from.id) || chat;
  const address = await getSession(kv, who);
  if (!address) return { no: [send(chat, T.RULE_HOLDERS_ONLY)] };
  if (!watch) return { no: [send(chat, T.RULES_NOT_UP)] };
  return { who };
}

async function ruleActions(kv, watch, chat, msg) {
  const gate = await ruleGate(kv, watch, chat, msg);
  if (gate.no) return gate.no;

  const rest = argsOf(msg.text);
  const space = rest.indexOf(" ");
  const kind = space < 0 ? rest : rest.slice(0, space);
  const arg = space < 0 ? "" : rest.slice(space + 1);
  if (!kind) return [send(chat, T.RULE_KIND_UNKNOWN)];

  const read = parseRule(kind, arg);
  if (!read.ok) {
    if (read.why === "kind") return [send(chat, T.RULE_KIND_UNKNOWN)];
    if (read.why === "empty") return [send(chat, T.RULE_NEEDS_ARGUMENT)];
    if (read.why === "long") return [send(chat, T.RULE_TOO_LONG)];
    if (read.why === "address") return [send(chat, T.RULE_NEEDS_ADDRESS)];
    return [send(chat, T.RULE_NEEDS_COUNT)];
  }

  const r = await watch.add(gate.who, read.kind, read.arg);
  if (!r || !r.ok) {
    if (r && r.why === "limit") return [send(chat, T.RULE_LIMIT_REACHED)];
    return [send(chat, T.RULES_NOT_UP)];
  }
  return [send(chat, T.ruleAddedText(r.number, r.rule, r.count, r.limit), { preview: false })];
}

async function rulesActions(kv, watch, chat, msg) {
  const gate = await ruleGate(kv, watch, chat, msg);
  if (gate.no) return gate.no;
  const r = await watch.list(gate.who);
  if (!r || !r.ok) return [send(chat, T.RULES_NOT_UP)];
  return [send(chat, T.rulesListText(r.rules, r.state), { preview: false })];
}

async function unruleActions(kv, watch, chat, msg) {
  const gate = await ruleGate(kv, watch, chat, msg);
  if (gate.no) return gate.no;
  const rest = argsOf(msg.text);
  if (!/^[0-9]+$/.test(rest)) return [send(chat, T.UNRULE_NEEDS_NUMBER)];
  const r = await watch.remove(gate.who, Number(rest));
  if (!r || !r.ok) return [send(chat, r && r.why === "number" ? T.UNRULE_NOT_YOURS : T.RULES_NOT_UP)];
  return [send(chat, T.UNRULE_DONE)];
}

async function forgetActions(kv, chat, msg) {
  if (!kv) return [send(chat, T.SITE_UNREADABLE)];
  const who = (msg.from && msg.from.id) || chat;
  const had = await dropSession(kv, who);
  return [send(chat, had ? T.FORGOTTEN : T.NOTHING_FORGOTTEN)];
}

export { esc };
