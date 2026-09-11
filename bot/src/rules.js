// Rules: what a holder asked to be told about, and whether a launch matches it.
//
// Four rules exist and not one of them carries a judgment. Three of them are string equality and the fourth
// is a count with a threshold the person picked themselves. There is no score here, no probability, no
// ordering by anything but the order the rules were made in, and no colour that means good or bad. That is
// not a style choice: the page's own never list says so, and a bot that ranked launches would make the page
// a decoration.
//
//   string S    a launch whose ticker, name or one of its five links is that string
//   dev 0x…     another launch from a named deployer
//   shared N    a launch whose ticker is already carried by N launches or more
//
// How the comparing is done matters more than what is compared. A string rule is stored as the hashes the
// engine would give its query, and a launch is stored as the hashes the engine gave its fields, so a match is
// hash equality between two things the same engine produced. This is the same operation site/launch.js
// performs when the page compares a pasted launch against the index — which is what the page's own token.p1
// now promises: the check a rule runs is the check on the page.
//
// Rules live in the watcher's SQLite and not in KV. They are read on every new launch, next to the tail they
// are read against, and a KV read per launch per rule would be a network hop to answer a question the object
// is already holding the data for.

import { LINKS, normalize, digest } from "./engine.js";
import { integerSetting } from "./config.js";

