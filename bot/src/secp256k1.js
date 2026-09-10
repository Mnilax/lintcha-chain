// secp256k1 public key recovery, written from SEC 1 section 4.1.6 and the curve's published parameters.
// Nothing is copied from any library.
//
// Why this file exists: section four of the round D specification requires the worker to recover the address
// from the signature and compare it with the one the page sent. There is nothing in this repository to vendor
// for that, nothing in the Workers runtime that does it, and no RPC method that does it either: personal_ecRecover
// belongs to a wallet, not to a node, and eth_ecRecover is not standard. Section nine also requires the check to
// be tested with no network at all, so it has to be local code.
//
// This module recovers only. It has no signing, no key generation and no function that takes a private key,
// because the bot must never be in a position to hold one. What it exports is:
//
//   recoverAddress(hash32, signature65)   -> "0x..." lower case, or null when the signature is not usable
//   personalHash(message)                -> the EIP-191 hash a wallet signs for personal_sign
//   recoverPersonal(message, signature65) -> the address that signed that exact sentence, or null
//
// Every failure returns null rather than throwing, and no failure says which of the checks rejected the input:
// a caller answering a stranger should not narrate its own reasons.

import { keccak256, hex, bytesOf } from "./keccak.js";

// the curve, from its published parameters
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;   // 2^256 - 2^32 - 977
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;   // the group order
const B = 7n;                                                                     // y^2 = x^3 + 7
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

const mod = (a, m) => ((a % m) + m) % m;

// modular inverse by the extended Euclidean algorithm; returns null when there is none
function inv(a, m) {
  let [old_r, r] = [mod(a, m), m];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) return null;
  return mod(old_s, m);
}

// a^e mod m by square and multiply
function pow(a, e, m) {
  let base = mod(a, m), acc = 1n, exp = e;
  while (exp > 0n) {
    if (exp & 1n) acc = (acc * base) % m;
    base = (base * base) % m;
    exp >>= 1n;
  }
  return acc;
}

// ---------------------------------------------------------------- Jacobian points: x = X/Z^2, y = Y/Z^3, Z = 0 is infinity
const INF = { X: 0n, Y: 1n, Z: 0n };

function double(p) {
  if (p.Z === 0n || p.Y === 0n) return INF;
  const A = (p.X * p.X) % P;
  const Bq = (p.Y * p.Y) % P;
  const C = (Bq * Bq) % P;
  let D = (p.X + Bq) % P;
  D = (D * D) % P;
  D = mod(D - A - C, P);
  D = (2n * D) % P;
  const E = (3n * A) % P;
  const F = (E * E) % P;
  const X = mod(F - 2n * D, P);
  const Y = mod(E * mod(D - X, P) - 8n * C, P);
  const Z = (2n * p.Y * p.Z) % P;
  return { X, Y, Z };
}

function add(p, q) {
  if (p.Z === 0n) return q;
  if (q.Z === 0n) return p;
  const Z1Z1 = (p.Z * p.Z) % P;
  const Z2Z2 = (q.Z * q.Z) % P;
  const U1 = (p.X * Z2Z2) % P;
  const U2 = (q.X * Z1Z1) % P;
  const S1 = (p.Y * Z2Z2 % P) * q.Z % P;
  const S2 = (q.Y * Z1Z1 % P) * p.Z % P;
  const H = mod(U2 - U1, P);
  const rr = mod(2n * (S2 - S1), P);
  if (H === 0n) return rr === 0n ? double(p) : INF;
  let I = (2n * H) % P; I = (I * I) % P;
  const J = (H * I) % P;
  const V = (U1 * I) % P;
  const X = mod(rr * rr - J - 2n * V, P);
  const Y = mod(rr * mod(V - X, P) - 2n * S1 % P * J, P);
  let Z = mod(p.Z + q.Z, P); Z = (Z * Z) % P;
  Z = mod(Z - Z1Z1 - Z2Z2, P);
  Z = (Z * H) % P;
  return { X, Y, Z };
}

