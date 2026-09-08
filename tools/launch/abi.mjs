// A small ABI codec written from the Solidity ABI specification for the launch collector: enough to encode an
// aggregate3 call and to decode name(), symbol(), getTokenInfo(), the aggregate3 result and the TokenParams tuple in
// a launch transaction's input. Types are plain objects; nothing is copied from any library.
//
//   T.address T.uint T.bool T.bytes32 T.string T.bytes   T.tuple(...components)   T.array(component)
//   encode(type, value) -> Uint8Array          decode(type, data) -> value        (data: Uint8Array or 0x hex)
//   calldata(selector, paramTypes, values)     decodeParams(paramTypes, data)     (data without the selector)
import { hex } from "./keccak.mjs";

export const T = {
  address: { t: "address" }, uint: { t: "uint" }, bool: { t: "bool" }, bytes32: { t: "bytes32" },
  string: { t: "string" }, bytes: { t: "bytes" },
  tuple: (...c) => ({ t: "tuple", c }), array: c => ({ t: "array", c })
};
const isDynamic = ty => ty.t === "string" || ty.t === "bytes" || ty.t === "array" || (ty.t === "tuple" && ty.c.some(isDynamic));
const headWords = ty => ty.t === "tuple" && !isDynamic(ty) ? ty.c.reduce((n, c) => n + headWords(c), 0) : 1;

export const bytesOf = data => typeof data === "string" ? Uint8Array.from((data.startsWith("0x") ? data.slice(2) : data).match(/../g) || [], h => parseInt(h, 16)) : data;
const word = (data, at) => { let v = 0n; for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(data[at + i] ?? 0); return v; };
const pad32 = n => Math.ceil(n / 32) * 32;
const cat = parts => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const wordOf = v => { const out = new Uint8Array(32); let x = BigInt(v); for (let i = 31; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; } return out; };

// ---------------------------------------------------------------- decode
function decodeAt(ty, data, at) {
  switch (ty.t) {
    case "address": return "0x" + hex(data.slice(at + 12, at + 32));
    case "uint": return word(data, at);
    case "bool": return word(data, at) !== 0n;
    case "bytes32": return "0x" + hex(data.slice(at, at + 32));
    case "bytes": { const n = Number(word(data, at)); return data.slice(at + 32, at + 32 + n); }
    case "string": { const n = Number(word(data, at)); return new TextDecoder().decode(data.slice(at + 32, at + 32 + n)); }
    case "tuple": return decodeTuple(ty.c, data, at);
    case "array": { const n = Number(word(data, at)); return decodeTuple(new Array(n).fill(ty.c), data, at + 32); }
    default: throw new Error("unknown type " + ty.t);
  }
}
function decodeTuple(comps, data, base) {
  const out = []; let head = base;
  for (const c of comps) {
    if (isDynamic(c)) { out.push(decodeAt(c, data, base + Number(word(data, head)))); head += 32; }
    else { out.push(decodeAt(c, data, head)); head += 32 * headWords(c); }
  }
  return out;
}
export const decode = (ty, data) => decodeAt(ty, bytesOf(data), 0);
export const decodeParams = (types, data) => decodeTuple(types, bytesOf(data), 0);

// ---------------------------------------------------------------- encode
function encodeOne(ty, v) {
  switch (ty.t) {
    case "address": return wordOf(BigInt(v));
    case "uint": return wordOf(v);
    case "bool": return wordOf(v ? 1 : 0);
    case "bytes32": return bytesOf(v);
    case "bytes": { const b = bytesOf(v), out = new Uint8Array(32 + pad32(b.length)); out.set(wordOf(b.length)); out.set(b, 32); return out; }
    case "string": return encodeOne(T.bytes, new TextEncoder().encode(v));
    case "tuple": return encodeTuple(ty.c, v);
    case "array": return cat([wordOf(v.length), encodeTuple(new Array(v.length).fill(ty.c), v)]);
    default: throw new Error("unknown type " + ty.t);
  }
}
function encodeTuple(comps, values) {
  const heads = [], tails = [];
  let headLen = comps.reduce((n, c) => n + 32 * headWords(c), 0), tailLen = 0;
  comps.forEach((c, i) => {
    const enc = encodeOne(c, values[i]);
    if (isDynamic(c)) { heads.push(wordOf(headLen + tailLen)); tails.push(enc); tailLen += enc.length; }
    else heads.push(enc);
  });
  return cat(heads.concat(tails));
}
export const encode = (ty, v) => encodeOne(ty, v);
export const calldata = (selector, types, values) => "0x" + selector.replace(/^0x/, "") + hex(encodeTuple(types, values));

// ---------------------------------------------------------------- the fragments this collector uses, written by hand from section 10
export const SOCIALS = T.tuple(T.string, T.string, T.string, T.string, T.string);                       // twitter, telegram, discord, website, farcaster
export const TOKEN_INFO = [T.address, T.string, T.string, SOCIALS];                                       // getTokenInfo() returns
export const TOKEN_PARAMS = T.tuple(T.string, T.string, T.string, T.string, SOCIALS, T.address, T.uint, T.bool, T.bytes32, T.bytes32);
//   name, symbol, logo, description, socials, creatorFeeRecipient, creatorTaxBps, buybackEnabled, expectedEconomics, salt
export const LAUNCHED_TOKEN = T.tuple(T.address, T.address, T.address, T.address, T.address, T.uint, T.uint, T.uint, T.uint, T.bool, T.uint, T.uint, T.uint, T.uint, T.bool);
//   factory.getLaunchedToken(address) returns: token, curve, deployer, creatorFeeRecipient, pairToken, graduationThreshold,
//   poolFee, tickSpacing, creatorTaxBps, buybackEnabled, phase, sweptQuote, sweptTokens, sweptAt, exists (all static: fifteen words)
export const AGGREGATE3_CALL = T.tuple(T.address, T.bool, T.bytes);                                      // target, allowFailure, callData
export const AGGREGATE3_RESULT = T.array(T.tuple(T.bool, T.bytes));                                      // success, returnData
