// The command router, with no network. Specification section nine: every known command answers, an unknown
// one is silent, and with three null on the site every command that depends on the address says the token does
// not exist yet without printing a zero, a dash or an address.
//
//   node test/router_test.mjs
import { handleUpdate, commandOf, KNOWN_COMMANDS, PUBLIC_COMMANDS, PRIVATE_COMMANDS } from "../src/router.js";
import { forgetToken, forgetDecimals, setGate, SEL } from "../src/chain.js";
import { putSession } from "../src/verify.js";
import * as T from "../src/texts.js";
import { harness, fakeKV, fakeGate, fakeNetwork, wordHex, launchRecordHex, FIXTURE, TOKEN_ADDRESS, VENUE_ADDRESS } from "./fakes.mjs";

const t = harness("router");
const net = fakeNetwork();

const msg = (text, type = "private", from = 7) => ({ message: { chat: { id: 100, type }, from: { id: from }, text } });
const textOf = a => (a[0] && a[0].text) || "";

// ---------------------------------------------------------------- the command in a message
t.ok(commandOf("/ca") === "ca", "a plain command");
t.ok(commandOf("/ca@lintcha_chain_bot") === "ca", "a command with the bot name attached, as a room sends it");
t.ok(commandOf("  /Price ") === "price", "trimmed and lowered");
t.ok(commandOf("/price in dollars") === "price", "a command with an argument");
t.ok(commandOf("hello") === null, "ordinary text");
t.ok(commandOf("") === null, "an empty message");
t.ok(commandOf(null) === null, "no text at all");

// ---------------------------------------------------------------- the command this round does not have
t.ok(!KNOWN_COMMANDS.includes("rule"), "rule is not a command of this round");
t.ok(!KNOWN_COMMANDS.includes("rules"), "nor rules");
t.ok(!KNOWN_COMMANDS.includes("unrule"), "nor unrule");

// ---------------------------------------------------------------- an unknown command is silence
forgetToken();
for (const text of ["/moon", "/rule string SOLANA", "/help", "just talking", "/", "//"]) {
  const a = await handleUpdate(msg(text), { env: {}, kv: fakeKV() });
  t.ok(a.length === 0, `nothing is said to ${JSON.stringify(text)}`);
}

// ---------------------------------------------------------------- every known command answers
net.site = { address: null, pons: null, uniswap: null };
for (const c of KNOWN_COMMANDS) {
  forgetToken();
  const a = await handleUpdate(msg("/" + c), { env: {}, kv: fakeKV() });
  t.ok(a.length >= 1 && typeof a[0].text === "string" && a[0].text.trim().length > 0, `/${c} answers`);
}
t.ok(PUBLIC_COMMANDS.length === 6 && PRIVATE_COMMANDS.length === 3, "six commands anywhere and three in a direct message");

// ---------------------------------------------------------------- three null: no address, no zero, no dash
for (const c of ["ca", "price", "me", "verify", "top", "stats"]) {
  forgetToken();
  const body = textOf(await handleUpdate(msg("/" + c), { env: {}, kv: fakeKV() }));
  t.ok(body === T.NO_TOKEN_YET, `/${c} gives the sentence about the token not existing yet`);
  t.ok(!/0x[0-9a-fA-F]{6}/.test(body), `/${c} prints no address`);
  t.ok(!/\d/.test(body), `/${c} prints no figure at all, so no zero can stand in for a price`);
  t.ok(!/—|--/.test(body.replace(/\$LINTCHA/g, "")), `/${c} prints no dash in place of a number`);
}

// the site is not the token: /site still answers, and says there is no chart rather than linking nothing
forgetToken();
let body = textOf(await handleUpdate(msg("/site"), { env: {}, kv: fakeKV() }));
t.ok(body.includes("chain.lintcha.com"), "/site names the site");
t.ok(body.includes("github.com/Mnilax/lintcha-chain"), "/site names the repository");
t.ok(/no chart to link yet/.test(body), "/site says there is no chart yet");

// ---------------------------------------------------------------- a site that cannot be read is a third state
forgetToken();
net.siteOk = false;
body = textOf(await handleUpdate(msg("/ca"), { env: {}, kv: fakeKV() }));
t.ok(body === T.SITE_UNREADABLE, "an unreadable site has its own sentence");
t.ok(body !== T.NO_TOKEN_YET, "and it is not the one about the token not existing");
net.siteOk = true;

// ---------------------------------------------------------------- holder commands only in a direct message
for (const c of PRIVATE_COMMANDS) {
  for (const type of ["group", "supergroup", "channel"]) {
    const a = await handleUpdate(msg("/" + c, type), { env: {}, kv: fakeKV() });
    t.ok(textOf(a) === T.PRIVATE_ONLY, `/${c} in a ${type} points at the direct message`);
  }
}

