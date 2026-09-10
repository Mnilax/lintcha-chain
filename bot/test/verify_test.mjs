// The holder check, with no network: recovery from a signature, the one time mark, and the threshold.
// Specification section nine, the three cases about the signature and the two about the mark and the threshold.
//
//   node test/verify_test.mjs
import { recoverPersonal, recoverAddress, personalHash, normalizeAddress } from "../src/secp256k1.js";
import { checkHold, newNonce, spendNonce, getSession, putSession, dropSession, thresholdUnits, THRESHOLD_WHOLE_TOKENS, NONCE_TTL_SECONDS, SESSION_TTL_SECONDS } from "../src/verify.js";
import { SENTENCE } from "../src/texts.js";
import { setGate, forgetDecimals, SEL } from "../src/chain.js";
import { harness, fakeKV, fakeGate, wordHex, FIXTURE, TOKEN_ADDRESS } from "./fakes.mjs";

const t = harness("verify");

// ---------------------------------------------------------------- recovery
t.ok(recoverPersonal(SENTENCE, FIXTURE.signature) === FIXTURE.address, "the right signature over the right sentence recovers the signer");

const altered = [
  SENTENCE.replace("moves nothing", "moves everything"),
  SENTENCE.replace("this wallet is mine", "this wallet is yours"),
  SENTENCE + " ",
  " " + SENTENCE,
  SENTENCE.replace(".", "!")
];
for (const a of altered) t.ok(recoverPersonal(a, FIXTURE.signature) !== FIXTURE.address, "an altered sentence recovers somebody else: " + a.slice(0, 40));

const flipped = FIXTURE.signature.slice(0, 30) + (FIXTURE.signature[30] === "a" ? "b" : "a") + FIXTURE.signature.slice(31);
t.ok(recoverPersonal(SENTENCE, flipped) !== FIXTURE.address, "an altered signature recovers somebody else");
t.ok(recoverAddress(personalHash(SENTENCE), "0x00") === null, "a signature of the wrong length is refused");
t.ok(recoverAddress("0x00", FIXTURE.signature) === null, "a hash of the wrong length is refused");
t.ok(recoverAddress(personalHash(SENTENCE), "0x" + "00".repeat(65)) === null, "an all zero signature is refused");
t.ok(normalizeAddress("0xABC") === null, "a short address is refused");
t.ok(normalizeAddress(" " + FIXTURE.address.toUpperCase() + " ") === FIXTURE.address, "an address is trimmed and lowered");

// ---------------------------------------------------------------- the one time mark
const kv = fakeKV();
const mark = await newNonce(kv, 4242);
t.ok(/^[0-9a-f]{32}$/.test(mark), "the mark is random hex");
t.ok(kv.ttlOf("nonce:" + mark) === NONCE_TTL_SECONDS && NONCE_TTL_SECONDS === 900, "it lives fifteen minutes");
t.ok((await spendNonce(kv, mark)) === "4242", "the first use gives back the telegram id");
t.ok((await spendNonce(kv, mark)) === null, "the same mark a second time is refused");
t.ok((await spendNonce(kv, "0123456789abcdef")) === null, "a mark that was never issued is refused");
t.ok((await spendNonce(kv, "../nonce")) === null, "a mark of the wrong shape never reaches the store");

// ---------------------------------------------------------------- the threshold
t.ok(THRESHOLD_WHOLE_TOKENS === 1000000n, "the threshold is one million whole tokens");
t.ok(thresholdUnits(18) === 1000000n * 10n ** 18n, "shifted by eighteen decimals");
t.ok(thresholdUnits(6) === 1000000n * 10n ** 6n, "and by six");
t.ok(thresholdUnits(0) === 1000000n, "and by none");

