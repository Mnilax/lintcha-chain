import assert from "node:assert/strict";
import { test } from "node:test";
import { TelegramProduct, tradeReceiptMessage, walletListMessage } from "../src/telegram/product.mjs";

function product() {
  const intents = [];
  const pauses = [];
  const modes = [];
  let profile = { mode: "NOTIFY_ONLY", authorizationStatus: "active", maxPerTrade: "10000000000000000", maxPerDay: "50000000000000000", authorizationExpiresAt: "2026-10-01T00:00:00Z" };
  const dataSource = {
    async wallets() { return [{ id: "w1", alias: "Main", publicAddress: "0x7777777777777777777777777777777777777777", balance: "1.0" }]; },
    async targets() { return [{ alias: "Target", sourceAddress: "0x8888888888888888888888888888888888888888", status: "active" }]; },
    async rules() { return [{ id: "r1", direction: "BUY_ONLY", sizingPolicy: "FIXED_QUOTE", status: "active" }]; },
    async positions() { return ["Fixture position"]; },
    async history() { return ["Fixture history"]; },
    async setPause(userId, value) { pauses.push([userId, value]); },
    async tradingProfile() { return profile; },
    async setTradingMode(userId, mode) { modes.push([userId, mode]); profile = { ...profile, mode }; },
  };
  return {
    product: new TelegramProduct({ botUsername: "configurable_copy_bot", dataSource, intentSink: { async create(intent) { intents.push(intent); } } }),
    intents,
    pauses,
    modes,
  };
}

test("CP6: sensitive commands expose no data in groups", async () => {
  const { product: bot, intents } = product();
  for (const command of ["/wallet", "/watch", "/rules", "/positions", "/history", "/copy", "/ref"]) {
    const result = await bot.handle({ updateId: `g-${command}`, chatType: "group", userId: "1", command });
    assert.equal(result.privateBoundary, true);
    assert.doesNotMatch(result.text, /0x[0-9a-f]{40}|Fixture position|Fixture history/i);
  }
  assert.equal(intents.length, 0);
});

test("CP6: webhook retry creates one review intent", async () => {
  const { product: bot, intents } = product();
  const update = { updateId: "same-update", chatType: "private", userId: "1", command: "/copy" };
  const first = await bot.handle(update);
  const second = await bot.handle(update);
  assert.equal(intents.length, 1);
  assert.equal(first.intentId, second.intentId);
  assert.equal(second.duplicate, true);
  assert.equal(intents[0].kind, "copy_settings_open");
  assert.doesNotMatch(JSON.stringify(first), /https?:\/\//i);
});

test("CP6: wallet/watch/rule/pause private flows render expected bot-first data", async () => {
  const { product: bot, pauses } = product();
  assert.match((await bot.handle({ updateId: "w", chatType: "private", userId: "1", command: "/wallet" })).text, /0x7777…7777/);
  assert.match((await bot.handle({ updateId: "t", chatType: "private", userId: "1", command: "/watch" })).text, /Target/);
  assert.match((await bot.handle({ updateId: "r", chatType: "private", userId: "1", command: "/rules" })).text, /BUY_ONLY/);
  await bot.handle({ updateId: "p", chatType: "private", userId: "1", command: "/pause" });
  assert.deepEqual(pauses, [["1", true]]);
});

test("CP6: renderers do not expose recovery material or quality claims", () => {
  const wallets = walletListMessage([{ alias: "Main", publicAddress: "0x7777777777777777777777777777777777777777", balance: "1.0" }]);
  const receipt = tradeReceiptMessage({ state: "CONFIRMED", quote: { direction: "BUY", targetToken: "0x5555555555555555555555555555555555555555", amountIn: "100", minimumOutput: "990" } });
  assert.doesNotMatch(JSON.stringify([wallets, receipt]), /mnemonic|private key|guaranteed|good trade/i);
  assert.doesNotMatch(JSON.stringify(wallets), /wallet\.new|wallet\.import/i);
});

test("CP12: user can choose notifications or confirm-each copy-trading", async () => {
  const { product: bot, modes } = product();
  const menu = await bot.handle({ updateId: "mode-menu", kind: "message", chatType: "private", userId: "1", command: "/copy" });
  assert.match(menu.text, /notifications only/i);
  assert.match(JSON.stringify(menu.reply_markup), /copy\.mode\.confirm_each/);
  const enabled = await bot.handle({ updateId: "mode-enable", kind: "callback", chatType: "private", userId: "1", callbackData: "copy.mode.confirm_each" });
  assert.match(enabled.text, /confirm every trade/i);
  const blockedAuto = await bot.handle({ updateId: "mode-auto", kind: "callback", chatType: "private", userId: "1", callbackData: "copy.mode.auto.enable" });
  assert.equal(blockedAuto.executionBlocked, true);
  const disabled = await bot.handle({ updateId: "mode-notify", kind: "callback", chatType: "private", userId: "1", callbackData: "copy.mode.notify" });
  assert.match(disabled.text, /notifications only/i);
  assert.deepEqual(modes, [["1", "CONFIRM_EACH"], ["1", "NOTIFY_ONLY"]]);
});

test("CP12: Telegram manual SELL can only open the isolated secure sheet", async () => {
  const base = product();
  const manualSellService = {
    async review() { return { token: "0x5555555555555555555555555555555555555555", amount: "100", expectedOutput: "250", minimumReceived: "247", slippageBps: 100, priceImpactBps: 60, expiresAt: 1030, confirmationToken: "signed-confirm-token" }; },
    async confirm() { return { transactionHash: `0x${"d".repeat(64)}` }; },
  };
  const bot = new TelegramProduct({ botUsername: "lintchabot", dataSource: base.product.dataSource, intentSink: base.product.intentSink, manualSellService, copyAppUrl: "https://copy.example/copy/confirm" });
  const review = await bot.handle({ updateId: "sell-review", kind: "callback", chatType: "private", userId: "1", callbackData: "sell.review.signal-token", nowSeconds: 1002 });
  assert.match(review.text, /secure sheet/i);
  assert.match(JSON.stringify(review.reply_markup), /https:\/\/copy\.example\/copy\/confirm/);
  const submitted = await bot.handle({ updateId: "sell-confirm", kind: "callback", chatType: "private", userId: "1", callbackData: "sell.confirm.signed-confirm-token", nowSeconds: 1003 });
  assert.match(submitted.text, /not submitted/i);
  assert.equal(submitted.executionBlocked, true);
});
