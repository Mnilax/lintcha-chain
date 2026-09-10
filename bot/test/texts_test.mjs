// The texts. Three things this checks that nothing else can:
//
//   The five texts of specification section eight are carried word for word. Every word of each one is
//   compared in order, so a rewrite, a cut or a helpful improvement fails here.
//
//   /start says out loud that sells are counted and not posted, with the reason. That was a condition of the
//   round, not a preference, and section eight's own text does not contain it, so it is checked separately
//   from the borrowed words it follows.
//
//   The sentence a holder signs is identical in bot/src/texts.js and in site/hold/hold.js. There is no build
//   step under site/, so nothing else keeps those two strings together, and one different space would mean the
//   worker recovers a stranger's address and refuses an honest holder.
//
//   node test/texts_test.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as T from "../src/texts.js";
import { harness } from "./fakes.mjs";

const t = harness("texts");
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

const words = s => String(s).trim().split(/\s+/);
const sameWords = (a, b) => words(a).join(" ") === words(b).join(" ");

// ---------------------------------------------------------------- section eight, word for word
const GIVEN = {
  start: `lintcha reads what a launch on Robinhood Chain wrote about itself and says
    what those strings are shared with. This bot is the room's half of that:
    it reads the chain and answers, and it does nothing else.

    /ca — the contract
    /price — price and market cap
    /top — the biggest buyers since the feed went up
    /stats — what the feed has seen
    /site — the site, the repository, the chart

    Holders, in a direct message, after /verify
    /verify — sign once, nothing moves
    /me — your holding and what it is worth

    It never messages you first. It never asks for a key, a seed or an
    approval. It never holds funds and never trades. Everything it says is
    read from the chain, and its code is in the repository with the rest.`,
  greeting: `This room is the tape. Every buy lands here as it clears the pool.
    Nobody here will message you first, and nobody will ever ask you for
    your seed. One contract; any other address with this name is not ours.

    /ca for the contract, /price for the number, /site for everything else.`,
  verify: `Prove you hold $LINTCHA.

    Open the link, connect the wallet that holds the tokens, and sign one
    sentence. It is a signature, not a transaction: nothing moves, nothing
    is approved, no gas is spent. The page reads your balance itself.

    Needed: five hundred thousand $LINTCHA.

    Come back here when you have signed. I check every few seconds.`,
  sentence: `I am proving to the lintcha bot that this wallet is mine. This signature
    moves nothing, approves nothing and spends nothing.`,
  noToken: `$LINTCHA does not exist yet. When it does, its address will be on the
    site and this command will answer. Nothing here is a presale and there
    is no list to join.`
};

// START carries the borrowed text and then one paragraph of its own, so the borrowed half is compared as a
// prefix by words rather than as the whole string
const startWords = words(T.START);
const givenStartWords = words(GIVEN.start);
t.ok(startWords.slice(0, givenStartWords.length).join(" ") === givenStartWords.join(" "), "/start opens with section eight's text, word for word");
t.ok(startWords.length > givenStartWords.length, "and then says something more");

t.ok(sameWords(T.GREETING, GIVEN.greeting), "the room greeting is word for word");
t.ok(sameWords(T.VERIFY_INTRO, GIVEN.verify), "the /verify text is word for word");
t.ok(sameWords(T.SENTENCE, GIVEN.sentence), "the signed sentence is word for word");
t.ok(sameWords(T.NO_TOKEN_YET, GIVEN.noToken), "the no token text is word for word");

// the shape of the two that are lists as well as prose
t.ok(T.START.includes("/ca — the contract"), "/start keeps each command on its own line");
t.ok(T.START.split("\n").filter(l => l.startsWith("/")).length === 7, "seven command lines in /start: five for the room and two for a holder");
t.ok(T.GREETING.includes("\n\n/ca for the contract"), "the greeting keeps its last line apart");

