// Telegram inline mode is a share surface, not a second command router. Every card below is fixed product
// copy or the already-published token state; the user's query is used only to choose cards and is never
// reflected into a message, URL or log.

import * as T from "./texts.js";
import { code } from "./telegram.js";

const bytes = value => new TextEncoder().encode(value).byteLength;
const plainObject = value => !!value && typeof value === "object" && !Array.isArray(value);
const ALL = Object.freeze(["app", "read", "live", "deployer", "run", "token"]);

const KEYWORDS = Object.freeze({
  app: ["app", "mini", "telegram", "tool"],
  read: ["read", "check", "compare", "launch", "identity"],
  live: ["live", "wall", "names", "tickers", "launches"],
  deployer: ["deployer", "dev", "history", "wallet"],
  run: ["run", "source", "repo", "github", "code", "api", "cli"],
  token: ["token", "ca", "contract", "address", "lintcha", "$lintcha"]
});

/** A structurally valid inline query, reduced to the only fields the product uses. */
export function inlineQueryOf(update) {
  const raw = update && update.inline_query;
  if (!plainObject(raw) || typeof raw.id !== "string" || !raw.id.length || bytes(raw.id) > 256 ||
      !plainObject(raw.from) || !Number.isSafeInteger(raw.from.id) || raw.from.id <= 0 ||
      typeof raw.query !== "string" || Array.from(raw.query).length > 256 || bytes(raw.query) > 1024 ||
      (raw.offset !== undefined && (typeof raw.offset !== "string" || bytes(raw.offset) > 64))) return null;
  try {
    return { id: raw.id, owner: String(raw.from.id), query: raw.query.normalize("NFKC").trim().toLowerCase() };
  } catch {
    return null;
  }
}

const termsOf = query => query.replace(/\$/g, " $").split(/[^\p{L}\p{N}_$-]+/u).filter(Boolean);

/** Empty means the full palette. A typed word may be a keyword prefix, so results stay useful while typing. */
export function inlineKindsFor(query) {
  if (typeof query !== "string" || !query.trim()) return [...ALL];
  const terms = termsOf(query);
  if (terms.includes("all") || terms.includes("lintcha")) return [...ALL];
  return ALL.filter(kind => terms.some(term => KEYWORDS[kind].some(keyword =>
    term === keyword || (term.length >= 2 && keyword.startsWith(term))
  )));
}

const appCard = () => ({
  id: "app-v1",
  title: "Mini App — lintcha inside Telegram",
  description: "Read, Live, Deployer and Token in one compact view.",
  text: [
    "<b>lintcha — Telegram Mini App</b>",
    "",
    "Open the compact interface for Read, Live, Deployer and the published token state without leaving Telegram.",
    "",
    "It is the same public product and the same fail-closed data boundaries as the site."
  ].join("\n"),
  openText: "Open Mini App",
  openUrl: T.MINI_APP
});

const readCard = () => ({
  id: "read-v1",
  title: "Read — compare a launch",
  description: "Compare the strings a Robinhood Chain launch publishes about itself.",
  text: [
    "<b>lintcha — Read</b>",
    "",
    "Paste the fields as a Robinhood Chain launch shows them. Lintcha compares those strings with the published launch window and says what is shared, with how many and since when.",
    "",
    "It does not inspect the contract, calculate a price or make a judgment."
  ].join("\n"),
  openText: "Read a launch",
  openUrl: T.SITE + "#s02"
});

const liveCard = () => ({
  id: "live-v1",
  title: "Live — names and tickers",
  description: "Follow publishable self-declared names and tickers after the snapshot.",
  text: [
    "<b>lintcha — Live</b>",
    "",
    "Follow publishable self-declared launch names and tickers after the fixed snapshot. Coverage is shown first.",
    "",
    "If the complete watcher range cannot be established, the wall closes instead of presenting a partial feed as complete."
  ].join("\n"),
  openText: "Open Live",
  openUrl: T.LIVE
});

const deployerCard = () => ({
  id: "deployer-v1",
  title: "Deployer — retained history",
  description: "Look up observed launch declarations for one public deployer address.",
  text: [
    "<b>lintcha — Deployer</b>",
    "",
    "Look up retained observed history for one public deployer address: block, date, name and ticker declarations.",
    "",
    "It is bounded watcher history, not an all-time profile and not a judgment."
  ].join("\n"),
  openText: "Explore a deployer",
  openUrl: T.DEPLOYER
});

const runCard = () => ({
  id: "run-v1",
  title: "Run — source and public API",
  description: "Clone, test, build or integrate the same comparison engine.",
  text: [
    "<b>lintcha — Run it</b>",
    "",
    "The comparison engine, JSON CLI, public HTTP identity endpoint, collector and verification paths are open source under the MIT licence.",
    "",
    "Clone it, build it and reproduce the published result."
  ].join("\n"),
  openText: "Open the repository",
  openUrl: T.REPO + "#run-in-sixty-seconds"
});

const tokenCard = token => {
  if (!token || token.ok !== true) return {
    id: "token-v1",
    title: "Token — state unavailable",
    description: "The published token document could not be read, so there is no cached answer.",
    text: "<b>lintcha — Token status</b>\n\n" + T.SITE_UNREADABLE,
    openText: "Open lintcha",
    openUrl: T.SITE
  };
  if (typeof token.address !== "string") return {
    id: "token-v1",
    title: "Token — not published",
    description: "No contract address, chart or buy link is published yet.",
    text: "<b>lintcha — Token status</b>\n\n" + T.NO_TOKEN_YET,
    openText: "Open lintcha",
    openUrl: T.SITE
  };
  return {
    id: "token-v1",
    title: "Token — official contract",
    description: "The verified address currently published by lintcha.",
    text: [
      "<b>lintcha — Official contract</b>",
      "",
      code(token.address),
      "",
      "This address is read from the site's public token document. No address is kept here from memory."
    ].join("\n"),
    openText: "Open lintcha",
    openUrl: T.SITE
  };
};

const cardOf = (kind, token) => kind === "app" ? appCard()
  : kind === "read" ? readCard()
  : kind === "live" ? liveCard()
  : kind === "deployer" ? deployerCard()
  : kind === "run" ? runCard()
  : tokenCard(token);

/** The exact response is stored durably before Telegram is called, just like a normal command response. */
export function inlineActionFor(query, token) {
  if (!query || typeof query.id !== "string" || typeof query.query !== "string") return null;
  const kinds = inlineKindsFor(query.query);
  return {
    kind: "answer-inline",
    inlineQueryId: query.id,
    cacheTime: kinds.includes("token") ? 0 : kinds.length ? 300 : 60,
    results: kinds.map(kind => cardOf(kind, token)),
    buttonText: "Open Lintcha Mini App",
    buttonWebAppUrl: T.MINI_APP
  };
}
