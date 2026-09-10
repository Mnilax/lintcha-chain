// Counting launches the way the collector counts them.
//
// The engine decides what a value normalizes to and what it hashes to, and the engine is loaded, not copied
// (bot/src/engine.js). What is left over is arithmetic: how many launches carry a hash, which date the first
// one was on, how many distinct deployers, and on the two skeleton namespaces how many distinct spellings.
// Those four numbers are the collector's Counter class, tools/launch-collect.mjs, and they are written out
// again here for one reason that is worth saying plainly rather than hiding:
//
//   tools/launch-collect.mjs cannot be imported. Its Counter is not exported, and the module's body is an
//   async IIFE that starts reading the chain the moment the file is loaded. So the arithmetic is mirrored
//   here — twelve lines of it — and bot/test/engine_test.mjs pins the mirror by asserting the same fixture
//   set produces the same table on both sides, hash for hash and number for number, with every hash on both
//   sides coming out of the one engine.
//
// The order of the fields below is not cosmetic either. tallyText() writes namespaces in the engine's own
// NAMESPACES order, hashes sorted, and each entry's keys as n, first, d and then v, which is the order the
// collector's frozen() produces. That is what makes a tail hash comparable to a collector run over the same
// blocks by nothing more than reading both files.

import { LINKS, NAMESPACES, MIN_WORDS, normalize, words, digest } from "./engine.js";

/**
 * Every value of one launch that the collector counts, in the order it counts them.
 *
 * This mirrors the loop in tools/launch-collect.mjs exactly, including what it leaves out: a link field that
 * normalizes to nothing, a fee recipient that is not an address or is the zero address, and a description
 * under the engine's word floor are all absent rather than counted as empty. `spelling` is carried on the two
 * skeleton namespaces because the collector counts distinct spellings inside a skeleton group.
 */
export function valuesOf(launch) {
  const l = launch || {};
  const socials = {};
  LINKS.forEach((k, i) => { socials[k] = (Array.isArray(l.socials) && l.socials[i]) || ""; });

  const out = [];
  for (const k of LINKS) out.push({ ns: "link", value: normalize.link(socials[k], k), field: k });
  out.push({ ns: "logo", value: normalize.logo(l.logo) });

  const rec = normalize.recipient(l.recipient);
  if (rec.state === "ok") out.push({ ns: "recipient", value: rec.value });

  const desc = normalize.description(l.description);
  if (desc && words(desc) >= MIN_WORDS) out.push({ ns: "description", value: desc });

  const ticker = normalize.ticker(l.symbol);
  const name = normalize.name(l.name);
  out.push({ ns: "ticker", value: ticker });
  out.push({ ns: "name", value: name });
  out.push({ ns: "ticker_skeleton", value: normalize.skeleton(ticker), spelling: ticker });
  out.push({ ns: "name_skeleton", value: normalize.skeleton(name), spelling: name });

  return out.filter(v => v.value);
}

/** The same list as hashes: what the tail stores per launch, and what a rule is compared against. */
export async function hashesOf(launch) {
  const out = [];
  for (const v of valuesOf(launch)) out.push({ ns: v.ns, field: v.field || null, hash: await digest(v.value), spelling: v.spelling });
  return out;
}

/**
 * The per launch row the tail publishes: counted hashes and nothing else.
 *
 * No address, no raw string, no name. The index the page reads carries none of those three and the index
 * writer refuses to write a file that does (tools/launch-index.mjs greps its own output for them), so the
 * tail keeps the same rule: what leaves this worker is hashes, a block number and a date.
 */
