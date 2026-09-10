// Every sentence the bot can say. English only: the room is English, and no i18n table is opened for it.
//
// The five texts of specification section eight are here word for word. Two things about how they are stored,
// both of them deliberate and both named in the report rather than done quietly:
//
//   1. The specification wraps its prose at about seventy characters because it is a plain text document.
//      Telegram reflows, so a hard break inside a sentence would render as ragged verse on a phone. The
//      wrapped prose lines are therefore joined into one paragraph each. Blank lines are kept, and every
//      line of a list stays its own line. Not one word is changed, added or removed inside those texts.
//
//   2. START carries one paragraph that section eight does not contain: the one about sells. It is not an
//      improvement of the text and it does not touch it; it is appended after it, because the round's
//      instruction makes saying it a condition rather than a wish. It is the only addition anywhere in
//      this file, and it is the last paragraph of the message so the borrowed text reads uninterrupted.

/** the site's own pages, and the repository the bot ships in */
export const SITE = "https://chain.lintcha.com/";
export const REPO = "https://github.com/Mnilax/lintcha-chain";
export const TOKEN_JSON = "https://chain.lintcha.com/token.json";
export const HOLD_PAGE = "https://chain.lintcha.com/hold";

// ---------------------------------------------------------------- section eight, word for word

const START_AS_GIVEN = [
  "lintcha reads what a launch on Robinhood Chain wrote about itself and says what those strings are shared with. This bot is the room's half of that: it reads the chain and answers, and it does nothing else.",
  "",
  "/ca — the contract",
  "/price — price and market cap",
  "/top — the biggest buyers since the feed went up",
  "/stats — what the feed has seen",
  "/site — the site, the repository, the chart",
  "",
  "Holders, in a direct message, after /verify",
  "/verify — sign once, nothing moves",
  "/me — your holding and what it is worth",
  "",
  "It never messages you first. It never asks for a key, a seed or an approval. It never holds funds and never trades. Everything it says is read from the chain, and its code is in the repository with the rest."
].join("\n");

// The one addition. The feed shows buys and not sells, which is a choice about which facts reach the reader,
// and this project's whole argument elsewhere is that it does not make choices like that. So it is said here
// with the reason, in the open, rather than left for somebody to notice.
const START_ON_SELLS = [
  "The feed posts buys, not sells. Sells are counted, and /stats shows them; they never land in the room. That is a choice about which facts reach you, and it is written here rather than left for you to find: everything else this project does refuses to pick which facts to show, and the feed is the one place we picked."
].join("\n");

export const START = START_AS_GIVEN + "\n\n" + START_ON_SELLS;

export const GREETING = [
  "This room is the tape. Every buy lands here as it clears the pool. Nobody here will message you first, and nobody will ever ask you for your seed. One contract; any other address with this name is not ours.",
  "",
  "/ca for the contract, /price for the number, /site for everything else."
].join("\n");

export const VERIFY_INTRO = [
  "Prove you hold $LINTCHA.",
  "",
  "Open the link, connect the wallet that holds the tokens, and sign one sentence. It is a signature, not a transaction: nothing moves, nothing is approved, no gas is spent. The page reads your balance itself.",
  "",
  "Needed: one million $LINTCHA.",
  "",
  "Come back here when you have signed. I check every few seconds."
].join("\n");

/** The sentence a holder signs. One altered character recovers a different address, so this string is load bearing. */
export const SENTENCE = "I am proving to the lintcha bot that this wallet is mine. This signature moves nothing, approves nothing and spends nothing.";

export const NO_TOKEN_YET = "$LINTCHA does not exist yet. When it does, its address will be on the site and this command will answer. Nothing here is a presale and there is no list to join.";

// ---------------------------------------------------------------- the rest, which section eight does not fix

/** The site could not be read. Said in words rather than answered with a stale address or a zero. */
export const SITE_UNREADABLE = "I could not read the site just now, so I will not answer from memory. Try again in a moment.";

export const NOT_A_HOLDER = [
  "That wallet does not hold enough $LINTCHA for this.",
  "",
  "Needed: one million. Nothing is stored about the wallet beyond the address, and /forget drops even that."
].join("\n");

export const NO_SESSION = [
  "This one is for holders, after /verify.",
  "",
  "Send /verify here and sign one sentence. It moves nothing."
].join("\n");

export const PRIVATE_ONLY = "This one only works in a direct message. Send it to me there.";

export const FORGOTTEN = "Dropped. The address is gone from my side; sign again with /verify whenever you like.";

export const NOTHING_FORGOTTEN = "There was nothing to drop.";

export const SESSION_DONE = "Checked. That wallet holds enough, and I will remember the address for three days and nothing else about it.";

export const VERIFY_FAILED_SIGNATURE = "That signature does not belong to the address it came with, so I did not read a balance. Start again with /verify.";

export const VERIFY_FAILED_NONCE = "That link is used or expired. Send /verify for a new one.";

/** What the bot does not do, section seven, for the README and for anyone who asks. */
export const NEVER = [
  "It never messages anyone first.",
  "It never asks for a key, a seed or an approval to spend.",
  "It never holds funds and never trades.",
  "The check signs a sentence, with no gas, and the sentence says in words that it moves nothing.",
  "It sets no score, predicts nothing and advises nothing.",
  "Everything it says is read from the chain."
];

/** /site. The chart is only named when the site names it, which is the same rule the page follows. */
export function siteText(token) {
  const lines = ["The site: " + SITE, "The repository: " + REPO];
  if (token && token.pons) lines.push("The chart: " + token.pons);
  if (token && token.uniswap) lines.push("Also trading: " + token.uniswap);
  if (!token || (!token.pons && !token.uniswap)) lines.push("There is no chart to link yet; when there is, the site will carry it first.");
  return lines.join("\n");
}

/** A short form of an address, for a room that reads on a phone. */
export const shortAddress = a => (typeof a === "string" && a.length > 12 ? a.slice(0, 6) + "…" + a.slice(-4) : String(a));

/** Whole tokens from a base unit amount and the token's own decimals, grouped, never rounded up. */
export function formatUnits(amount, decimals) {
  const d = BigInt(decimals);
  const base = 10n ** d;
  const whole = amount / base;
  const group = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const rest = amount % base;
  if (rest === 0n || d === 0n) return group;
  // strip trailing zeros, cut to four places, then strip again: without the second pass an amount smaller
  // than the fourth place printed as a decimal point followed by zeros, which reads as a rounded number
  // rather than as nothing whole. A test caught it.
  const frac = rest.toString().padStart(Number(d), "0").replace(/0+$/, "").slice(0, 4).replace(/0+$/, "");
  return frac ? group + "." + frac : group;
}
