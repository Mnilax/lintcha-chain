// The holder check, with no network: recovery from a signature, the one time mark, and the threshold.
// Specification section nine, the three cases about the signature and the two about the mark and the threshold.
//
//   node test/verify_test.mjs
import { recoverPersonal, recoverAddress, personalHash, normalizeAddress } from "../src/secp256k1.js";
import { checkHold, newNonce, spendNonce, normalizeNonce, getSession, putSession, dropSession, thresholdUnits, THRESHOLD_WHOLE_TOKENS, NONCE_TTL_SECONDS, SESSION_TTL_SECONDS } from "../src/verify.js";
import { sentenceFor, HOLDER_ORIGIN, SENTENCE_AFTER_MARK } from "../src/texts.js";
import { setGate, forgetDecimals, SEL } from "../src/chain.js";
import { harness, fakeKV, fakeGate, wordHex, FIXTURE, TOKEN_ADDRESS } from "./fakes.mjs";

const t = harness("verify");

// ---------------------------------------------------------------- recovery
const sentence = sentenceFor(FIXTURE.nonce);
const otherNonce = FIXTURE.nonce.slice(0, -1) + (FIXTURE.nonce.endsWith("0") ? "1" : "0");
t.ok(recoverPersonal(sentence, FIXTURE.signature) === FIXTURE.address, "the right signature over this origin and mark recovers the signer");
t.ok(recoverPersonal(sentenceFor(otherNonce), FIXTURE.signature) !== FIXTURE.address, "the same signature cannot be replayed with another one-time mark");
t.ok(recoverPersonal(sentence.replace(HOLDER_ORIGIN, "example.invalid"), FIXTURE.signature) !== FIXTURE.address, "the same signature cannot be moved to another origin");
t.ok(sentence.endsWith(SENTENCE_AFTER_MARK), "the signed bytes carry the exact nothing-moves assurance");

const altered = [
  sentence.replace("moves nothing", "moves everything"),
  sentence.replace("this wallet is mine", "this wallet is yours"),
  sentence + " ",
  " " + sentence,
  sentence.replace(".", "!")
];
for (const a of altered) t.ok(recoverPersonal(a, FIXTURE.signature) !== FIXTURE.address, "an altered sentence recovers somebody else: " + a.slice(0, 40));

const flipped = FIXTURE.signature.slice(0, 30) + (FIXTURE.signature[30] === "a" ? "b" : "a") + FIXTURE.signature.slice(31);
t.ok(recoverPersonal(sentence, flipped) !== FIXTURE.address, "an altered signature recovers somebody else");
t.ok(recoverAddress(personalHash(sentence), "0x00") === null, "a signature of the wrong length is refused");
t.ok(recoverAddress("0x00", FIXTURE.signature) === null, "a hash of the wrong length is refused");
t.ok(recoverAddress(personalHash(sentence), "0x" + "00".repeat(65)) === null, "an all zero signature is refused");
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
t.ok(normalizeNonce(FIXTURE.nonce) === FIXTURE.nonce, "the fixture mark has the one accepted canonical shape");
t.ok(normalizeNonce(FIXTURE.nonce.toUpperCase()) === null, "upper case is not silently rewritten into signed bytes");
t.ok(normalizeNonce(" " + FIXTURE.nonce) === null, "leading whitespace is not silently removed from signed bytes");
t.ok(normalizeNonce(FIXTURE.nonce + " ") === null, "trailing whitespace is not silently removed from signed bytes");
t.ok(normalizeNonce(FIXTURE.nonce.slice(1)) === null && normalizeNonce(FIXTURE.nonce + "0") === null, "only the generated mark length is accepted");

// ---------------------------------------------------------------- the threshold
t.ok(THRESHOLD_WHOLE_TOKENS === 500000n, "the threshold is five hundred thousand whole tokens");
t.ok(thresholdUnits(18) === 500000n * 10n ** 18n, "shifted by eighteen decimals");
t.ok(thresholdUnits(6) === 500000n * 10n ** 6n, "and by six");
t.ok(thresholdUnits(0) === 500000n, "and by none");

const token = { ok: true, address: TOKEN_ADDRESS, pons: null, uniswap: null };
const DEC = 18n;
async function issueFixture(store, telegramId = 7, nonce = FIXTURE.nonce) {
  await store.put("nonce:" + nonce, String(telegramId), { expirationTtl: NONCE_TTL_SECONDS });
  return nonce;
}
async function tryBalance(wholeTokens) {
  setGate(fakeGate({
    eth_chainId: "0x1237",
    ["eth_call:" + SEL.decimals]: wordHex(18),
    ["eth_call:" + SEL.balanceOf]: wordHex(BigInt(wholeTokens) * 10n ** DEC)
  }));
  forgetDecimals();
  const store = fakeKV();
  const m = await issueFixture(store);
  const r = await checkHold({}, store, { t: m, address: FIXTURE.address, signature: FIXTURE.signature }, token);
  return { r, store };
}

let { r, store } = await tryBalance(500000);
t.ok(r.ok === true, "exactly five hundred thousand passes");
t.ok((await getSession(store, 7)) === FIXTURE.address, "and the address is remembered");
t.ok(store.ttlOf("session:7") === SESSION_TTL_SECONDS && SESSION_TTL_SECONDS === 259200, "for three days");
r = await checkHold({}, store, { t: FIXTURE.nonce, address: FIXTURE.address, signature: FIXTURE.signature }, token);
t.ok(r.ok === false && r.why === "nonce", "the same signed request cannot be used twice");