export const KINDS = ["string", "dev", "shared"];
export const DEFAULT_RULES_PER_HOLDER = 20;
/** The deployment setting may tighten this product cap, never silently raise or remove it. */
export const MAX_RULES_PER_HOLDER = DEFAULT_RULES_PER_HOLDER;
/** a string rule's query, at most: long enough for any ticker, name or url, short enough to store */
export const MAX_ARG = 200;
/** shared N below two would fire on every launch, because one launch carrying a ticker is the launch itself */
export const MIN_SHARED = 2;

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS rules (id INTEGER PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, arg TEXT NOT NULL, hashes TEXT NOT NULL, made INTEGER NOT NULL, hits INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS rule_sequence (singleton INTEGER PRIMARY KEY, next_id INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS rules_owner ON rules (owner)"
];

const lower = a => String(a == null ? "" : a).trim().toLowerCase();

/**
 * What the person typed, read as a rule, or the reason it is not one.
 *   { ok: true, kind, arg }
 *   { ok: false, why: "kind" | "empty" | "long" | "address" | "number" }
 * Nothing is guessed at: "/rule dev bob" is refused rather than turned into a string rule.
 */
export function parseRule(kind, rest) {
  const k = lower(kind);
  if (!KINDS.includes(k)) return { ok: false, why: "kind" };
  const arg = String(rest == null ? "" : rest).trim();
  if (!arg) return { ok: false, why: "empty" };
  if (arg.length > MAX_ARG) return { ok: false, why: "long" };
  if (k === "dev") {
    const a = lower(arg);
    if (!/^0x[0-9a-f]{40}$/.test(a)) return { ok: false, why: "address" };
    return { ok: true, kind: k, arg: a };
  }
  if (k === "shared") {
    if (!/^[0-9]+$/.test(arg)) return { ok: false, why: "number" };
    const n = Number(arg);
    if (!Number.isSafeInteger(n) || n < MIN_SHARED) return { ok: false, why: "number" };
    return { ok: true, kind: k, arg: String(n) };
  }
  return { ok: true, kind: k, arg };
}

/**
 * The hashes a string rule is compared by, made by the engine from the query.
 *
 * A query is hashed three ways because a person types one string and means whichever of the three it is: as a
 * ticker, as a name, and as a link. The link form is folded once per field that names a platform, because
 * "@bob" is x.com/bob in a twitter field and t.me/bob in a telegram field and the engine's alias table is
 * what decides that, not this file.
 */
export async function rifleOf(kind, arg) {
  if (kind === "dev") return { deployer: lower(arg) };
  if (kind === "shared") return { threshold: Number(arg) };
  const links = [];
  const raw = normalize.linkRaw(arg);
  if (raw) links.push(await digest(raw));
  for (const field of LINKS) {
    const folded = normalize.link(arg, field);
    if (folded) { const h = await digest(folded); if (!links.includes(h)) links.push(h); }
  }
  const ticker = normalize.ticker(arg);
  const name = normalize.name(arg);
  return {
    ticker: ticker ? await digest(ticker) : null,
    name: name ? await digest(name) : null,
    links
  };
}

/**
 * Does one launch match one rule.
 *
 * subject:
 *   { deployer, hashes: { ticker, name, link: [...] }, indexState, indexCount, tailCount }
 * indexCount is what the published index says about this ticker, straight out of the engine's own check(),
 * or null when the index has no exact count. tailCount is how many launches strictly after the published
 * snapshot carry it, this one included. That boundary makes the two scopes disjoint.
 *
 * Returns null, or { where, count, indexCount, tailCount } — what matched, and the numbers behind it.
 */
export function match(rule, subject) {
  const s = subject || {};
  const h = s.hashes || {};
  const r = rule && rule.rifle ? rule.rifle : {};

  if (rule.kind === "dev") {
    return r.deployer && lower(s.deployer) === r.deployer ? { where: "the deployer" } : null;
  }

  if (rule.kind === "shared") {
    // No snapshot boundary means there is no provably disjoint suffix, so there is no count to compare.
    if (s.tailCount === null || s.tailCount === undefined) return null;
    const tail = Number(s.tailCount), threshold = Number(r.threshold);
    if (!Number.isSafeInteger(tail) || tail < 0 || !Number.isSafeInteger(threshold) || threshold < MIN_SHARED) return null;
    if (s.indexState === "shared") {
      if (s.indexCount === null || s.indexCount === undefined) return null;
      const indexed = Number(s.indexCount);
      if (!Number.isSafeInteger(indexed) || indexed < 0 || !Number.isSafeInteger(indexed + tail)) return null;
      const total = indexed + tail;
      return total >= threshold
        ? { where: "the ticker", count: total, exact: true, indexState: "shared", indexCount: indexed, tailCount: tail }
        : null;
    }
    // An absent index entry means fewer than the count floor, not zero. It cannot be added as an exact
    // number. The suffix can still prove the person's threshold by itself; that answer is a floor.
    if (s.indexState === "unique" && tail >= threshold) {
      return { where: "the ticker", count: tail, exact: false, indexState: "unique", indexCount: null, tailCount: tail };
    }
    return null;
  }

  if (rule.kind === "string") {
    if (r.ticker && h.ticker === r.ticker) return { where: "the ticker" };
    if (r.name && h.name === r.name) return { where: "the name" };
    // the launch's link hashes are in the engine's LINKS order with a null for an empty field, so the
    // position of the match names the platform it was on
    const ls = Array.isArray(h.link) ? h.link : [];
    if (Array.isArray(r.links)) {
      const at = ls.findIndex(x => x && r.links.includes(x));
      if (at >= 0) return { where: "a link", field: LINKS[at] || null, hash: ls[at] };
    }
    return null;
  }

  return null;
}

/** The rules table, on the watcher's own storage. */
export class Rules {
  constructor(sql) {
    this.sql = sql;
    for (const stmt of SCHEMA) this.sql.exec(stmt);
    const sequence = [...this.sql.exec("SELECT next_id FROM rule_sequence WHERE singleton = ?", 1)];
    if (!sequence.length) {
      const top = [...this.sql.exec("SELECT MAX(id) AS m FROM rules")];
      const maximum = top.length && top[0].m !== null && top[0].m !== undefined ? Number(top[0].m) : 0;
      if (Number.isSafeInteger(maximum) && maximum >= 0 && maximum < Number.MAX_SAFE_INTEGER) {
        this.sql.exec("INSERT INTO rule_sequence (singleton, next_id) VALUES (?, ?)", 1, maximum + 1);
      }
    }
  }

  limit(env) {
    const configured = env && env.RULES_PER_HOLDER;
    return integerSetting(configured, DEFAULT_RULES_PER_HOLDER, {
      min: 1,
      max: MAX_RULES_PER_HOLDER,
      // An explicit malformed limit must not make `count >= limit` false as NaN did, or manufacture the
      // default amount of storage. Zero makes the existing comparison refuse every new rule.
      invalid: 0
    });
  }

  countFor(owner) {
    const rows = [...this.sql.exec("SELECT COUNT(*) AS n FROM rules WHERE owner = ?", String(owner))];
    return rows.length ? Number(rows[0].n) : 0;
  }

  /**
   * Store one rule. The rifle is the hashes it will be compared by, made once here rather than on every
   * launch. Returns the stored row.
   */
  add(owner, kind, arg, rifle, now) {
    const sequence = [...this.sql.exec("SELECT next_id FROM rule_sequence WHERE singleton = ?", 1)];
    const id = sequence.length === 1 ? Number(sequence[0].next_id) : NaN;
    if (!Number.isSafeInteger(id) || id < 1 || id >= Number.MAX_SAFE_INTEGER) return null;
    // Advance first. A crash may leave an unused id, which is harmless; reusing an id could bind an old
    // in-flight rule match or delivery to a later rule and is therefore forbidden.
    this.sql.exec("UPDATE rule_sequence SET next_id = ? WHERE singleton = ?", id + 1, 1);
    this.sql.exec(
      "INSERT INTO rules (id, owner, kind, arg, hashes, made, hits) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id, String(owner), kind, arg, JSON.stringify(rifle), Number(now), 0
    );
    return { id, owner: String(owner), kind, arg, rifle, made: Number(now), hits: 0 };
  }

  /** One person's rules, oldest first, so the number shown by /rules is stable while nothing is removed. */
  list(owner) {
    return [...this.sql.exec("SELECT id, owner, kind, arg, hashes, made, hits FROM rules WHERE owner = ? ORDER BY id", String(owner))].map(read);
  }

  all() {
    return [...this.sql.exec("SELECT id, owner, kind, arg, hashes, made, hits FROM rules ORDER BY id")].map(read);
  }

  get(id) {
    const rows = [...this.sql.exec("SELECT id, owner, kind, arg, hashes, made, hits FROM rules WHERE id = ?", Number(id))];
    return rows.length === 1 ? read(rows[0]) : null;
  }

  /**
   * Remove one rule, by its id and its owner together.
   *
   * The owner is in the where clause and not in an if above it. /rules shows a person their own rules by
   * position and /unrule takes that position, so a stranger's id is not reachable through the router at all;
   * this is the second refusal, at the storage, so the guarantee does not depend on the router being right.
   */
  removeById(owner, id) {
    const before = this.list(owner).some(r => r.id === Number(id));
    this.sql.exec("DELETE FROM rules WHERE id = ? AND owner = ?", Number(id), String(owner));
    return before;
  }

  /** Remove every rule belonging to exactly one owner. Idempotent, so /forget is safe to repeat. */
  removeAll(owner) {
    this.sql.exec("DELETE FROM rules WHERE owner = ?", String(owner));
    return true;
  }

  bumpHit(id) {
    this.sql.exec("UPDATE rules SET hits = hits + ? WHERE id = ?", 1, Number(id));
  }
}

const read = row => ({
  id: Number(row.id),
  owner: String(row.owner),
  kind: String(row.kind),
  arg: String(row.arg),
  rifle: parse(row.hashes),
  made: Number(row.made),
  hits: Number(row.hits)
});

const parse = s => { try { return JSON.parse(s); } catch { return {}; } };
