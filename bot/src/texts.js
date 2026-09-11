// Every sentence the bot can say. English only: the room is English, and no i18n table is opened for it.
//
// The five texts of specification section eight are the source here. Three deliberate storage/product-boundary
// choices are named rather than made quietly:
//
//   1. The specification wraps its prose at about seventy characters because it is a plain text document.
//      Telegram reflows, so a hard break inside a sentence would render as ragged verse on a phone. The
//      wrapped prose lines are therefore joined into one paragraph each. Blank lines are kept, and every
//      line of a list stays its own line. The prose sentences are not rewritten.
//
//   2. START carries one paragraph that section eight does not contain: the one about sells. It is not an
//      improvement of the text and it does not touch it; it is appended after it, because the round's
//      instruction makes saying it a condition rather than a wish. It is the last paragraph of the message
//      so the borrowed prose reads uninterrupted.
//
//   3. The ordered-buyer command is absent from START. A biggest-buyers list is an ordering, and the site's
//      product boundary forbids ordering. Keeping the command would make the code contradict the page.

// The one import in this file, and it is here for a reason worth naming: a rule carries a string its owner
// typed, and every message goes out with Telegram's HTML parse mode. An unescaped angle bracket in somebody's
// rule would either render as markup or be refused by the api as a broken entity, which would lose them the
// message their rule exists to deliver. So the escaping happens where the sentence is assembled and not at
// each call site, because a call site can forget.
import { esc, code, TELEGRAM_TEXT_LIMIT } from "./telegram.js";

/** the site's own pages, and the repository the bot ships in */
export const SITE = "https://chain.lintcha.com/";
export const REPO = "https://github.com/Mnilax/lintcha-chain";
export const TOKEN_JSON = "https://chain.lintcha.com/token.json";
export const HOLD_PAGE = "https://chain.lintcha.com/hold";

// ---------------------------------------------------------------- section eight source, with the invariant edits above

const START_AS_GIVEN = [
  "lintcha reads what a launch on Robinhood Chain wrote about itself and says what those strings are shared with. This bot is the room's half of that: it reads the chain and answers, and it does nothing else.",
  "",
  "/ca — the contract",
  "/price — price and market cap",
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
  "Needed: five hundred thousand $LINTCHA.",
  "",
  "Come back here when you have signed. I check every few seconds."
].join("\n");

/**
 * The sentence a holder signs. Its origin and one-time mark are part of the signed bytes, so a signature made
 * for this page cannot be replayed against a second /verify link or quietly moved to another site. The two
 * constants are mirrored by site/hold/hold.js and bot/test/texts_test.mjs fails on any drift.
 */
export const HOLDER_ORIGIN = "https://chain.lintcha.com";
export const SENTENCE_BEFORE_MARK = "I am proving to the lintcha bot that this wallet is mine. This proof is only for https://chain.lintcha.com and one-time mark ";
export const SENTENCE_AFTER_MARK = ". This signature moves nothing, approves nothing and spends nothing.";
export const sentenceFor = mark => SENTENCE_BEFORE_MARK + String(mark) + SENTENCE_AFTER_MARK;

export const NO_TOKEN_YET = "$LINTCHA does not exist yet. When it does, its address will be on the site and this command will answer. Nothing here is a presale and there is no list to join.";

// ---------------------------------------------------------------- the rest, which section eight does not fix

/** The site could not be read. Said in words rather than answered with a stale address or a zero. */
export const SITE_UNREADABLE = "I could not read the site just now, so I will not answer from memory. Try again in a moment.";

export const NOT_A_HOLDER = [
  "That wallet does not hold enough $LINTCHA for this.",
  "",
  "Needed: five hundred thousand. Nothing is stored about the wallet beyond the address, and /forget drops even that."
].join("\n");

export const NO_SESSION = [
  "This one is for holders, after /verify.",
  "",
  "Send /verify here and sign one sentence. It moves nothing."
].join("\n");

export const PRIVATE_ONLY = "This one only works in a direct message. Send it to me there.";

export const FORGOTTEN = "Removal requested. The watcher confirmed that all of your saved rules were removed, and the wallet-address store accepted its deletion. That store can briefly serve an older cached copy, so I will not claim the address vanished everywhere at once. A message already being sent cannot be recalled. Use /verify whenever you want to start again.";

export const FORGET_RULES_UNCONFIRMED = "The wallet-address store accepted its deletion, but the watcher did not confirm removal of your saved rules. Retry /forget. The address store can briefly serve an older cached copy, so a rule may remain active until the retry succeeds.";

export const FORGET_SESSION_UNCONFIRMED = "The watcher confirmed that all of your saved rules were removed, but the wallet-address store did not confirm the deletion request. The address will still expire on its original schedule. Retry /forget.";