const token = { ok: true, address: TOKEN_ADDRESS, pons: null, uniswap: null };
const DEC = 18n;
async function tryBalance(wholeTokens) {
  setGate(fakeGate({
    ["eth_call:" + SEL.decimals]: wordHex(18),
    ["eth_call:" + SEL.balanceOf]: wordHex(BigInt(wholeTokens) * 10n ** DEC)
  }));
  forgetDecimals();
  const store = fakeKV();
  const m = await newNonce(store, 7);
  const r = await checkHold({}, store, { t: m, address: FIXTURE.address, signature: FIXTURE.signature }, token);
  return { r, store };
}

let { r, store } = await tryBalance(1000000);
t.ok(r.ok === true, "exactly one million passes");
t.ok((await getSession(store, 7)) === FIXTURE.address, "and the address is remembered");
t.ok(store.ttlOf("session:7") === SESSION_TTL_SECONDS && SESSION_TTL_SECONDS === 259200, "for three days");

({ r, store } = await tryBalance(999999));
t.ok(r.ok === false && r.why === "below", "one short of a million is refused");
t.ok((await getSession(store, 7)) === null, "and nothing is remembered");

({ r } = await tryBalance(2500000));
t.ok(r.ok === true, "more than a million passes");

// the balance one base unit short, which is the tightest case the threshold has
setGate(fakeGate({
  ["eth_call:" + SEL.decimals]: wordHex(18),
  ["eth_call:" + SEL.balanceOf]: wordHex(1000000n * 10n ** 18n - 1n)
}));
forgetDecimals();
let store2 = fakeKV();
let m2 = await newNonce(store2, 7);
r = await checkHold({}, store2, { t: m2, address: FIXTURE.address, signature: FIXTURE.signature }, token);
t.ok(r.ok === false && r.why === "below", "one base unit short of a million is refused");

// ---------------------------------------------------------------- what must not get as far as the chain
setGate(fakeGate({ ["eth_call:" + SEL.decimals]: wordHex(18), ["eth_call:" + SEL.balanceOf]: wordHex(0) }));
forgetDecimals();
store2 = fakeKV(); m2 = await newNonce(store2, 7);
r = await checkHold({}, store2, { t: m2, address: "0x0000000000000000000000000000000000000001", signature: FIXTURE.signature }, token);
t.ok(r.ok === false && r.why === "signature", "a signature that belongs to another address is refused");

store2 = fakeKV(); m2 = await newNonce(store2, 7);
r = await checkHold({}, store2, { t: m2, address: FIXTURE.address, signature: "0xdead" }, token);
t.ok(r.ok === false && r.why === "shape", "a signature of the wrong length is refused before any read");

store2 = fakeKV();
r = await checkHold({}, store2, { t: "aaaaaaaaaaaaaaaa", address: FIXTURE.address, signature: FIXTURE.signature }, token);
t.ok(r.ok === false && r.why === "nonce", "an unissued mark is refused before any read");

store2 = fakeKV(); m2 = await newNonce(store2, 7);
r = await checkHold({}, store2, { t: m2, address: FIXTURE.address, signature: FIXTURE.signature }, { ok: true, address: null });
t.ok(r.ok === false && r.why === "unreadable", "with no address on the site there is nothing to read a balance from");

// a chain that will not answer is not a holder who is short: the two must never collapse into one
setGate(fakeGate({ ["eth_call:" + SEL.decimals]: new Error("endpoint down") }));
forgetDecimals();
store2 = fakeKV(); m2 = await newNonce(store2, 7);
r = await checkHold({}, store2, { t: m2, address: FIXTURE.address, signature: FIXTURE.signature }, token);
t.ok(r.ok === false && r.why === "unreadable", "a failed read says unreadable, never below");

// ---------------------------------------------------------------- sessions
const s3 = fakeKV();
await putSession(s3, 11, FIXTURE.address);
t.ok((await getSession(s3, 11)) === FIXTURE.address, "a session can be read back");
t.ok((await dropSession(s3, 11)) === true, "forget drops it and says so");
t.ok((await getSession(s3, 11)) === null, "and it is gone");
t.ok((await dropSession(s3, 11)) === false, "forgetting twice says there was nothing");

t.done();
