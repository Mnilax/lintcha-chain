import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readJson = (url) => JSON.parse(readFileSync(url, "utf8"));
const manifest = readJson(new URL("../../venues/pons-v2-mainnet.json", import.meta.url));
const buy = readJson(new URL("fixtures/pons-v2-mainnet-buy.json", import.meta.url));
const sell = readJson(new URL("fixtures/pons-v2-mainnet-sell.json", import.meta.url));

test("Pons V2 production manifest stays pinned to the recorded mainnet evidence", () => {
  const router = manifest.router.toLowerCase();
  assert.equal(manifest.schema, "lintcha.copy.venue.v1");
  assert.equal(manifest.chainId, 4663);
  assert.equal(router, buy.transaction.to.toLowerCase());
  assert.equal(router, sell.transaction.to.toLowerCase());
  assert.equal(manifest.spender.toLowerCase(), router);
  assert.deepEqual(manifest.selectors.autoBuy, [buy.transaction.input.slice(0, 10)]);
  assert.deepEqual(manifest.selectors.manualSell, [sell.transaction.input.slice(0, 10)]);
  assert.deepEqual(manifest.selectors.manualApproval, ["0x095ea7b3"]);
  assert.equal(manifest.evidence.buyTransaction, buy.transaction.hash);
  assert.equal(manifest.evidence.sellTransaction, sell.transaction.hash);
  assert.match(manifest.runtimeCode.sha256, /^0x[0-9a-f]{64}$/);
  assert.ok(manifest.runtimeCode.bytes > 0);
});