export const FORGET_UNCONFIRMED = "I could not confirm either the wallet-address deletion request or removal of your saved rules. Retry /forget.";

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
  const lines = ["The site: " + esc(SITE), "The repository: " + esc(REPO)];
  if (token && token.pons) lines.push("The chart: " + esc(token.pons));
  if (token && token.uniswap) lines.push("Also trading: " + esc(token.uniswap));
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

// ---------------------------------------------------------------- rules, and the watcher behind them
//
// Four rules, and not one of them says whether anything is good. Three are string equality and one is a count
// with a threshold the person chose. Every sentence below was written to that constraint: it reports what
// matched, with what, and how many launches carry it, and then it stops.
//
// No digit is written out in any of these strings. The numbers in a rule message are read from the index and
// from the tail at the moment it is sent, and a number that could not be read is said in words instead.

/** the launch log this watches, said once so every text can point at the same thing */
export const LAUNCH_LOG = "the pons launch log on Robinhood Chain";

export const RULE_HELP = [
  "Rules are for holders. You name something and I watch the launch log for it. They are string matches and counts, and nothing else.",
  "",
  "/rule string SOLANA — a launch whose ticker, name or one of its links is that string",
  "/rule dev 0x… — another launch from that deployer",
  "/rule shared <count> — a ticker already carried by that many launches or more",
  "/rules — your rules, and what I have read",
  "/unrule <number> — drop one, by the number /rules gives it",
  "/unrule all — drop all of your saved rules",
  "",
  "When one matches I say what matched, with what, and how many launches carry it. I do not say whether that is good or bad, and there is no plan for me to start."
].join("\n");

export const RULES_EMPTY = ["You have no rules.", "", RULE_HELP].join("\n");

export const RULE_KIND_UNKNOWN = ["That is not one of the rules I have.", "", RULE_HELP].join("\n");

export const RULE_NEEDS_ARGUMENT = "That rule needs something to watch for. Send /rules to see the four of them written out.";

export const RULE_TOO_LONG = "That is longer than anything a launch can call itself, so I would never match it. Send a shorter string.";

export const RULE_NEEDS_ADDRESS = "A dev rule takes an address, forty hex characters after the 0x, and nothing else. I will not guess at a name.";

export const RULE_NEEDS_COUNT = "A shared rule takes a whole count, two or more. One launch carrying a ticker is the launch itself, so one would fire on everything.";

export const RULE_LIMIT_REACHED = "You are at your limit for rules. Drop one with /unrule and this one will fit.";
export const RULE_CAPACITY_REACHED = "The rule store is at its overall limit just now. Your existing rules still work, and you can list or remove them with /rules and /unrule.";

export const UNRULE_NEEDS_NUMBER = "/unrule takes the number /rules gives a rule, or the word all. Send /rules to see them.";

export const UNRULE_NOT_YOURS = "You have no rule with that number. /rules shows the ones you do have, and I only ever remove your own.";

export const UNRULE_DONE = "Dropped. I will not write to you about that one again.";

export const UNRULE_ALL_DONE = "Removed all of your saved rules. A message already being sent cannot be recalled.";

export const RULES_NOT_UP = "The watcher is not up, so I cannot keep a rule for you yet. Nothing is queued and nothing is lost: send this again when it is.";

export const RULE_HOLDERS_ONLY = ["Rules are for holders, after /verify.", "", "Send /verify here and sign one sentence. It moves nothing. The check is the one on the site, and the index a rule reads is the one published there."].join("\n");

/** One stored rule, written the way its owner typed it. */
export const ruleLine = (n, rule) => n + ". " + esc(rule.kind) + " " + esc(rule.arg);

/**
 * What a rule owner is told when one matches.
 *
 * data:
 *   { kind, arg, where, indexState, indexCount, tailCount, tailScope, block, address, txUrl }
 *
 * The published index has three answers about a value and they get three sentences, because collapsing them
 * would be the exact thing this project's front page argues against:
 *
 *   shared    the index carries an entry, and its count is quoted
 *   unique    the index carries no entry, which under its own count floor means fewer than two launches in
 *             the snapshot window carried it. That is said as a floor and not as a zero, because it is not one
 *   null      the index could not be read at all, which is a network fault and not a fact about the value
 */
