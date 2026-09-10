// Reading the site and reading the chain, with no network. Specification section two: the address comes from
// the site, is cached in memory for no longer than a minute, and an unreadable site is not an absent token.
//
//   node test/chain_test.mjs
import { readToken, forgetToken, forgetDecimals, hasToken, setGate, balanceOf, decimalsOf, totalSupply, launchRecord, venueOf, transfersAround, priceInPair, SEL, TOPIC_TRANSFER, CHAIN_ID, FACTORY, chainIsOurs, blockNumber } from "../src/chain.js";
import { harness, fakeGate, fakeNetwork, wordHex, topicAddr, launchRecordHex, TOKEN_ADDRESS, VENUE_ADDRESS, WALLET_ADDRESS, FIXTURE } from "./fakes.mjs";

const t = harness("chain");
const net = fakeNetwork();

// ---------------------------------------------------------------- the address is the site's, not the bot's
forgetToken();
net.site = { address: null, pons: null, uniswap: null };
let tok = await readToken({});
t.ok(tok.ok === true && tok.address === null, "three null read as a file that exists with no address");
t.ok(hasToken(tok) === false, "and nothing depending on an address may run");

forgetToken();
net.site = { address: TOKEN_ADDRESS.toUpperCase(), pons: " https://example.invalid/pons ", uniswap: "" };
tok = await readToken({});
t.ok(tok.address === TOKEN_ADDRESS, "an address is lowered");
t.ok(tok.pons === "https://example.invalid/pons", "a link is trimmed");
t.ok(tok.uniswap === null, "an empty link reads as none at all");
t.ok(hasToken(tok) === true, "and now the address commands may run");

forgetToken();
net.site = { address: "not an address", pons: null, uniswap: null };
tok = await readToken({});
t.ok(tok.address === null, "something that is not an address is not accepted as one");

forgetToken();
net.siteOk = false;
tok = await readToken({});
t.ok(tok.ok === false, "an unreadable site says so");
t.ok(tok.address === undefined || tok.address === null, "and offers no address at all");
net.siteOk = true;

// ---------------------------------------------------------------- the memory cache, and its ceiling
forgetToken();
net.site = { address: TOKEN_ADDRESS, pons: null, uniswap: null };
await readToken({}, 1000);
net.site = { address: null, pons: null, uniswap: null };
t.ok((await readToken({}, 1000 + 59000)).address === TOKEN_ADDRESS, "the answer is still cached at fifty-nine seconds");
t.ok((await readToken({}, 1000 + 60001)).address === null, "and read again once a minute has gone by");

// a failed read does not poison the cache with a stale address
forgetToken();
net.site = { address: TOKEN_ADDRESS, pons: null, uniswap: null };
await readToken({}, 5000);
net.siteOk = false;
t.ok((await readToken({}, 5000 + 90000)).ok === false, "after the cache expires a failed read reports the failure");
net.siteOk = true;

// ---------------------------------------------------------------- the chain the collector reads
setGate(fakeGate({ eth_chainId: "0x1237" }));
t.ok(CHAIN_ID === 4663n, "the chain id is the one the collector has");
t.ok((await chainIsOurs({})) === true, "and 0x1237 is that chain");
setGate(fakeGate({ eth_chainId: "0x1" }));
t.ok((await chainIsOurs({})) === false, "another chain is refused");

// ---------------------------------------------------------------- reads, and what a failed read gives back
forgetDecimals();
setGate(fakeGate({
  ["eth_call:" + SEL.balanceOf]: wordHex(7n * 10n ** 18n),
  ["eth_call:" + SEL.decimals]: wordHex(18),
  ["eth_call:" + SEL.totalSupply]: wordHex(1000000000n * 10n ** 18n),
  ["eth_call:" + SEL.launched]: launchRecordHex({ curve: VENUE_ADDRESS }),
  eth_blockNumber: "0x1a"
}));
t.ok((await balanceOf({}, TOKEN_ADDRESS, FIXTURE.address)) === 7n * 10n ** 18n, "a balance comes back as base units");
t.ok((await decimalsOf({}, TOKEN_ADDRESS)) === 18, "decimals come back as a number");
t.ok((await totalSupply({}, TOKEN_ADDRESS)) === 1000000000n * 10n ** 18n, "so does the supply");
t.ok((await blockNumber({})) === 26, "and the head block");
const rec = await launchRecord({}, TOKEN_ADDRESS);
t.ok(rec && rec.curve === VENUE_ADDRESS && rec.exists === true, "the factory record gives the curve and says the token exists");
t.ok((await venueOf({}, TOKEN_ADDRESS)) === VENUE_ADDRESS, "so the venue is the curve when nothing is configured");
t.ok((await venueOf({ FEED_VENUE: VENUE_ADDRESS.replace("2", "5") }, TOKEN_ADDRESS)) === VENUE_ADDRESS.replace("2", "5"), "and a configured venue wins");