// ---------------------------------------------------------------- the greeting, when somebody joins
const greet = await handleUpdate({ message: { chat: { id: 100, type: "supergroup" }, new_chat_members: [{ id: 5 }] } }, { env: {}, kv: fakeKV() });
t.ok(textOf(greet) === T.GREETING, "a new member gets the room greeting");
t.ok(greet[0].quiet === true, "and it arrives without a notification");
t.ok(greet.length === 1, "once, not once per command");

// ---------------------------------------------------------------- with an address, the commands go to the chain
forgetToken(); forgetDecimals();
net.site = { address: TOKEN_ADDRESS, pons: "https://example.invalid/chart", uniswap: null };
const gate = fakeGate({
  ["eth_call:" + SEL.decimals]: wordHex(18),
  ["eth_call:" + SEL.totalSupply]: wordHex(1000000000n * 10n ** 18n),
  ["eth_call:" + SEL.balanceOf]: wordHex(2500000n * 10n ** 18n),
  ["eth_call:" + SEL.launched]: launchRecordHex({ curve: VENUE_ADDRESS }),
  ["eth_call:" + SEL.slot0]: new Error("no pool to read"),
  eth_blockNumber: "0x64",
  eth_getLogs: []
});
setGate(gate);

body = textOf(await handleUpdate(msg("/ca"), { env: {}, kv: fakeKV() }));
t.ok(body.includes(TOKEN_ADDRESS), "/ca prints the address the site gave it");
t.ok(body.includes("token.json"), "/ca names where the address came from");

const before = gate.stats.calls;
body = textOf(await handleUpdate(msg("/price"), { env: {}, kv: fakeKV() }));
t.ok(gate.stats.calls > before, "/price actually asks the chain");
t.ok(/cannot read a price/.test(body), "/price says it cannot read one rather than printing a number");
t.ok(!/\bprice: 0\b/i.test(body), "and no zero stands in for the price");

const sess = fakeKV();
await putSession(sess, 7, FIXTURE.address);
body = textOf(await handleUpdate(msg("/me"), { env: {}, kv: sess }));
t.ok(body.includes("2,500,000"), "/me prints the balance it read from the chain");
t.ok(body.includes("/forget"), "/me says how to be forgotten");
t.ok(/cannot read a price/.test(body), "and says there is no value rather than inventing one");

body = textOf(await handleUpdate(msg("/me"), { env: {}, kv: fakeKV() }));
t.ok(body === T.NO_SESSION, "/me with no session asks for /verify");

const vk = fakeKV();
body = textOf(await handleUpdate(msg("/verify"), { env: {}, kv: vk }));
t.ok(/hold\?t=[0-9a-f]{32}/.test(body), "/verify hands over a link with a fresh mark in it");
t.ok([...vk.m.keys()].filter(k => k.startsWith("nonce:")).length === 1, "and exactly one mark was written");
t.ok(body.includes("Needed: one million $LINTCHA."), "/verify states the threshold in words");
t.ok(body.includes("nothing moves"), "/verify says the signature moves nothing");

// /forget
const fk = fakeKV();
await putSession(fk, 7, FIXTURE.address);
t.ok(textOf(await handleUpdate(msg("/forget"), { env: {}, kv: fk })) === T.FORGOTTEN, "/forget drops the session");
t.ok(textOf(await handleUpdate(msg("/forget"), { env: {}, kv: fk })) === T.NOTHING_FORGOTTEN, "/forget twice says there was nothing");

// ---------------------------------------------------------------- the feed commands without a feed
body = textOf(await handleUpdate(msg("/stats"), { env: {}, kv: fakeKV(), tape: null }));
t.ok(/not up/.test(body), "/stats with no feed object says the feed is not up");
body = textOf(await handleUpdate(msg("/top"), { env: {}, kv: fakeKV(), tape: null }));
t.ok(/nobody to list/.test(body), "/top with no feed object says there is nobody to list");

// and with one, sells are named in /stats and nowhere else
const tape = {
  async stats() { return { buys: 12, sells: 5, wallets: 9, newWallets: 7, lastBlock: 100, rounds: 3, gaps: 1, limited: 0, retries: 0 }; },
  async top() { return [{ wallet: FIXTURE.address, buys: 2, total: "3000000000000000000" }]; }
};
body = textOf(await handleUpdate(msg("/stats"), { env: {}, kv: fakeKV(), tape }));
t.ok(/Sells/.test(body), "/stats names sells");
t.ok(/never posted to the room/.test(body), "/stats says sells never reach the room");
t.ok(/Buys/.test(body), "/stats names buys");
body = textOf(await handleUpdate(msg("/top"), { env: {}, kv: fakeKV(), tape }));
t.ok(body.includes("0x9d8a"), "/top lists a wallet in short form");

t.done();
