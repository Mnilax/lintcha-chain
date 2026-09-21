import { asBigInt, deterministicId, normalizeAddress } from "../utils.mjs";

export const MATCH_REASONS = Object.freeze({
  MATCHED: "MATCHED",
  GLOBAL_PAUSED: "GLOBAL_PAUSED",
  RULE_PAUSED: "RULE_PAUSED",
  DIRECTION_DISABLED: "DIRECTION_DISABLED",
  SOURCE_BELOW_THRESHOLD: "SOURCE_BELOW_THRESHOLD",
  UNSUPPORTED_ASSET: "UNSUPPORTED_ASSET",
  DAILY_CAP_REACHED: "DAILY_CAP_REACHED",
  COOLDOWN_ACTIVE: "COOLDOWN_ACTIVE",
  POSITION_ALREADY_HELD: "POSITION_ALREADY_HELD",
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  DUPLICATE: "DUPLICATE",
});

export function validateRule(rule) {
  if (!['BUY_ONLY','SELL_ONLY','BUY_AND_SELL'].includes(rule.direction)) throw new TypeError("invalid direction");
  if (!['FIXED_QUOTE','SOURCE_RATIO','BALANCE_PERCENT'].includes(rule.sizingPolicy)) throw new TypeError("invalid sizing policy");
  for (const field of ['sizingValue','maxPerTrade','maxPerDay']) if (asBigInt(rule[field], field) <= 0n) throw new TypeError(`${field} must be positive`);
  for (const field of ['maxSlippageBps','maxPriceImpactBps','quoteTtlSeconds','cooldownSeconds']) {
    if (!Number.isSafeInteger(rule[field]) || rule[field] < 0) throw new TypeError(`invalid ${field}`);
  }
  if (rule.maxSlippageBps > 10000 || rule.maxPriceImpactBps > 10000) throw new TypeError("basis points out of range");
  if (rule.sizingPolicy !== 'FIXED_QUOTE' && asBigInt(rule.sizingValue) > 10000n) throw new TypeError("percentage exceeds 100%");
  if ((rule.direction === 'SELL_ONLY' || rule.direction === 'BUY_AND_SELL') && rule.sizingPolicy === 'FIXED_QUOTE') throw new TypeError("FIXED_QUOTE is buy-only");
  return true;
}

function skip(rule, event, reason) {
  return receipt(rule, event, false, reason, 0n);
}

function receipt(rule, event, matched, reason, ownAmount) {
  const id = deterministicId(event.sourceId, rule.id, rule.revision, event.direction);
  return Object.freeze({
    id,
    sourceEventId: event.sourceId,
    ruleId: rule.id,
    ruleRevision: rule.revision,
    direction: event.direction,
    matched,
    reason,
    ownAmount: ownAmount.toString(),
  });
}

export function evaluateRule(rule, event, context) {
  validateRule(rule);
  if (context.globalPaused) return skip(rule, event, MATCH_REASONS.GLOBAL_PAUSED);
  if (rule.status !== "active") return skip(rule, event, MATCH_REASONS.RULE_PAUSED);
  const directionAllowed = rule.direction === "BUY_AND_SELL" || rule.direction === `${event.direction}_ONLY`;
  if (!directionAllowed) return skip(rule, event, MATCH_REASONS.DIRECTION_DISABLED);
  const sourceAmount = asBigInt(event.sourceAmount, "sourceAmount");
  if (rule.minSourceAmount !== null && rule.minSourceAmount !== undefined && sourceAmount < asBigInt(rule.minSourceAmount)) return skip(rule, event, MATCH_REASONS.SOURCE_BELOW_THRESHOLD);

  const token = normalizeAddress(event.targetToken);
  const deny = new Set((rule.filters?.denyTokens ?? []).map(normalizeAddress));
  const allow = new Set((rule.filters?.allowTokens ?? []).map(normalizeAddress));
  if (deny.has(token) || (allow.size > 0 && !allow.has(token))) return skip(rule, event, MATCH_REASONS.UNSUPPORTED_ASSET);
  if (context.duplicate) return skip(rule, event, MATCH_REASONS.DUPLICATE);
  if (event.direction === "BUY" && rule.filters?.preventRepeatBuy && context.hasPosition) return skip(rule, event, MATCH_REASONS.POSITION_ALREADY_HELD);
  if (rule.cooldownSeconds > 0 && context.lastTradeAt !== null && context.nowSeconds - context.lastTradeAt < rule.cooldownSeconds) return skip(rule, event, MATCH_REASONS.COOLDOWN_ACTIVE);

  const dailyUsed = asBigInt(context.dailyUsed ?? 0n);
  const maxPerDay = asBigInt(rule.maxPerDay);
  if (dailyUsed >= maxPerDay) return skip(rule, event, MATCH_REASONS.DAILY_CAP_REACHED);
  const balance = event.direction === "BUY" ? asBigInt(context.availableQuoteBalance) : asBigInt(context.availableTokenBalance);
  let desired;
  if (rule.sizingPolicy === "FIXED_QUOTE") desired = asBigInt(rule.sizingValue);
  else if (rule.sizingPolicy === "SOURCE_RATIO") desired = sourceAmount * asBigInt(rule.sizingValue) / 10000n;
  else desired = balance * asBigInt(rule.sizingValue) / 10000n;

  const capped = [desired, asBigInt(rule.maxPerTrade), maxPerDay - dailyUsed].reduce((a, b) => a < b ? a : b);
  if (capped <= 0n) return skip(rule, event, MATCH_REASONS.DAILY_CAP_REACHED);
  if (event.direction === "BUY" && balance < capped) return skip(rule, event, MATCH_REASONS.INSUFFICIENT_BALANCE);
  const ownAmount = event.direction === "SELL" && balance < capped ? balance : capped;
  if (ownAmount <= 0n) return skip(rule, event, MATCH_REASONS.INSUFFICIENT_BALANCE);
  return receipt(rule, event, true, MATCH_REASONS.MATCHED, ownAmount);
}