({ r, store } = await tryBalance(499999));
t.ok(r.ok === false && r.why === "below", "one short of five hundred thousand is refused");
t.ok((await getSession(store, 7)) === null, "and nothing is remembered");

({ r } = await tryBalance(2500000));
t.ok(r.ok === true, "more than five hundred thousand passes");

// the balance one base unit short, which is the tightest case the threshold has
setGate(fakeGate({
  eth_chainId: "0x1237",
  ["eth_call:" + SEL.decimals]: wordHex(18),
  ["eth_call:" + SEL.balanceOf]: wordHex(500000n * 10n ** 18n - 1n)
}));
forgetDecimals();
let store2 = fakeKV();
let m2 = await issueFixture(store2);
r = await checkHold({}, store2, { t: m2, address: FIXTURE.address, signature: FIXTURE.signature }, token);
t.ok(r.ok === false && r.why === "below", "one base unit short of five hundred thousand is refused");

// ---------------------------------------------------------------- what must not get as far as the chain
setGate(fakeGate({ eth_chainId: "0x1237", ["eth_call:" + SEL.decimals]: wordHex(18), ["eth_call:" + SEL.balanceOf]: wordHex(0) }));
forgetDecimals();
store2 = fakeKV(); m2 = await issueFixture(store2);
r = await checkHold({}, store2, { t: m2, address: "0x0000000000000000000000000000000000000001", signature: FIXTURE.signature }, token);
t.ok(r.ok === false && r.why === "signature", "a signature that belongs to another address is refused");

store2 = fakeKV(); m2 = await issueFixture(store2);
r = await checkHold({}, store2, { t: m2, address: FIXTURE.address, signature: "0xdead" }, token);
t.ok(r.ok === false && r.why === "shape", "a signature of the wrong length is refused before any read");

store2 = fakeKV();
r = await checkHold({}, store2, { t: "aaaaaaaaaaaaaaaa", address: FIXTURE.address, signature: FIXTURE.signature }, token);
t.ok(r.ok === false && r.why === "shape", "a mark with the wrong canonical shape is refused before any read");

store2 = fakeKV(); m2 = await issueFixture(store2);
r = await checkHold({}, store2, { t: m2, address: FIXTURE.address, signature: FIXTURE.signature }, { ok: true, address: null });
t.ok(r.ok === false && r.why === "unreadable", "with no address on the site there is nothing to read a balance from");

// a chain that will not answer is not a holder who is short: the two must never collapse into one
setGate(fakeGate({ eth_chainId: "0x1237", ["eth_call:" + SEL.decimals]: new Error("endpoint down") }));
forgetDecimals();
store2 = fakeKV(); m2 = await issueFixture(store2);
r = await checkHold({}, store2, { t: m2, address: FIXTURE.address, signature: FIXTURE.signature }, token);
t.ok(r.ok === false && r.why === "unreadable", "a failed read says unreadable, never below");

// A valid signature plus a plausible wrong-chain balance must never mint a holder session.
setGate(fakeGate({
  eth_chainId: "0x1",
  ["eth_call:" + SEL.decimals]: wordHex(18),
  ["eth_call:" + SEL.balanceOf]: wordHex(2500000n * 10n ** 18n)
}));
forgetDecimals();
store2 = fakeKV(); m2 = await issueFixture(store2);
r = await checkHold({}, store2, { t: m2, address: FIXTURE.address, signature: FIXTURE.signature }, token);
t.ok(r.ok === false && r.why === "unreadable", "a plausible holder balance on another chain is unreadable");
t.ok((await getSession(store2, 7)) === null, "and the wrong chain creates no holder session");

// A valid signature is still scoped to its own fresh mark. Both marks belong to the same telegram id, so the
// refusal is the signature binding and not ownership of the link.
store2 = fakeKV();
await issueFixture(store2, 7, otherNonce);
r = await checkHold({}, store2, { t: otherNonce, address: FIXTURE.address, signature: FIXTURE.signature }, token);
t.ok(r.ok === false && r.why === "signature", "a captured signature is refused against a different fresh mark");
t.ok((await spendNonce(store2, otherNonce)) === null, "that attempted mark was spent exactly once");

// ---------------------------------------------------------------- sessions
const s3 = fakeKV();
await putSession(s3, 11, FIXTURE.address);
t.ok((await getSession(s3, 11)) === FIXTURE.address, "a session can be read back");
t.ok((await dropSession(s3, 11)) === true, "forget asks the store to delete the session");
t.ok((await getSession(s3, 11)) === null, "and it is gone");
t.ok((await dropSession(s3, 11)) === true, "forgetting twice repeats the idempotent delete rather than trusting a read");
let staleDelete = null;
const staleNegative = {
  async delete(key) { staleDelete = key; }
};
t.ok((await dropSession(staleNegative, 12)) === true && staleDelete === "session:12", "forget does not make an eventual KV read before deleting");
let rejected = false;
try { await dropSession({ async delete() { throw new Error("unconfirmed"); } }, 13); } catch { rejected = true; }
t.ok(rejected, "a rejected delete is not reported as acknowledged");

t.done();
