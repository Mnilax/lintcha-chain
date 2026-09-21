import assert from "node:assert/strict";
import { test } from "node:test";
import { BetaGate, evaluateBetaReadiness, FeedbackCollector, OperationalMetrics, ROBINHOOD_MAINNET_CHAIN_ID } from "../src/beta/readiness.mjs";

test("CP8: beta starts disabled and gates mainnet execution separately", () => {
  const disabled = new BetaGate({ allowedUserIds: ["1"] });
  assert.throws(() => disabled.authorize({ userId: "1", chainId: ROBINHOOD_MAINNET_CHAIN_ID, mode: "NOTIFY_ONLY" }), /BETA_DISABLED/);
  const gate = new BetaGate({ allowedUserIds: ["1"], enabled: true });
  assert.throws(() => gate.authorize({ userId: "1", chainId: 46630, mode: "NOTIFY_ONLY" }), /BETA_MAINNET_ONLY/);
  assert.throws(() => gate.authorize({ userId: "1", chainId: ROBINHOOD_MAINNET_CHAIN_ID, mode: "CONFIRM_EACH" }), /BETA_MODE_UNSUPPORTED/);
  assert.throws(() => gate.authorize({ userId: "1", chainId: ROBINHOOD_MAINNET_CHAIN_ID, mode: "COPY_TRADING" }), /BETA_EXECUTION_DISABLED/);
  assert.throws(() => gate.authorize({ userId: "2", chainId: ROBINHOOD_MAINNET_CHAIN_ID, mode: "NOTIFY_ONLY" }), /NOT_ALLOWLISTED/);
  assert.equal(gate.authorize({ userId: "1", chainId: ROBINHOOD_MAINNET_CHAIN_ID, mode: "NOTIFY_ONLY" }), true);
  const executionGate = new BetaGate({ allowedUserIds: ["1"], enabled: true, executionEnabled: true });
  assert.throws(() => executionGate.authorize({ userId: "1", chainId: ROBINHOOD_MAINNET_CHAIN_ID, mode: "COPY_TRADING" }), /AUTHORIZATION_REQUIRED/);
  assert.equal(executionGate.authorize({ userId: "1", chainId: ROBINHOOD_MAINNET_CHAIN_ID, mode: "COPY_TRADING", executionAuthorization: { status: "active" } }), true);
});

test("CP8: operational metrics aggregate latency without user or wallet data", () => {
  const metrics = new OperationalMetrics();
  metrics.record({ operation: "observer.poll", outcome: "ok", latencyMs: 10 });
  metrics.record({ operation: "observer.poll", outcome: "failed", latencyMs: 30 });
  const snapshot = metrics.snapshot();
  assert.equal(snapshot.sampleCount, 2);
  assert.equal(snapshot.byOperation["observer.poll"].p50Ms, 10);
  assert.equal(snapshot.byOperation["observer.poll"].p95Ms, 30);
  assert.doesNotMatch(JSON.stringify(snapshot), /user|wallet|0x[0-9a-f]{40}/i);
});

test("CP8: feedback is pseudonymous and rejects sensitive material", () => {
  const collector = new FeedbackCollector({ pseudonymSecret: "TEST_FEEDBACK_SECRET_NOT_REAL" });
  const row = collector.add({ userId: "12345", category: "ux", message: "Review screen was clear", createdAt: "2026-09-18T00:00:00Z" });
  assert.notEqual(row.userPseudonym, "12345");
  assert.throws(() => collector.add({ userId: "12345", category: "wallet", message: "private key: fixture", createdAt: "2026-09-18T00:00:00Z" }), /SENSITIVE_FEEDBACK_REJECTED/);
});

test("CP8: readiness refuses assumptions and requires measured journeys", () => {
  const metrics = new OperationalMetrics();
  metrics.record({ operation: "fixture", outcome: "ok", latencyMs: 10 });
  const result = evaluateBetaReadiness({
    metrics: metrics.snapshot(), criticalIncidents: 0, observedSignals: { buy: false, sell: false },
    thresholds: { minimumSamples: 10, maximumFailureRate: 0.1, maximumP95Ms: 100 },
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers, ["INSUFFICIENT_MEASURED_SAMPLES", "MAINNET_OBSERVATION_EVIDENCE_INCOMPLETE"]);
});

test("CP8: readiness can pass only explicit fixture thresholds", () => {
  const metrics = new OperationalMetrics();
  for (let i = 0; i < 10; i += 1) metrics.record({ operation: "fixture", outcome: "ok", latencyMs: 10 + i });
  const result = evaluateBetaReadiness({
    metrics: metrics.snapshot(), criticalIncidents: 0, observedSignals: { buy: true, sell: true },
    thresholds: { minimumSamples: 10, maximumFailureRate: 0, maximumP95Ms: 20 },
  });
  assert.equal(result.ready, true);
});