export async function rowOf(launch) {
  const hs = await hashesOf(launch);
  const one = ns => { const h = hs.find(x => x.ns === ns); return h ? h.hash : null; };
  // The five link hashes stay in the engine's own LINKS order, with a null where the field was empty, so a
  // position still names its field. A compacted array would hash the same values and lose which platform a
  // match was on, and a rule message that cannot say where it matched is a rule message with a hole in it.
  const linkOf = field => { const h = hs.find(x => x.ns === "link" && x.field === field); return h ? h.hash : null; };
  return {
    block: Number(launch.block),
    date: String(launch.date || ""),
    hashes: {
      link: LINKS.map(linkOf),
      logo: one("logo"),
      recipient: one("recipient"),
      description: one("description"),
      ticker: one("ticker"),
      name: one("name"),
      ticker_skeleton: one("ticker_skeleton"),
      name_skeleton: one("name_skeleton")
    }
  };
}

/**
 * The collector's Counter, mirrored.
 *
 * add(ns, value, date, deployer, spelling) is its signature, its skip on an empty value, its minimum date and
 * its two sets. frozen() is its output shape.
 */
export class Tally {
  constructor() {
    this.tables = {};
    for (const ns of NAMESPACES) this.tables[ns] = new Map();
  }

  async add(ns, value, date, deployer, spelling) {
    if (!value) return;
    const h = await digest(value);
    this.addHash(ns, h, date, deployer, spelling);
  }

  /** The same, when the hash is already known: the tail stores hashes, so a table is rebuilt without rehashing. */
  addHash(ns, h, date, deployer, spelling) {
    const t = this.tables[ns];
    if (!t || !h) return;
    const e = t.get(h) || { n: 0, first: date, deployers: new Set(), spellings: ns.endsWith("_skeleton") ? new Set() : null };
    e.n++;
    if (date < e.first) e.first = date;
    e.deployers.add(deployer);
    if (e.spellings && spelling) e.spellings.add(spelling);
    t.set(h, e);
  }

  /** One whole launch, in the collector's order. */
  async addLaunch(launch) {
    for (const v of valuesOf(launch)) await this.add(v.ns, v.value, launch.date, launch.deployer, v.spelling);
  }

  frozen() {
    const out = {};
    for (const ns of NAMESPACES) {
      out[ns] = {};
      for (const h of [...this.tables[ns].keys()].sort()) {
        const e = this.tables[ns].get(h);
        out[ns][h] = e.spellings
          ? { n: e.n, first: e.first, d: e.deployers.size, v: e.spellings.size }
          : { n: e.n, first: e.first, d: e.deployers.size };
      }
    }
    return out;
  }
}

/**
 * The bytes a tail hash is taken over, and the bytes a collector run is compared as.
 *
 * Namespaces in the engine's order, hashes sorted, entry keys in the collector's order. Written out by hand
 * rather than left to JSON.stringify's insertion order, because insertion order is a property of how a table
 * was built and this has to be a property of what is in it.
 */
export function tallyText(frozen) {
  const parts = [];
  for (const ns of NAMESPACES) {
    const table = (frozen && frozen[ns]) || {};
    const rows = Object.keys(table).sort().map(h => {
      const e = table[h];
      const fields = ["\"n\":" + Number(e.n), "\"first\":" + JSON.stringify(String(e.first)), "\"d\":" + Number(e.d)];
      if (Number.isInteger(e.v)) fields.push("\"v\":" + Number(e.v));
      return JSON.stringify(h) + ":{" + fields.join(",") + "}";
    });
    parts.push(JSON.stringify(ns) + ":{" + rows.join(",") + "}");
  }
  return "{" + parts.join(",") + "}";
}

/** sha256 of those bytes, whole and not truncated: this one names an artifact, it does not count a value. */
export async function tallyHash(frozen) {
  const bytes = new TextEncoder().encode(tallyText(frozen));
  const buf = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, "0")).join("");
}

/** How many entries a frozen table holds, per namespace: the one figure /stats and the tail both want. */
export function entryCounts(frozen) {
  const out = {};
  for (const ns of NAMESPACES) out[ns] = Object.keys((frozen && frozen[ns]) || {}).length;
  return out;
}
