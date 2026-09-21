import assert from "node:assert/strict";
import { test } from "node:test";
import { TradingStore } from "../src/persistence/store.mjs";
import { evaluateRule, MATCH_REASONS, validateRule } from "../src/rules/engine.mjs";

const token = "0x1111111111111111111111111111111111111111";
const baseRule = Object.freeze({
  id: "rule-1", revision: 1, status: "active", direction: "BUY_ONLY", minSourceAmount: "100",
  sizingPolicy: "FIXED_QUOTE", sizingValue: "200", maxPerTrade: "500", maxPerDay: "1000",
  maxSlippageBps: 100, maxPriceImpactBps: 200, quoteTtlSeconds: 30, cooldownSeconds: 60,
  filters: { allowTokens: [token], denyTokens: [], preventRepeatBuy: true },
});
const event = Object.freeze({ sourceId: "4663:tx:1", direction: "BUY", sourceAmount: "1000", targetToken: token });
const context = Object.freeze({
  globalPaused: false, duplicate: false, hasPosition: false, lastTradeAt: null, nowSeconds: 1000,
  dailyUsed: "0", availableQuoteBalance: "1000", availableTokenBalance: "0",
});

test("CP3: persistence CRUD is revision guarded and audited", () => {
  const store = new TradingStore();
  store.createUser({ id: "u1", telegramUserId: "9007199254740001", now: 0 });
  store.createTarget({ id: "t1", userId: "u1", sourceAddress: "0x2222222222222222222222222222222222222222", alias: "Alpha", chainId: 4663, now: 0 });
  const updated = store.updateTarget({ id: "t1", actorId: "u1", alias: "Beta", status: "paused", expectedRevision: 1, reason: "user_pause", now: 1000 });
  assert.equal(updated.alias, "Beta");
  assert.equal(updated.revision, 2);
  assert.equal(store.updateTarget({ id: "t1", actorId: "u1", status: "active", expectedRevision: 1, reason: "stale", now: 2000 }), null);
  assert.equal(store.auditTrail().length, 2);
  store.close();
});

test("CP3: one event/rule match can be persisted only once", () => {
  const store = new TradingStore();
  store.createUser({ id: "u1", telegramUserId: "1", now: 0 });
  store.createTarget({ id: "t1", userId: "u1", sourceAddress: "0x2222222222222222222222222222222222222222", alias: "Alpha", chainId: 4663, now: 0 });
  store.createRule({ ...baseRule, targetId: "t1", actorId: "u1" }, 0);
  const result = evaluateRule(baseRule, event, context);
  assert.equal(store.recordRuleMatch({ id: result.id, sourceEventId: event.sourceId, ruleId: baseRule.id, ruleRevision: 1, matched: true, reason: result.reason, receipt: result, now: 0 }), true);
  assert.equal(store.recordRuleMatch({ id: result.id, sourceEventId: event.sourceId, ruleId: baseRule.id, ruleRevision: 1, matched: true, reason: result.reason, receipt: result, now: 0 }), false);
  store.close();
});

test("CP3: deterministic matching receipt", () => {
  const first = evaluateRule(baseRule, event, context);
  const second = evaluateRule(baseRule, event, context);
  assert.deepEqual(first, second);
  assert.equal(first.matched, true);
  assert.equal(first.ownAmount, "200");
});

for (const [name, rulePatch, eventPatch, contextPatch, expected] of [
  ["paused", { status: "paused" }, {}, {}, MATCH_REASONS.RULE_PAUSED],
  ["direction", { direction: "SELL_ONLY", sizingPolicy: "SOURCE_RATIO", sizingValue: "1000" }, {}, {}, MATCH_REASONS.DIRECTION_DISABLED],
  ["threshold", { minSourceAmount: "1001" }, {}, {}, MATCH_REASONS.SOURCE_BELOW_THRESHOLD],
  ["denylist", { filters: { allowTokens: [], denyTokens: [token] } }, {}, {}, MATCH_REASONS.UNSUPPORTED_ASSET],
  ["global pause", {}, {}, { globalPaused: true }, MATCH_REASONS.GLOBAL_PAUSED],
  ["duplicate", {}, {}, { duplicate: true }, MATCH_REASONS.DUPLICATE],
  ["repeat buy", {}, {}, { hasPosition: true }, MATCH_REASONS.POSITION_ALREADY_HELD],
  ["cooldown", {}, {}, { lastTradeAt: 950 }, MATCH_REASONS.COOLDOWN_ACTIVE],
  ["daily cap", {}, {}, { dailyUsed: "1000" }, MATCH_REASONS.DAILY_CAP_REACHED],
  ["balance", {}, {}, { availableQuoteBalance: "199" }, MATCH_REASONS.INSUFFICIENT_BALANCE],
]) {
  test(`CP3 branch: ${name}`, () => {
    const result = evaluateRule({ ...baseRule, ...rulePatch }, { ...event, ...eventPatch }, { ...context, ...contextPatch });
    assert.equal(result.reason, expected);
    assert.equal(result.matched, false);
  });
}

test("CP3: proportional sell is capped by owned balance", () => {
  const rule = { ...baseRule, direction: "SELL_ONLY", sizingPolicy: "SOURCE_RATIO", sizingValue: "5000", filters: { allowTokens: [token] } };
  const result = evaluateRule(rule, { ...event, direction: "SELL" }, { ...context, availableTokenBalance: "300" });
  assert.equal(result.matched, true);
  assert.equal(result.ownAmount, "300");
});

test("CP3: unsafe sell FIXED_QUOTE rule is rejected", () => {
  assert.throws(() => validateRule({ ...baseRule, direction: "BUY_AND_SELL" }), /FIXED_QUOTE is buy-only/);
});
