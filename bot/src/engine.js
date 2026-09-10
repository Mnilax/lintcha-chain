// The matching engine, loaded and not copied.
//
// site/launch.js is the file that decides what counts as the same string. It is vendored from lintcha, its
// hash is in VENDOR.md, and it is the page's engine. The watcher must count with it and not with a copy of
// it: if the tail folded one link differently from the page, the site would print one answer and the bot
// would send another, and the whole claim this project makes would be false in a way nobody would notice
// until it mattered.
//
// So there is no copy anywhere in bot/. This module imports the vendored file by path, exposes what it
// returns, and does nothing else. The import crosses out of bot/ on purpose: one file, one loader per
// runtime, no second implementation.
//
//   the page              three script tags; the global branch of the UMD; digest via crypto.subtle
//   the collector         createRequire in tools/launch-collect.mjs; the require branch; digest via node crypto
//   the index writer      the same, in tools/launch-index.mjs
//   the watcher           this module; whichever branch the bundler picks; the same sha256 either way
//
// Both digest paths are sha256 of the utf-8 bytes, truncated to the same sixteen hex characters by the same
// line of the same file, so a value hashes identically on all four. bot/test/engine_test.mjs loads the file a
// second way, the page's way, over the same fixtures, and compares — that test is the reason to believe this
// paragraph rather than a claim that it is true.
//
// One deploy time note, which is in bot/README.md and in the round's report as well: on the require branch the
// vendored file calls require("crypto"), so this worker needs the nodejs_compat flag. The flag is in
// bot/wrangler.toml. Without it the bundle does not build at all, which is the failure mode to want: loud, at
// deploy, and never a silently different hash.
import "./engine-globals.js";
import * as EngineModule from "../../site/launch.js";

/** where the engine came from, for anything that wants to say so out loud */
export const ENGINE_PATH = "site/launch.js";

const loaded = (EngineModule && EngineModule.default) || globalThis.LaunchIdentity || null;

// A missing engine is not something to work around. It is named here, at import, because a watcher that
// counts with half an engine is worse than a watcher that does not start.
if (!loaded || typeof loaded.digest !== "function" || !loaded.normalize || typeof loaded.check !== "function") {
  throw new Error(
    "site/launch.js did not load. Neither the module's default export nor globalThis.LaunchIdentity carries the " +
    "engine. Nothing in bot/ may stand in for it: see the note in bot/src/engine.js and bot/README.md."
  );
}

export const Engine = loaded;
export const LINKS = Engine.LINKS;
export const NAMESPACES = Engine.NAMESPACES;
export const MIN_WORDS = Engine.MIN_WORDS;
export const HEX_CHARS = Engine.HEX_CHARS;
export const normalize = Engine.normalize;
export const words = Engine.words;
export const digest = Engine.digest;
export const check = Engine.check;

/**
 * Does every part of the engine the watcher uses actually work.
 *
 * The shape check above runs at import and is cheap. This one calls the parts that dereference the vendored
 * tables, which is where a half loaded engine shows itself: skeleton() reaches into LaunchSkeleton and link()
 * reaches into LaunchLinks, and both would throw on the first real launch rather than at start up.
 *
 * Returns { ok: true } or { ok: false, why }. It never throws, so a caller can report it instead of dying.
 */
export function engineSelfTest() {
  try {
    if (!Array.isArray(LINKS) || LINKS.length === 0) return { ok: false, why: "no link fields" };
    if (!Array.isArray(NAMESPACES) || NAMESPACES.length === 0) return { ok: false, why: "no namespaces" };
    if (typeof normalize.skeleton("Test") !== "string") return { ok: false, why: "skeleton did not answer" };
    if (typeof normalize.link("@bob", "twitter") !== "string") return { ok: false, why: "link did not answer" };
    if (typeof normalize.ticker(" $abc ") !== "string") return { ok: false, why: "ticker did not answer" };
    if (!normalize.recipient("")) return { ok: false, why: "recipient did not answer" };
    return { ok: true };
  } catch (e) {
    return { ok: false, why: (e && e.message) || "threw" };
  }
}
