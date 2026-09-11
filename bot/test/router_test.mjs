// The command router, with no network. Specification section nine: every known command answers, an unknown
// one is silent, and with three null on the site every command that depends on the address says the token does
// not exist yet without printing a zero, a dash or an address.
//
//   node test/router_test.mjs
import { handleUpdate, commandOf, ourBotJoined, KNOWN_COMMANDS, PUBLIC_COMMANDS, PRIVATE_COMMANDS } from "../src/router.js";
import { forgetToken, forgetDecimals, setGate, SEL } from "../src/chain.js";
import { putSession } from "../src/verify.js";
import * as T from "../src/texts.js";
import { harness, fakeKV, fakeGate, fakeGateFn, fakeNetwork, wordHex, launchRecordHex, FIXTURE, TOKEN_ADDRESS, VENUE_ADDRESS, WALLET_ADDRESS } from "./fakes.mjs";

const t = harness("router");
const net = fakeNetwork();

const msg = (text, type = "private", from = 7) => ({ message: { chat: { id: 100, type }, from: { id: from }, text } });
const textOf = a => (a[0] && a[0].text) || "";
const addressHex = address => wordHex(BigInt(address));
const slot0Hex = sqrtPriceX96 => "0x" + [sqrtPriceX96, 0n, 0n, 1n, 1n, 0n, 1n].map(value => wordHex(value).slice(2)).join("");

// ---------------------------------------------------------------- the command in a message
t.ok(commandOf("/ca") === "ca", "a plain command");
t.ok(commandOf("/ca@lintcha_chain_bot", "lintcha_chain_bot") === "ca", "a command with this exact bot name attached, as a room sends it");
t.ok(commandOf("/ca@LINTCHA_CHAIN_BOT", "lintcha_chain_bot") === "ca", "a suffixed username is compared case-insensitively, as Telegram defines it");
t.ok(commandOf("/ca@someone_else_bot", "lintcha_chain_bot") === null, "a command addressed to another bot is not ours");
t.ok(commandOf("/ca@lintcha_chain_bot") === null && commandOf("/ca@lintcha_chain_bot", "@lintcha_chain_bot") === null,
  "a suffix is refused when the deployment username is missing or carries an invalid @ prefix");
t.ok(commandOf("  /Price ") === "price", "trimmed and lowered");
t.ok(commandOf("/price in dollars") === "price", "a command with an argument");
t.ok(commandOf("hello") === null, "ordinary text");
t.ok(commandOf("") === null, "an empty message");
t.ok(commandOf(null) === null, "no text at all");

const foreignRoomCommand = await handleUpdate(msg("/price@someone_else_bot", "supergroup"), { env: { BOT_USERNAME: "lintcha_chain_bot" }, kv: fakeKV() });
t.ok(foreignRoomCommand.length === 0, "a group command addressed to another bot produces no action");

// ---------------------------------------------------------------- the three commands round D2 adds
// These three lines said the opposite in round D1, when the instruction was that /rule did not exist. It
// exists now, so they are turned round rather than deleted: the file should say which round it is describing.
t.ok(KNOWN_COMMANDS.includes("rule"), "rule is a command");
t.ok(KNOWN_COMMANDS.includes("rules"), "and rules");
t.ok(KNOWN_COMMANDS.includes("unrule"), "and unrule");
t.ok(PRIVATE_COMMANDS.includes("rule"), "and all three are for a direct message only, like the other holder commands");

