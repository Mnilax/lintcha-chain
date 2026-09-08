// keccak-256 as Ethereum uses it (the original Keccak padding, not the SHA-3 domain byte), written from the
// specification for the launch collector: function selectors and event topics. BigInt lanes, no dependency.
// Pinned in tests/launch_abi_test.mjs against the published vectors (the empty string, "abc") and the four
// selectors and topics every Ethereum client agrees on.
const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n
];
// rotation offsets r[x][y], x along the first index
const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
const RATE = 136;   // bytes absorbed per block for a 256-bit output

const rot = (v, n) => n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK;

function permute(A) {   // A: 25 lanes, index x + 5 * y
  for (let round = 0; round < 24; round++) {
    const C = [0, 1, 2, 3, 4].map(x => A[x] ^ A[x + 5] ^ A[x + 10] ^ A[x + 15] ^ A[x + 20]);
    for (let x = 0; x < 5; x++) {
      const D = C[(x + 4) % 5] ^ rot(C[(x + 1) % 5], 1);
      for (let y = 0; y < 5; y++) A[x + 5 * y] ^= D;
    }
    const B = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rot(A[x + 5 * y], ROT[x][y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) A[x + 5 * y] = B[x + 5 * y] ^ ((~B[(x + 1) % 5 + 5 * y] & MASK) & B[(x + 2) % 5 + 5 * y]);
    A[0] ^= RC[round];
  }
}

/** keccak256 of a Uint8Array or a utf8 string; returns 32 bytes. */
export function keccak256(input) {
  const msg = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const padded = new Uint8Array(Math.ceil((msg.length + 1) / RATE) * RATE);
  padded.set(msg); padded[msg.length] ^= 0x01; padded[padded.length - 1] ^= 0x80;
  const A = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(padded[off + 8 * i + b]);
      A[i] ^= lane;
    }
    permute(A);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) { let lane = A[i]; for (let b = 0; b < 8; b++) { out[8 * i + b] = Number(lane & 0xffn); lane >>= 8n; } }
  return out;
}
export const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
export const keccakHex = input => hex(keccak256(input));
/** the four-byte selector of a function signature, "0x" + 8 hex */
export const selector = signature => "0x" + keccakHex(signature).slice(0, 8);
/** the topic of an event signature, "0x" + 64 hex */
export const topic = signature => "0x" + keccakHex(signature);
