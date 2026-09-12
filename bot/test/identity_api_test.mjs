// The opt-in HTTP adapter: strict shape, bounded ingress, the exact published corpus and no stored or echoed
// declaration. The browser comparison remains separate and local.
//   node test/identity_api_test.mjs

import worker, { IDENTITY_BODY_LIMIT, forgetIdentityBucket } from "../src/index.js";
import { check } from "../src/engine.js";
import { ENGINE_ID, IDENTITY_API_SCHEMA, IDENTITY_INPUT_FIELDS, IDENTITY_LINK_FIELDS, identityInputOf } from "../src/identity.js";
import { Watch, forgetPublished } from "../src/watch.js";
import { emptyPublishedIndex, fakePublished, fakeWatchCtx, harness } from "./fakes.mjs";
import { ENGINE_ID as KIT_ENGINE_ID, IDENTITY_INPUT_FIELDS as KIT_INPUT_FIELDS, IDENTITY_LINK_FIELDS as KIT_LINK_FIELDS } from "../../lib/identity.mjs";

const t = harness("identity api");
const input = {
  name: "API marker that must not be echoed",
  ticker: "API_MARKER",
  description: "one two three four five six seven eight nine ten eleven twelve",
  links: { twitter: "@api-marker", telegram: "", discord: "", website: "", farcaster: "" },
  logo: "",
  recipient: ""
};
const index = emptyPublishedIndex();
const published = fakePublished({ index });

t.ok(ENGINE_ID === KIT_ENGINE_ID, "the HTTP and offline kit name the same engine");
t.ok(JSON.stringify(IDENTITY_INPUT_FIELDS) === JSON.stringify(KIT_INPUT_FIELDS) && JSON.stringify(IDENTITY_LINK_FIELDS) === JSON.stringify(KIT_LINK_FIELDS), "the HTTP and offline kit require the same fields");
t.ok(identityInputOf(input) === input, "the documented full input shape is accepted");
t.ok(identityInputOf({ ...input, extra: "not echoed" }) === null, "an extra top-level field is refused");
const missing = { ...input };
delete missing.ticker;
t.ok(identityInputOf(missing) === null, "a missing top-level field is refused");
t.ok(identityInputOf({ ...input, logo: null }) === null, "a non-string declaration is refused");
t.ok(identityInputOf({ ...input, links: { ...input.links, matrix: "not echoed" } }) === null, "an extra link field is refused");
t.ok(identityInputOf({ ...input, links: { ...input.links, website: null } }) === null, "a non-string link is refused");

forgetPublished();
const watchCtx = fakeWatchCtx();
const watch = new Watch(watchCtx, {});
const sqlBefore = watchCtx.storage.sql.calls.length;
let response = await watch.fetch(new Request("https://watch/identity", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(input)
}));
const directText = await response.text();
const direct = JSON.parse(directText);
t.ok(response.status === 200 && direct.ok === true, "the Watch adapter answers a valid comparison");
t.ok(direct.schema === IDENTITY_API_SCHEMA && direct.engine === ENGINE_ID, "the response names its API schema and engine");
t.ok(JSON.stringify(direct.result) === JSON.stringify(await check(input, index)), "the result is the site engine's exact check");
t.ok(direct.corpus && /^[0-9a-f]{64}$/.test(direct.corpus.sha256) && Number.isSafeInteger(direct.corpus.bytes) && Number.isSafeInteger(direct.corpus.entries_total), "the response carries the verified index receipt");
t.ok(!directText.includes(input.name) && !directText.includes(input.ticker) && !directText.includes(input.links.twitter), "the response echoes no submitted declaration");
t.ok(watchCtx.storage.sql.calls.length === sqlBefore, "an identity read writes no durable state");
t.ok(published.asked.some(url => url.includes("launch-manifest.json")) && published.asked.some(url => url.includes("launch-index.json")), "the adapter reads the public manifest and index");

response = await watch.fetch(new Request("https://watch/identity", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
t.ok(response.status === 400 && JSON.stringify(await response.json()) === JSON.stringify({ ok: false, why: "shape" }), "the internal boundary refuses an invalid shape without reflecting it");

forgetPublished();
fakePublished({ index, manifestOk: false });
response = await new Watch(fakeWatchCtx(), {}).fetch(new Request("https://watch/identity", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input)
}));
t.ok(response.status === 503 && (await response.json()).why === "corpus_unavailable", "an unreadable manifest fails closed");

forgetPublished();
fakePublished({ index });
let watchCalls = 0;
const binding = {
  idFromName: () => "watch",
  get: () => ({ fetch: (url, init) => {
    watchCalls++;
    return watch.fetch(url instanceof Request ? url : new Request(url, init));
  } })
};
const env = { WATCH: binding, IDENTITY_PER_SECOND: "4" };
const post = (body, headers = {}) => new Request("https://chain.lintcha.com/api/identity", {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body)
});

forgetIdentityBucket();
response = await worker.fetch(new Request("https://chain.lintcha.com/api/identity", { method: "OPTIONS" }), env, {});
t.ok(response.status === 204 && response.headers.get("access-control-allow-origin") === "*" && response.headers.get("access-control-allow-methods") === "POST, OPTIONS", "the endpoint answers a minimal public CORS preflight");
response = await worker.fetch(new Request("https://chain.lintcha.com/api/identity"), env, {});
t.ok(response.status === 405 && response.headers.get("allow") === "POST, OPTIONS", "other methods are refused and the allowed methods are named");
response = await worker.fetch(post("{}", { "content-type": "text/plain" }), env, {});
t.ok(response.status === 415 && (await response.json()).why === "media_type", "only JSON media is accepted");
const beforeShape = watchCalls;
response = await worker.fetch(post("{"), env, {});
t.ok(response.status === 400 && (await response.json()).why === "shape" && watchCalls === beforeShape, "invalid JSON is refused before Watch");
response = await worker.fetch(post({ ...input, extra: "must-not-be-reflected" }), env, {});
const shapeText = await response.text();
t.ok(response.status === 400 && !shapeText.includes("must-not-be-reflected") && watchCalls === beforeShape, "invalid fields are neither forwarded nor reflected");

forgetIdentityBucket();
response = await worker.fetch(post(input), env, {});
const publicBody = await response.json();
t.ok(response.status === 200 && publicBody.schema === IDENTITY_API_SCHEMA && JSON.stringify(publicBody.result) === JSON.stringify(await check(input, index)), "the public route returns the same checked result");
t.ok(response.headers.get("cache-control") === "no-store" && response.headers.get("access-control-allow-origin") === "*", "success is not cached and is available to integrations");

forgetIdentityBucket();
response = await worker.fetch(post(input), { IDENTITY_PER_SECOND: "4" }, {});
t.ok(response.status === 503 && (await response.json()).why === "corpus_unavailable", "a missing Watch binding fails closed");

forgetIdentityBucket();
const tight = { ...env, IDENTITY_PER_SECOND: "1" };
const first = await worker.fetch(post(input), tight, {});
const limited = await worker.fetch(post(input), tight, {});
t.ok(first.status === 200 && limited.status === 429 && (await limited.json()).why === "rate_limited", "the route has its own per-isolate request bucket");

forgetIdentityBucket();
const beforeOversize = watchCalls;
response = await worker.fetch(new Request("https://chain.lintcha.com/api/identity", {
  method: "POST",
  headers: { "content-type": "application/json", "content-length": String(IDENTITY_BODY_LIMIT + 1) },
  body: "{}"
}), env, {});
t.ok(response.status === 400 && (await response.json()).why === "shape" && watchCalls === beforeOversize, "a declared oversized body is refused before Watch");

t.done();