// ---------------------------------------------------------------- an unknown command is silence
forgetToken();
for (const text of ["/moon", "/top", "/ruler", "/unruly", "/help", "just talking", "/", "//"]) {
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
t.ok(PUBLIC_COMMANDS.length === 5 && PRIVATE_COMMANDS.length === 6, "five commands answer anywhere and six in a direct message");

// ---------------------------------------------------------------- three null: no address, no zero, no dash
for (const c of ["ca", "price", "me", "verify", "stats", "rule", "rules", "unrule"]) {
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

const offlineForget = fakeKV();
await putSession(offlineForget, 7, FIXTURE.address);
body = textOf(await handleUpdate(msg("/forget"), { env: {}, kv: offlineForget }));
t.ok(body === T.FORGET_RULES_UNCONFIRMED && await offlineForget.get("session:7") === null, "/forget deletes a stored session while the site is unreadable and says rules were not confirmed");
net.siteOk = true;

forgetToken();
net.site = { address: null, pons: null, uniswap: null };
const prelaunchForget = fakeKV();
await putSession(prelaunchForget, 7, FIXTURE.address);
body = textOf(await handleUpdate(msg("/forget"), { env: {}, kv: prelaunchForget }));
t.ok(body === T.FORGET_RULES_UNCONFIRMED && await prelaunchForget.get("session:7") === null, "/forget deletes a stored session before the token exists and says rules were not confirmed");

// ---------------------------------------------------------------- holder commands only in a direct message
for (const c of PRIVATE_COMMANDS) {
  for (const type of ["group", "supergroup", "channel"]) {
    const a = await handleUpdate(msg("/" + c, type), { env: {}, kv: fakeKV() });
    t.ok(textOf(a) === T.PRIVATE_ONLY, `/${c} in a ${type} points at the direct message`);
  }
}

// ---------------------------------------------------------------- the greeting, when somebody joins
const ordinaryJoin = { message: { chat: { id: 100, type: "supergroup" }, new_chat_members: [{ id: 5, is_bot: false, username: "alice" }] } };
const botJoin = { message: { chat: { id: 100, type: "supergroup" }, new_chat_members: [{ id: 6, is_bot: true, username: "LINTCHA_CHAIN_BOT" }] } };
t.ok(!ourBotJoined(ordinaryJoin, "lintcha_chain_bot") && (await handleUpdate(ordinaryJoin, { env: { BOT_USERNAME: "lintcha_chain_bot" }, kv: fakeKV() })).length === 0,
  "an ordinary member joining is silence");
const greet = await handleUpdate(botJoin, { env: { BOT_USERNAME: "lintcha_chain_bot" }, kv: fakeKV() });
t.ok(ourBotJoined(botJoin, "lintcha_chain_bot") && textOf(greet) === T.GREETING, "this configured bot joining gets the room greeting");
t.ok((await handleUpdate(botJoin, { env: { BOT_USERNAME: "another_valid_bot" }, kv: fakeKV() })).length === 0,
  "another bot or a missing configured username cannot trigger this bot's greeting");
t.ok(greet[0].quiet === true, "and it arrives without a notification");
t.ok(greet.length === 1, "once, not once per command");

// ---------------------------------------------------------------- with an address, the commands go to the chain
forgetToken(); forgetDecimals();
net.site = { address: TOKEN_ADDRESS, pons: "https://example.invalid/chart", uniswap: null };
const gate = fakeGate({
  eth_chainId: "0x1237",
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

forgetDecimals();
const pricedGate = fakeGate({
  eth_chainId: "0x1237",
  ["eth_call:" + SEL.decimals]: wordHex(18),
  ["eth_call:" + SEL.totalSupply]: wordHex(1000000000n * 10n ** 18n),
  ["eth_call:" + SEL.balanceOf]: wordHex(2500000n * 10n ** 18n),
  ["eth_call:" + SEL.launched]: launchRecordHex({ curve: VENUE_ADDRESS }),
  ["eth_call:" + SEL.token0]: addressHex(TOKEN_ADDRESS),
  ["eth_call:" + SEL.token1]: addressHex(WALLET_ADDRESS),
  ["eth_call:" + SEL.slot0]: slot0Hex(2n ** 96n)
});
setGate(pricedGate);
body = textOf(await handleUpdate(msg("/price"), { env: { VENUE_KIND: "v3", PAIR_DECIMALS: "NaN", TOKEN_IS_FIRST: "wrong" }, kv: fakeKV() }));
t.ok(/Price:/.test(body), "a complete on-chain pool proof can produce the quote without manual decimals or orientation");
t.ok(body.includes("paired token <code>" + T.shortAddress(WALLET_ADDRESS)) && body.includes("venue <code>" + T.shortAddress(VENUE_ADDRESS)),
  "the quote names the chain-read paired token separately from the venue address");
t.ok(/no orientation or decimal scale came from a deployment setting/.test(body), "the answer says where those two price inputs came from");

const pricedSession = fakeKV();
await putSession(pricedSession, 7, FIXTURE.address);
body = textOf(await handleUpdate(msg("/me"), { env: { VENUE_KIND: "v3" }, kv: pricedSession }));
t.ok(/Worth:/.test(body) && body.includes("paired token <code>" + T.shortAddress(WALLET_ADDRESS)),
  "/me uses the same chain-proved quote object and names its paired-token unit");

forgetDecimals();
const fractionalGate = fakeGate({
  eth_chainId: "0x1237",
  ["eth_call:" + SEL.decimals]: wordHex(6),
  ["eth_call:" + SEL.totalSupply]: wordHex(12345n),
  ["eth_call:" + SEL.balanceOf]: wordHex(12345n),
  ["eth_call:" + SEL.launched]: launchRecordHex({ curve: VENUE_ADDRESS }),
  ["eth_call:" + SEL.token0]: addressHex(TOKEN_ADDRESS),
  ["eth_call:" + SEL.token1]: addressHex(WALLET_ADDRESS),
  ["eth_call:" + SEL.slot0]: slot0Hex(2n ** 96n)
});
setGate(fractionalGate);
body = textOf(await handleUpdate(msg("/price"), { env: { VENUE_KIND: "v3" }, kv: fakeKV() }));
t.ok(body.includes("Market cap: <code>0.0123450</code>"), "market cap uses all base units beyond the fourth displayed fraction digit");
const fractionalSession = fakeKV();
await putSession(fractionalSession, 7, FIXTURE.address);
body = textOf(await handleUpdate(msg("/me"), { env: { VENUE_KIND: "v3" }, kv: fractionalSession }));
t.ok(body.includes("Holding: <code>0.0123</code>") && body.includes("Worth: <code>0.0123450</code>"),
  "worth is computed from the base-unit balance, not by reparsing the intentionally truncated holding text");

forgetDecimals();
const mismatchPriceGate = fakeGate({
  eth_chainId: "0x1237",
  ["eth_call:" + SEL.decimals]: wordHex(18),
  ["eth_call:" + SEL.totalSupply]: wordHex(1000000000n * 10n ** 18n),
  ["eth_call:" + SEL.launched]: launchRecordHex({ curve: VENUE_ADDRESS }),
  ["eth_call:" + SEL.token0]: addressHex(WALLET_ADDRESS),
  ["eth_call:" + SEL.token1]: addressHex(FIXTURE.address),
  ["eth_call:" + SEL.slot0]: slot0Hex(2n ** 96n)
});
setGate(mismatchPriceGate);
body = textOf(await handleUpdate(msg("/price"), { env: { VENUE_KIND: "v3" }, kv: fakeKV() }));
t.ok(!/Price:/.test(body) && /cannot read a price/.test(body), "a venue that does not name the launch token on either side yields no quote");
t.ok(!mismatchPriceGate.asked.includes("eth_call:" + SEL.slot0), "a mismatched pool is refused before slot0 is interpreted");

forgetDecimals();
let slot0Asked = false;
const unreadablePairGate = fakeGateFn(async (method, params) => {
  if (method === "eth_chainId") return "0x1237";
  if (method !== "eth_call") return new Error("unexpected");
  const call = params[0];
  if (call.to === VENUE_ADDRESS && call.data === SEL.token0) return addressHex(TOKEN_ADDRESS);
  if (call.to === VENUE_ADDRESS && call.data === SEL.token1) return addressHex(WALLET_ADDRESS);
  if (call.to === TOKEN_ADDRESS && call.data === SEL.decimals) return wordHex(18);
  if (call.to === WALLET_ADDRESS && call.data === SEL.decimals) return new Error("pair decimals unreadable");
  if (call.to === VENUE_ADDRESS && call.data === SEL.slot0) { slot0Asked = true; return slot0Hex(2n ** 96n); }
  if (call.to === TOKEN_ADDRESS && call.data === SEL.totalSupply) return wordHex(1000000000n * 10n ** 18n);
  if (call.data.startsWith(SEL.launched)) return launchRecordHex({ curve: VENUE_ADDRESS });
  return new Error("unexpected eth_call");
});
setGate(unreadablePairGate);
body = textOf(await handleUpdate(msg("/price"), { env: { VENUE_KIND: "v3", PAIR_DECIMALS: "18" }, kv: fakeKV() }));
t.ok(!/Price:/.test(body) && /cannot read a price/.test(body), "unreadable paired-token decimals cannot fall back to the deployment setting");
t.ok(slot0Asked === false, "the unreadable scale closes pricing before slot0 is interpreted");

forgetDecimals();
setGate(gate);
const sess = fakeKV();
await putSession(sess, 7, FIXTURE.address);
body = textOf(await handleUpdate(msg("/me"), { env: {}, kv: sess }));
t.ok(body.includes("2,500,000"), "/me prints the balance it read from the chain");
t.ok(body.includes("/forget"), "/me says how to be forgotten");
t.ok(/cannot read a price/.test(body), "and says there is no value rather than inventing one");

forgetDecimals();
const noDecimals = fakeGate({
  eth_chainId: "0x1237",
  ["eth_call:" + SEL.launched]: launchRecordHex({ curve: VENUE_ADDRESS }),
  ["eth_call:" + SEL.decimals]: new Error("unreadable decimals"),
  ["eth_call:" + SEL.totalSupply]: wordHex(1000000000n * 10n ** 18n),
  ["eth_call:" + SEL.slot0]: wordHex(2n ** 96n)
});
setGate(noDecimals);
body = textOf(await handleUpdate(msg("/price"), { env: { VENUE_KIND: "v3" }, kv: fakeKV() }));
t.ok(/cannot read this token's decimals/.test(body) && !/Price:/.test(body), "unreadable decimals cannot fall back to eighteen and manufacture a price");
t.ok(!noDecimals.asked.includes("eth_call:" + SEL.slot0), "slot0 is not interpreted without readable token decimals");

forgetDecimals();
const wrongChain = fakeGate({
  eth_chainId: "0x1",
  ["eth_call:" + SEL.launched]: launchRecordHex({ curve: VENUE_ADDRESS }),
  ["eth_call:" + SEL.decimals]: wordHex(18),
  ["eth_call:" + SEL.balanceOf]: wordHex(2500000n * 10n ** 18n),
  ["eth_call:" + SEL.totalSupply]: wordHex(1000000000n * 10n ** 18n),
  ["eth_call:" + SEL.slot0]: wordHex(2n ** 96n)
});
setGate(wrongChain);
body = textOf(await handleUpdate(msg("/price"), { env: { VENUE_KIND: "v3" }, kv: fakeKV() }));
t.ok(/no price|cannot read a price/.test(body) && !/Price:/.test(body), "/price refuses a plausible pool on another chain");
body = textOf(await handleUpdate(msg("/me"), { env: { VENUE_KIND: "v3" }, kv: sess }));
t.ok(/could not read that balance/.test(body) && !/2,500,000/.test(body), "/me refuses a plausible balance on another chain");
t.ok(!wrongChain.stats.byMethod.eth_call, "the wrong-chain command paths never ask for those plausible values");

body = textOf(await handleUpdate(msg("/me"), { env: {}, kv: fakeKV() }));
t.ok(body === T.NO_SESSION, "/me with no session asks for /verify");

const vk = fakeKV();
body = textOf(await handleUpdate(msg("/verify"), { env: {}, kv: vk }));
t.ok(/hold\?t=[0-9a-f]{32}/.test(body), "/verify hands over a link with a fresh mark in it");
t.ok([...vk.m.keys()].filter(k => k.startsWith("nonce:")).length === 1, "and exactly one mark was written");
t.ok(body.includes("Needed: five hundred thousand $LINTCHA."), "/verify states the threshold in words");
t.ok(body.includes("nothing moves"), "/verify says the signature moves nothing");
const unsafeHold = fakeKV();
body = textOf(await handleUpdate(msg("/verify"), { env: { HOLD_PAGE: "javascript:alert(1)" }, kv: unsafeHold }));
t.ok(body === T.SITE_UNREADABLE && [...unsafeHold.m.keys()].filter(k => k.startsWith("nonce:")).length === 0, "an unsafe holder-page setting is refused before a one-time mark is issued");

// /forget
const fk = fakeKV();
await putSession(fk, 7, FIXTURE.address);
const forgetWatch = { async forget() { return { ok: true }; } };
t.ok(textOf(await handleUpdate(msg("/forget"), { env: {}, kv: fk, watch: forgetWatch })) === T.FORGOTTEN, "/forget gets both deletion acknowledgements");
t.ok(textOf(await handleUpdate(msg("/forget"), { env: {}, kv: fk, watch: forgetWatch })) === T.FORGOTTEN, "/forget is idempotent and repeats both deletion requests");

// ---------------------------------------------------------------- the feed command without a feed
body = textOf(await handleUpdate(msg("/stats"), { env: {}, kv: fakeKV(), tape: null }));
t.ok(/not up/.test(body), "/stats with no feed object says the feed is not up");

// and with one, sells are named in /stats and nowhere else
const tape = {
  async stats() { return { buys: 12, sells: 5, wallets: 9, newWallets: 7, lastBlock: 100, rounds: 3, gaps: 1, limited: 0, retries: 0 }; }
};
body = textOf(await handleUpdate(msg("/stats"), { env: {}, kv: fakeKV(), tape }));
t.ok(/Sells/.test(body), "/stats names sells");
t.ok(/never posted to the room/.test(body), "/stats says sells never reach the room");
t.ok(/Buys/.test(body), "/stats names buys");

t.done();
