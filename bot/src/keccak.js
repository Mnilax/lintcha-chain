// Keccak-256, written from FIPS 202 and the original Keccak submission. Nothing is copied from any library.
//
// Why this file exists at all: the repository already has one, tools/launch/keccak.mjs, and the rule of this
// project is to vendor rather than to write a second implementation. That file was not in the round D workset,
// so its bytes could not be copied here. Two things keep the pair honest instead of hopeful:
//
//   bot/test/keccak_test.mjs   checks this file against published digests and against the four ERC-20 selectors
//                              every wallet and explorer agrees on, and then against tools/launch/keccak.mjs
//                              itself, so the day the two disagree a test says so rather than a holder's balance
//                              silently reading zero.
//
// The API is the one the collector already uses (tools/launch-collect.mjs line twenty-one and abi.mjs line eight):
// hex(bytes), selector("name()"), topic("Transfer(address,address,uint256)"). Same names, same meanings, so the
// two files can be compared directly and one can replace the other.
//
// Keccak-256 is Keccak-f[1600] with a rate of a hundred and thirty-six bytes and the original padding, 0x01,
// not SHA3's 0x06. Getting that one byte wrong yields SHA3-256, which is a different function with the same
// output size, so the test pins a published Keccak digest rather than trusting the name.

const MASK = (1n << 64n) - 1n;

// the twenty-four round constants of iota, from the reference implementation's table
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];

// the rotation offsets of rho, indexed [x][y]
const ROT = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14]
];

const rotl = (v, n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);

// the permutation, in place on twenty-five lanes held as BigInt: theta, rho and pi, chi, iota
function permute(A) {
  const C = new Array(5), D = new Array(5), B = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) C[x] = A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20];
    for (let x = 0; x < 5; x++) D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) A[x + 5 * y] ^= D[x];
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(A[x + 5 * y], ROT[x][y]);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
      A[x + 5 * y] = B[x + 5 * y] ^ ((~B[(x + 1) % 5 + 5 * y] & MASK) & B[(x + 2) % 5 + 5 * y]);
    }
    A[0] ^= RC[round];
  }
}

const RATE = 136;   // (1600 - 2 * 256) / 8

/** keccak256(bytes) -> Uint8Array of thirty-two bytes. Accepts a Uint8Array or a 0x hex string. */
export function keccak256(input) {
  const msg = bytesOf(input);
  const pad = RATE - (msg.length % RATE);          // always between one and RATE, so the padding is never empty
  const buf = new Uint8Array(msg.length + pad);
  buf.set(msg);
  buf[msg.length] = 0x01;                          // Keccak's own padding, not SHA3's 0x06
  buf[buf.length - 1] |= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < buf.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(buf[off + i * 8 + b]);   // lanes are little endian
      A[i] ^= lane;
    }
    permute(A);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = A[i];
    for (let b = 0; b < 8; b++) { out[i * 8 + b] = Number(lane & 0xffn); lane >>= 8n; }
  }
  return out;
}

/** the bytes of a Uint8Array or a 0x hex string, as a Uint8Array */
export function bytesOf(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === "string") {
    const s = data.startsWith("0x") || data.startsWith("0X") ? data.slice(2) : data;
    if (s.length % 2) throw new Error("hex string of odd length");
    return Uint8Array.from(s.match(/../g) || [], h => {
      const n = parseInt(h, 16);
      if (Number.isNaN(n)) throw new Error("not hex: " + h);
      return n;
    });
  }
  throw new Error("expected bytes or a hex string");
}

/** lower case hex of some bytes, with no 0x */
export const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");

const utf8 = s => new TextEncoder().encode(s);

/** the four byte function selector of a signature: selector("balanceOf(address)") -> "0x70a08231" */
export const selector = signature => "0x" + hex(keccak256(utf8(signature)).slice(0, 4));

/** the thirty-two byte event topic of a signature: topic("Transfer(address,address,uint256)") */
export const topic = signature => "0x" + hex(keccak256(utf8(signature)));

/** keccak256 of a utf8 string, as 0x hex */
export const keccakText = s => "0x" + hex(keccak256(utf8(s)));