// ---------------------------------------------------------------- the sells disclosure, and where it sits
t.ok(/\bsells\b/i.test(T.START), "/start says the word sells");
t.ok(/The feed posts buys, not sells\./.test(T.START), "/start says which way the feed leans");
t.ok(/\/stats shows them/.test(T.START), "/start says where sells can be seen");
t.ok(/never land in the room/.test(T.START), "/start says they do not reach the room");
t.ok(/choice about which facts reach you/.test(T.START), "/start gives the reason, not just the fact");
t.ok(T.START.indexOf("The feed posts buys") > T.START.indexOf("read from the chain, and its code is in the repository"),
  "and it comes after the borrowed text, not inside it");

// ---------------------------------------------------------------- the sentence, in both places it lives
const holdPage = fs.readFileSync(path.join(repo, "site", "hold", "hold.js"), "utf8");
const m = /var SENTENCE = "((?:[^"\\]|\\.)*)";/.exec(holdPage);
t.ok(!!m, "site/hold/hold.js declares the sentence in one place a test can find");
if (m) {
  const onPage = JSON.parse('"' + m[1] + '"');
  t.ok(onPage === T.SENTENCE, "and it is identical to the one the worker recovers against");
}
t.ok(fs.readFileSync(path.join(repo, "site", "hold", "index.html"), "utf8").indexOf("<script src=") > 0, "the page loads its script from a file");
t.ok(!/<script(?![^>]*\ssrc=)/.test(fs.readFileSync(path.join(repo, "site", "hold", "index.html"), "utf8")), "and carries no inline script, which the vendored CSP would block");

// ---------------------------------------------------------------- what the bot does not do
t.ok(T.NEVER.length === 6, "six absences, as section seven lists them");
t.ok(T.NEVER.some(s => /never messages anyone first/.test(s)), "it never writes first");
t.ok(T.NEVER.some(s => /key, a seed or an approval/.test(s)), "it never asks for a key, a seed or an approval");
t.ok(T.NEVER.some(s => /never holds funds/.test(s)), "it never holds funds");
t.ok(T.NEVER.some(s => /moves nothing/.test(s)), "the signature moves nothing and says so");
t.ok(T.NEVER.some(s => /sets no score/.test(s)), "it sets no score and predicts nothing");
t.ok(T.NEVER.some(s => /read from the chain/.test(s)), "everything it says is read from the chain");

// ---------------------------------------------------------------- amounts
t.ok(T.formatUnits(1000000n * 10n ** 18n, 18) === "1,000,000", "a million whole tokens reads as a million");
t.ok(T.formatUnits(0n, 18) === "0", "nothing reads as nothing");
t.ok(T.formatUnits(1n, 18) === "0", "a single base unit rounds down to nothing whole, and never up");
t.ok(T.formatUnits(1500000000000000000n, 18) === "1.5", "one and a half reads as one and a half");
t.ok(T.formatUnits(1234567n, 6) === "1.2345", "and the fraction is cut, not rounded");
t.ok(T.shortAddress("0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f") === "0x9d8a…5a4f", "an address is shortened at both ends");

// ---------------------------------------------------------------- no secret, and no key, anywhere in the payload
for (const rel of ["bot/src/index.js", "bot/src/telegram.js", "bot/src/verify.js", "bot/src/chain.js", "bot/src/texts.js", "bot/src/tape.js", "bot/src/router.js", "bot/wrangler.toml", "site/hold/hold.js", "site/hold/index.html",
  // round D2's files, put in the same loop rather than left outside it
  "bot/src/watch.js", "bot/src/rules.js", "bot/src/tally.js", "bot/src/engine.js", "bot/src/engine-globals.js", "bot/tools/verify-tail.mjs"]) {
  const body = fs.readFileSync(path.join(repo, rel), "utf8");
  t.ok(!/\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/.test(body), rel + " carries nothing shaped like a bot token");
  t.ok(!/0x[0-9a-fA-F]{64}\b/.test(body), rel + " carries nothing shaped like a private key");
}

t.done();