export function ruleHitText(data) {
  const d = data || {};
  const lines = [
    "A launch matched a rule of yours.",
    "",
    "Rule: " + esc(d.kind) + " " + esc(d.arg),
    "Matched: " + esc(d.where)
  ];
  const since = d.tailCount + (d.tailScope === "after_snapshot" ? " after the published snapshot" : " in the currently retained tail");
  if (d.kind === "dev") {
    lines.push("Launches from that deployer: " + since + ". The published index carries no deployers, so it cannot answer this one and I am not going to pretend it did.");
  } else if (d.indexState === "shared") {
    lines.push("Launches carrying it: " + d.indexCount + " in the published index, and " + since);
  } else if (d.indexState === "unique") {
    lines.push("Launches carrying it: " + since + ". The published index has no entry for it, which under its own count floor means fewer launches in the snapshot window than the floor, not none.");
  } else {
    lines.push("Launches carrying it: " + since + ". I could not read the published index just now, so there is no figure from it here rather than a smaller number.");
  }
  lines.push("Block: " + d.block);
  lines.push("The launch: " + code(d.address));
  if (d.txUrl) lines.push(d.txUrl);
  lines.push("", "That is a string match and a count, read from " + LAUNCH_LOG + " and from the index published on the site. It is not a verdict and I am not making one.");
  return lines.join("\n");
}

/** The watcher's own state, shown to the people a gap in it would cost. */
export function watcherStateText(state) {
  const s = state || {};
  const lines = [];
  lines.push("I have read " + LAUNCH_LOG + " up to block " + (s.lastBlock === null || s.lastBlock === undefined ? "nothing yet" : s.lastBlock) + ".");
  if (s.launches !== undefined) lines.push("Launches in the tail: " + s.launches + ". Rows reach their pruning age floor at " + s.depthDays + (Number(s.depthDays) === 1 ? " day" : " days") + " and stay until the published snapshot covers their block.");
  if (Number.isSafeInteger(s.ruleDeliveryBacklog) && Number.isSafeInteger(s.ruleDeliveryCapacity)) {
    lines.push("Pending rule notifications: " + s.ruleDeliveryBacklog + " of the durable capacity " + s.ruleDeliveryCapacity + ".");
  }
  if (Number.isSafeInteger(s.ruleDeliveryBlockedAt)) {
    lines.push("The launch cursor is paused before block " + s.ruleDeliveryBlockedAt + " while that durable backlog drains. The same uncommitted range will be read again.");
  }
  if (Number.isSafeInteger(s.launchOverflowBlock)) {
    lines.push("Block " + s.launchOverflowBlock + " carries more launch events than one bounded beat can inspect, so the cursor remains before it rather than consuming a partial page.");
  }
  if (s.gaps) lines.push("Times my reading stopped and had to be restarted: " + s.gaps + ". A rule cannot match a launch I did not read, so that number is here rather than left out.");
  return lines.join("\n");
}

/** The tail, when somebody asks for it and it is not there. */
export const TAIL_NOT_UP = "The watcher is not up, so there is no tail to give.";

/** One rule, confirmed, with the number /unrule will take for it. */
export function ruleAddedText(number, rule, count, limit) {
  return [
    "Stored as your rule number " + number + ".",
    "",
    ruleLine(number, rule),
    "",
    "I will write to you when a launch matches it, and I will say what matched and how many launches carry it. You have " + count + " of a possible " + limit + ".",
    "",
    "Nothing about this rule is shared with anyone, and nobody else can see it or remove it."
  ].join("\n");
}

/** A person's own rules, and what the watcher has actually read, split into sendMessage-sized pages. */
export function rulesListTexts(rules, state) {
  const list = Array.isArray(rules) ? rules : [];
  if (!list.length) return [[RULES_EMPTY, "", watcherStateText(state)].join("\n")];

  const tail = [
    watcherStateText(state),
    "",
    "/unrule with one of those numbers drops it; /unrule all drops every saved rule of yours. /rules is the only place they are listed, and only to you."
  ].join("\n");

  // A page count cannot exceed one page per rule plus a final state page. Reserve the widest possible header
  // before splitting so adding the real page numbers afterwards cannot push a legal page over the wire limit.
  const widest = String(list.length + 1).length;
  const reservedHeader = "Your rules (page " + "9".repeat(widest) + " of " + "9".repeat(widest) + "):\n\n";
  const bodyLimit = TELEGRAM_TEXT_LIMIT - reservedHeader.length;
  const bodies = [];
  let lines = [];
  let length = 0;
  for (let i = 0; i < list.length; i++) {
    const line = ruleLine(i + 1, list[i]);
    const added = line.length + (lines.length ? 1 : 0);
    if (lines.length && length + added > bodyLimit) {
      bodies.push(lines.join("\n"));
      lines = [];
      length = 0;
    }
    lines.push(line);
    length += line.length + (lines.length > 1 ? 1 : 0);
  }
  if (lines.length) bodies.push(lines.join("\n"));

  const joinedTail = "\n\n" + tail;
  if (bodies.length && bodies[bodies.length - 1].length + joinedTail.length <= bodyLimit) {
    bodies[bodies.length - 1] += joinedTail;
  } else {
    bodies.push(tail);
  }

  if (bodies.length === 1) return ["Your rules:\n\n" + bodies[0]];
  return bodies.map((body, i) => "Your rules (page " + (i + 1) + " of " + bodies.length + "):\n\n" + body);
}