// double and add, most significant bit first. Not constant time on purpose: everything here is public.
function multiply(point, k) {
  let acc = INF, base = point, e = mod(k, N);
  while (e > 0n) {
    if (e & 1n) acc = add(acc, base);
    base = double(base);
    e >>= 1n;
  }
  return acc;
}

function affine(p) {
  if (p.Z === 0n) return null;
  const zi = inv(p.Z, P);
  if (zi === null) return null;
  const zi2 = (zi * zi) % P;
  return { x: (p.X * zi2) % P, y: (p.Y * zi2 % P) * zi % P };
}

const G = { X: GX, Y: GY, Z: 1n };

// ---------------------------------------------------------------- recovery
const toBig = bytes => { let v = 0n; for (const b of bytes) v = (v << 8n) | BigInt(b); return v; };
const to32 = v => { const out = new Uint8Array(32); let x = v; for (let i = 31; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; } return out; };

/**
 * The address that produced this signature over this hash, or null.
 * hash32: thirty-two bytes, or 0x hex. signature65: r (thirty-two) s (thirty-two) v (one), or 0x hex.
 */
export function recoverAddress(hash32, signature65) {
  let hash, sig;
  try { hash = bytesOf(hash32); sig = bytesOf(signature65); } catch { return null; }
  if (hash.length !== 32 || sig.length !== 65) return null;

  const r = toBig(sig.slice(0, 32));
  const s = toBig(sig.slice(32, 64));
  const vRaw = sig[64];
  // wallets send twenty-seven or twenty-eight; some send zero or one; anything else is not ours to guess at
  const recid = vRaw >= 27 ? vRaw - 27 : vRaw;
  if (recid < 0 || recid > 3) return null;
  if (r <= 0n || r >= N || s <= 0n || s >= N) return null;

  // x of R, plus the group order once when the recovery id says the x overflowed
  const x = r + (BigInt(recid >> 1) * N);
  if (x >= P) return null;

  // y^2 = x^3 + 7, and p is three modulo four, so the square root is a single exponentiation
  const y2 = mod(pow(x, 3n, P) + B, P);
  let y = pow(y2, (P + 1n) / 4n, P);
  if ((y * y) % P !== y2) return null;                       // x is not on the curve
  if ((y & 1n) !== BigInt(recid & 1)) y = mod(P - y, P);

  const R = { X: x, Y: y, Z: 1n };
  const e = mod(toBig(hash), N);
  const rinv = inv(r, N);
  if (rinv === null) return null;

  // Q = r^-1 (sR - eG)
  const Q = add(multiply(R, (s * rinv) % N), multiply(G, mod(-e * rinv, N)));
  const a = affine(Q);
  if (!a) return null;

  const pub = new Uint8Array(64);
  pub.set(to32(a.x), 0);
  pub.set(to32(a.y), 32);
  return "0x" + hex(keccak256(pub)).slice(24);
}

/** the hash a wallet signs for personal_sign: keccak256 over the EIP-191 prefix, the byte length and the message */
export function personalHash(message) {
  const body = typeof message === "string" ? new TextEncoder().encode(message) : bytesOf(message);
  const prefix = new TextEncoder().encode("\x19Ethereum Signed Message:\n" + body.length);
  const all = new Uint8Array(prefix.length + body.length);
  all.set(prefix);
  all.set(body, prefix.length);
  return keccak256(all);
}

/** the address that signed exactly this sentence, or null. A single altered character yields a different address. */
export function recoverPersonal(message, signature65) {
  return recoverAddress(personalHash(message), signature65);
}

/** lower case, 0x, forty hex digits, or null. Used before anything is compared or read from the chain. */
export function normalizeAddress(a) {
  if (typeof a !== "string") return null;
  const s = a.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(s) ? s : null;
}