forgetDecimals();
setGate(fakeGate({
  ["eth_call:" + SEL.balanceOf]: new Error("down"),
  ["eth_call:" + SEL.decimals]: new Error("down"),
  ["eth_call:" + SEL.totalSupply]: new Error("down"),
  ["eth_call:" + SEL.launched]: new Error("down"),
  eth_blockNumber: new Error("down")
}));
t.ok((await balanceOf({}, TOKEN_ADDRESS, FIXTURE.address)) === null, "a failed balance read is null, never zero");
t.ok((await decimalsOf({}, TOKEN_ADDRESS)) === null, "a failed decimals read is null");
t.ok((await totalSupply({}, TOKEN_ADDRESS)) === null, "a failed supply read is null");
t.ok((await launchRecord({}, TOKEN_ADDRESS)) === null, "a failed record read is null");
t.ok((await blockNumber({})) === null, "a failed head read is null");
t.ok((await venueOf({}, TOKEN_ADDRESS)) === null, "and then there is no venue rather than a guessed one");

// ---------------------------------------------------------------- buys and sells, by which side the venue is on
setGate(fakeGate({
  eth_getLogs: [
    { topics: [TOPIC_TRANSFER, topicAddr(VENUE_ADDRESS), topicAddr(WALLET_ADDRESS)], data: wordHex(5n), blockNumber: "0x10", transactionHash: "0xaa", logIndex: "0x0" },
    { topics: [TOPIC_TRANSFER, topicAddr(WALLET_ADDRESS), topicAddr(VENUE_ADDRESS)], data: wordHex(2n), blockNumber: "0x11", transactionHash: "0xbb", logIndex: "0x1" },
    { topics: [TOPIC_TRANSFER, topicAddr(WALLET_ADDRESS), topicAddr(FIXTURE.address)], data: wordHex(1n), blockNumber: "0x12", transactionHash: "0xcc", logIndex: "0x2" },
    { topics: [TOPIC_TRANSFER], data: wordHex(1n), blockNumber: "0x13", transactionHash: "0xdd", logIndex: "0x3" }
  ]
}));
const split = await transfersAround({}, TOKEN_ADDRESS, VENUE_ADDRESS, 16, 19);
t.ok(split.buys.length === 1, "the venue sending tokens out is one buy");
t.ok(split.buys[0].wallet === WALLET_ADDRESS && split.buys[0].amount === 5n, "with the wallet and the amount off the log");
t.ok(split.buys[0].tx === "0xaa" && split.buys[0].block === 16, "and the transaction and block");
t.ok(split.sells.length === 1 && split.sells[0].amount === 2n, "the venue receiving is one sell");
t.ok(split.buys.length + split.sells.length === 2, "a wallet to wallet transfer is neither, and a log with no topics is skipped");

setGate(fakeGate({ eth_getLogs: new Error("down") }));
t.ok((await transfersAround({}, TOKEN_ADDRESS, VENUE_ADDRESS, 1, 2)) === null, "a failed log read is null, not an empty round");

// ---------------------------------------------------------------- the price, which is only read from a shape it knows
setGate(fakeGate({ ["eth_call:" + SEL.slot0]: wordHex(2n ** 96n) }));
t.ok((await priceInPair({}, VENUE_ADDRESS, 18, 18, true)) === null, "with no venue kind set there is no price");
t.ok((await priceInPair({ VENUE_KIND: "v3" }, VENUE_ADDRESS, 18, 18, true)) === 1, "a square root price of one squared is one");
setGate(fakeGate({ ["eth_call:" + SEL.slot0]: wordHex(0) }));
t.ok((await priceInPair({ VENUE_KIND: "v3" }, VENUE_ADDRESS, 18, 18, true)) === null, "a zero from the pool is not a price of zero");
setGate(fakeGate({ ["eth_call:" + SEL.slot0]: new Error("down") }));
t.ok((await priceInPair({ VENUE_KIND: "v3" }, VENUE_ADDRESS, 18, 18, true)) === null, "and a failed read is not a price either");

// ---------------------------------------------------------------- the factory is the one the collector names
t.ok(FACTORY === "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e", "the factory address is the collector's");

t.done();
