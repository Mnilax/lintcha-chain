// bot/src/keccak.js against digests published outside this repository, and against the repository's own
// keccak. The second half is the point: there are two keccaks in this tree now, one under tools/launch for the
// collector and one here for the worker, and the day they disagree a holder's balance would read as zero
// without anybody noticing. This test is the thing that notices.
//
//   node test/keccak_test.mjs
import { keccak256, hex, selector, topic } from "../src/keccak.js";
import { harness } from "./fakes.mjs";

const t = harness("keccak");
const utf8 = s => new TextEncoder().encode(s);
const d = s => hex(keccak256(utf8(s)));

// Keccak, not SHA3: the padding byte is 0x01, and with SHA3's 0x06 both of these differ in every byte
t.ok(d("") === "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", "keccak256 of the empty string");
t.ok(d("abc") === "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45", "keccak256 of abc");

// selectors and topics every wallet, explorer and library agrees on
for (const [sig, want] of [
  ["balanceOf(address)", "0x70a08231"],
  ["totalSupply()", "0x18160ddd"],
  ["decimals()", "0x313ce567"],
  ["symbol()", "0x95d89b41"],
  ["name()", "0x06fdde03"],
  ["transfer(address,uint256)", "0xa9059cbb"],
  ["slot0()", "0x3850c7bd"],
  ["aggregate3((address,bool,bytes)[])", "0x82ad56cb"]
]) t.ok(selector(sig) === want, `selector ${sig} should be ${want}, got ${selector(sig)}`);

t.ok(topic("Transfer(address,address,uint256)") === "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "the Transfer topic");

// more than one absorb round
t.ok(d("x".repeat(135)) !== d("x".repeat(136)), "the block boundary is not a collision");
t.ok(d("x".repeat(500)).length === 64, "a long message still yields thirty-two bytes");

// shape
t.ok(hex(keccak256("0x")) === d(""), "a 0x hex argument and empty bytes agree");
t.ok(keccak256(new Uint8Array([1, 2, 3])).length === 32, "bytes in, thirty-two out");

// ---------------------------------------------------------------- the two keccaks in this tree must agree
let theirs = null;
try {
  theirs = await import("../../tools/launch/keccak.mjs");
} catch (e) {
  t.ok(false, "tools/launch/keccak.mjs must be importable so the two implementations can be compared: " + e.message);
}
if (theirs) {
  const sigs = ["name()", "symbol()", "decimals()", "balanceOf(address)", "getLaunchedToken(address)", "getTokenInfo()", "aggregate3((address,bool,bytes)[])"];
  for (const s of sigs) {
    t.ok(String(theirs.selector(s)).toLowerCase() === selector(s), `the collector's selector for ${s} matches this one`);
  }
  for (const s of ["Transfer(address,address,uint256)", "TokenLaunched(address,address,address,address,uint256,uint256)"]) {
    t.ok(String(theirs.topic(s)).toLowerCase() === topic(s), `the collector's topic for ${s} matches this one`);
  }
  t.ok(theirs.hex(new Uint8Array([0, 1, 254, 255])) === hex(new Uint8Array([0, 1, 254, 255])), "and the two hex helpers agree");
}

t.done();
