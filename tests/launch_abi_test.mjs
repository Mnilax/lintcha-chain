// The collector's own keccak and ABI codec (tools/launch/keccak.mjs, tools/launch/abi.mjs): published vectors, the
// selectors and topics every client agrees on, hand-written encodings from the ABI specification, and round trips.
//   node tests/launch_abi_test.mjs
import { keccakHex, selector, topic } from "../tools/launch/keccak.mjs";
import { T, encode, decode, calldata, decodeParams, bytesOf, TOKEN_INFO, TOKEN_PARAMS, AGGREGATE3_CALL, AGGREGATE3_RESULT } from "../tools/launch/abi.mjs";
import { hex } from "../tools/launch/keccak.mjs";
let checks = 0, failures = 0;
const fail = m => { failures++; console.error("FAIL " + m); };
const eq = (got, want, what) => { checks++; if (got !== want) fail(`${what}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`); };

// ---------------------------------------------------------------- keccak-256
eq(keccakHex(""), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", "keccak256 of the empty string");
eq(keccakHex("abc"), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45", "keccak256 of abc");
eq(keccakHex("a".repeat(200)), keccakHex(new TextEncoder().encode("a".repeat(200))), "string and bytes agree over two blocks");
eq(selector("name()"), "0x06fdde03", "selector name()");
eq(selector("symbol()"), "0x95d89b41", "selector symbol()");
eq(selector("aggregate3((address,bool,bytes)[])"), "0x82ad56cb", "selector aggregate3");
eq(topic("Transfer(address,address,uint256)"), "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", "topic Transfer");
eq(selector("getTokenInfo()").length, 10, "selector getTokenInfo() shape");

// ---------------------------------------------------------------- decode, hand-written vectors from the specification
const W = s => s.padStart(64, "0");
// (uint256 1, string "abc")
eq(JSON.stringify(decodeParams([T.uint, T.string], "0x" + W("1") + W("40") + W("3") + "616263".padEnd(64, "0")), (k, v) => typeof v === "bigint" ? v.toString() : v), '["1","abc"]', "decode (uint256,string)");
// a string return: name() -> "Bob"
eq(decodeParams([T.string], "0x" + W("20") + W("3") + "426f62".padEnd(64, "0"))[0], "Bob", "decode a string return through its head offset");
// address right-aligned in a word
eq(decodeParams([T.address], "0x" + W("cA11bde05977b3631167028862bE2a173976CA11".toLowerCase()))[0], "0xca11bde05977b3631167028862be2a173976ca11", "decode address");
eq(decodeParams([T.bool, T.bool], "0x" + W("1") + W("0")).join(), "true,false", "decode bool");
// a static tuple inside params takes as many head words as it has members
eq(decodeParams([T.tuple(T.uint, T.uint), T.uint], "0x" + W("7") + W("8") + W("9")).map(v => Array.isArray(v) ? v.map(String).join("+") : String(v)).join(), "7+8,9", "static tuple in place");

// ---------------------------------------------------------------- encode, hand-written expectations
eq(hex(encode(T.tuple(T.uint, T.string), [1n, "abc"])), W("1") + W("40") + W("3") + "616263".padEnd(64, "0"), "encode (uint256,string)");
eq(hex(encode(T.bool, true)), W("1"), "encode bool");
eq(hex(encode(T.bytes, "0x")), W("0"), "encode empty bytes");
// aggregate3 calldata with two calls: selector, offset to the array, length, two element offsets, two elements
const calls = [["0x" + "11".repeat(20), true, "0x06fdde03"], ["0x" + "22".repeat(20), false, "0x95d89b41"]];
const cd = calldata(selector("aggregate3((address,bool,bytes)[])"), [T.array(AGGREGATE3_CALL)], [calls]);
eq(cd.slice(0, 10), "0x82ad56cb", "aggregate3 selector");
eq(cd.slice(10, 74), W("20"), "aggregate3: offset to the array");
eq(cd.slice(74, 138), W("2"), "aggregate3: two calls");
eq(cd.slice(138, 202), W("40"), "aggregate3: first element offset (two offset words)");
eq(cd.slice(202, 266), W("e0"), "aggregate3: second element offset (first element is 7 words)");
eq(cd.slice(266, 330), W("11".repeat(20)), "aggregate3: first target");
eq(cd.slice(330, 394), W("1"), "aggregate3: allowFailure");
eq(cd.slice(394, 458), W("60"), "aggregate3: bytes offset inside the element");
eq(cd.slice(458, 522), W("4"), "aggregate3: callData length");
eq(cd.slice(522, 586), "06fdde03".padEnd(64, "0"), "aggregate3: callData padded");
eq((cd.length - 10) / 64, 1 + 1 + 2 + 5 + 5, "aggregate3: total words (offset, length, two offsets, two five-word elements)");
// the result decodes back: (bool,bytes)[] with two entries
const res = encode(T.tuple(AGGREGATE3_RESULT), [[[true, "0x" + W("20") + W("3") + "426f62".padEnd(64, "0")], [false, "0x"]]]);
const dec = decodeParams([AGGREGATE3_RESULT], res)[0];
eq(dec.length, 2, "aggregate3 result: two entries");
eq(dec[0][0], true, "aggregate3 result: success");
eq(decodeParams([T.string], dec[0][1])[0], "Bob", "aggregate3 result: inner return decodes as a string return");
eq(dec[1][0], false, "aggregate3 result: failure flagged");
eq(dec[1][1].length, 0, "aggregate3 result: empty returnData");

// ---------------------------------------------------------------- the fragments round-trip: getTokenInfo and TokenParams
const info = ["0x" + "ab".repeat(20), "ipfs://QmLogo", "a description with words", ["@bob", "t.me/bob", "", "https://bob.example", ""]];
const infoDec = decodeParams(TOKEN_INFO, encode(T.tuple(...TOKEN_INFO), info));
eq(JSON.stringify(infoDec), JSON.stringify(info), "getTokenInfo round trip: deployer, logo, description, socials");
const params = ["Bob Coin", "BOB", "ipfs://QmLogo", "twelve words of description text here to make the point clear", ["@bob", "", "", "", ""], "0x" + "cd".repeat(20), 100n, false, "0x" + "00".repeat(32), "0x" + "01".repeat(32)];
const input = calldata("0x12345678", [TOKEN_PARAMS, T.uint, T.address, T.uint], [params, 0n, "0x" + "00".repeat(20), 5n]);
const back = decodeParams([TOKEN_PARAMS, T.uint, T.address, T.uint], "0x" + input.slice(10));
eq(JSON.stringify(back[0], (k, v) => typeof v === "bigint" ? v.toString() : v), JSON.stringify(params, (k, v) => typeof v === "bigint" ? v.toString() : v), "TokenParams round trip as the first parameter of a launch call");
eq(String(back[3]), "5", "trailing static params after a dynamic tuple");
// utf8 in strings survives
eq(decode(T.string, encode(T.string, "café \u{1f680}")), "café \u{1f680}", "utf8 round trip");
eq(bytesOf("0x0aff").join(), "10,255", "bytesOf");

console.log(`launch abi test: ${checks} checks, ${failures} failure(s)`);
process.exit(failures ? 1 : 0);
