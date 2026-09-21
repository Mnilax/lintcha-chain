import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Observer } from "../src/observer/observer.mjs";
import { telegramSignal } from "../src/observer/notifier.mjs";
import { UniswapV2ObserverAdapter } from "../src/observer/uniswap-v2-adapter.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "fixtures/mainnet-uniswap-v2-buy.json");

async function loadFixture() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

function blockOf(fixture, overrides = {}) {
  return {
    number: Number(BigInt(fixture.block.number)),
    hash: fixture.block.hash,
    parentHash: fixture.block.parentHash,
    ...overrides,
  };
}

test("CP2: replay is idempotent and safe/finalized states are monotonic", async () => {
  const fixture = await loadFixture();
  const observer = new Observer({ adapter: new UniswapV2ObserverAdapter(), targetWallet: fixture.transaction.from });
  const first = observer.ingestLatest(blockOf(fixture), [fixture]);
  assert.equal(first.created.length, 1);
  assert.equal(first.created[0].state, "PROVISIONAL");
  const replay = observer.ingestLatest(blockOf(fixture), [fixture]);
  assert.equal(replay.created.length, 0);
  assert.equal(replay.duplicates, 1);
  assert.equal(observer.markSafe(Number(BigInt(fixture.block.number))).length, 1);
  assert.equal(observer.markFinalized(Number(BigInt(fixture.block.number))).length, 1);
  assert.equal(observer.snapshot().events[0].state, "FINALIZED");
});

test("CP2: unknown selector is skipped with an explicit reason", async () => {
  const fixture = await loadFixture();
  fixture.transaction.input = `0xdeadbeef${fixture.transaction.input.slice(10)}`;
  const observer = new Observer({ adapter: new UniswapV2ObserverAdapter(), targetWallet: fixture.transaction.from });
  const result = observer.ingestLatest(blockOf(fixture), [fixture]);
  assert.deepEqual(result.skipped.map((item) => item.code), ["UNSUPPORTED_SELECTOR"]);
});

test("CP2: target mismatch is skipped", async () => {
  const fixture = await loadFixture();
  const observer = new Observer({ adapter: new UniswapV2ObserverAdapter(), targetWallet: "0x0000000000000000000000000000000000000001" });
  const result = observer.ingestLatest(blockOf(fixture), [fixture]);
  assert.equal(result.skipped[0].code, "TARGET_MISMATCH");
});

test("CP2: block gap halts cursor advancement", async () => {
  const fixture = await loadFixture();
  const observer = new Observer({ adapter: new UniswapV2ObserverAdapter(), targetWallet: fixture.transaction.from });
  observer.ingestLatest(blockOf(fixture), [fixture]);
  const result = observer.ingestLatest(blockOf(fixture, {
    number: Number(BigInt(fixture.block.number)) + 2,
    hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    parentHash: fixture.block.hash,
  }), []);
  assert.equal(result.reason, "BLOCK_GAP");
  assert.equal(result.halt, true);
});

test("CP2: canonical hash change retracts the source event", async () => {
  const fixture = await loadFixture();
  const observer = new Observer({ adapter: new UniswapV2ObserverAdapter(), targetWallet: fixture.transaction.from });
  observer.ingestLatest(blockOf(fixture), [fixture]);
  const replacement = blockOf(fixture, { hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
  observer.ingestLatest(replacement, []);
  assert.equal(observer.snapshot().events[0].state, "RETRACTED");
  assert.equal(observer.snapshot().events[0].stateReason, "CANONICAL_HASH_CHANGED");
});

test("CP2: notifier output contains no quality claim", async () => {
  const fixture = await loadFixture();
  const observer = new Observer({ adapter: new UniswapV2ObserverAdapter(), targetWallet: fixture.transaction.from });
  const event = observer.ingestLatest(blockOf(fixture), [fixture]).created[0];
  const message = telegramSignal(event, { targetAlias: "Research target", reviewBaseUrl: "https://local.invalid/review" });
  assert.match(message.text, /Source state: PROVISIONAL/);
  assert.doesNotMatch(message.text, /safe trade|guaranteed|good trade/i);
  assert.doesNotMatch(JSON.stringify(message), /https?:\/\//i);
  assert.match(JSON.stringify(message), /callback_data/);
});

test("CP11: confirmed SELL signal can expose a manual review button only", () => {
  const event = {
    state: "CONFIRMED", direction: "SELL", sourceId: "4663:fixture:1", revision: 2,
    sourceWallet: "0x1111111111111111111111111111111111111111",
    targetToken: "0x5555555555555555555555555555555555555555",
    sourceAmount: "100", transactionHash: `0x${"a".repeat(64)}`,
  };
  const message = telegramSignal(event, { manualSellToken: "signed-review-token" });
  assert.match(JSON.stringify(message.reply_markup), /Sell manually/);
  assert.match(JSON.stringify(message.reply_markup), /sell\.review\.signed-review-token/);
  assert.doesNotMatch(JSON.stringify(message), /sell\.confirm/);
});
