import { createHmac } from "node:crypto";
import { sanitizeMetadata } from "../security/hardening.mjs";

export const ROBINHOOD_MAINNET_CHAIN_ID = 4663;

export class BetaGate {
  constructor({ allowedUserIds = [], enabled = false, executionEnabled = false }) {
    this.allowed = new Set(allowedUserIds.map(String));
    this.enabled = enabled;
    this.executionEnabled = executionEnabled;
  }

  authorize({ userId, chainId, mode, executionAuthorization }) {
    if (!this.enabled) throw new Error("BETA_DISABLED");
    if (chainId !== ROBINHOOD_MAINNET_CHAIN_ID) throw new Error("BETA_MAINNET_ONLY");
    if (!this.allowed.has(String(userId))) throw new Error("BETA_USER_NOT_ALLOWLISTED");
    if (mode === "COPY_TRADING") {
      if (!this.executionEnabled) throw new Error("BETA_EXECUTION_DISABLED");
      if (executionAuthorization?.status !== "active") throw new Error("BETA_EXECUTION_AUTHORIZATION_REQUIRED");
    } else if (mode !== "NOTIFY_ONLY") {
      throw new Error("BETA_MODE_UNSUPPORTED");
    }
    return true;
  }
}

export class OperationalMetrics {
  constructor() {
    this.rows = [];
  }

  record({ operation, outcome, latencyMs }) {
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(operation)) throw new TypeError("invalid operation");
    if (!['ok','failed','blocked'].includes(outcome)) throw new TypeError("invalid outcome");
    if (!Number.isFinite(latencyMs) || latencyMs < 0) throw new TypeError("invalid latency");
    this.rows.push({ operation, outcome, latencyMs: Math.round(latencyMs) });
  }

  snapshot() {
    const byOperation = {};
    for (const row of this.rows) {
      const item = byOperation[row.operation] ??= { ok: 0, failed: 0, blocked: 0, latencies: [] };
      item[row.outcome] += 1;
      item.latencies.push(row.latencyMs);
    }
    for (const item of Object.values(byOperation)) {
      item.latencies.sort((a, b) => a - b);
      item.p50Ms = percentile(item.latencies, 0.5);
      item.p95Ms = percentile(item.latencies, 0.95);
      delete item.latencies;
    }
    return { sampleCount: this.rows.length, byOperation };
  }
}

function percentile(values, p) {
  if (!values.length) return null;
  return values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
}

export class FeedbackCollector {
  constructor({ pseudonymSecret }) {
    this.pseudonymSecret = pseudonymSecret;
    this.rows = [];
  }

  add({ userId, category, message, createdAt }) {
    if (!['ux','decoder','latency','wallet','other'].includes(category)) throw new TypeError("invalid feedback category");
    if (/0x[0-9a-f]{40}|seed|mnemonic|private.?key|bot.?token/i.test(message)) throw new Error("SENSITIVE_FEEDBACK_REJECTED");
    const clean = sanitizeMetadata(message, 500);
    const userPseudonym = createHmac("sha256", this.pseudonymSecret).update(String(userId)).digest("hex").slice(0, 16);
    const row = Object.freeze({ userPseudonym, category, message: clean, createdAt });
    this.rows.push(row);
    return row;
  }
}

export function evaluateBetaReadiness({ metrics, criticalIncidents, observedSignals, thresholds }) {
  if (!thresholds || !Number.isSafeInteger(thresholds.minimumSamples) || !Number.isFinite(thresholds.maximumFailureRate) || !Number.isFinite(thresholds.maximumP95Ms)) {
    throw new TypeError("explicit readiness thresholds required");
  }
  const failures = Object.values(metrics.byOperation).reduce((sum, row) => sum + row.failed, 0);
  const failureRate = metrics.sampleCount === 0 ? 1 : failures / metrics.sampleCount;
  const worstP95 = Math.max(0, ...Object.values(metrics.byOperation).map((row) => row.p95Ms ?? 0));
  const blockers = [];
  if (metrics.sampleCount < thresholds.minimumSamples) blockers.push("INSUFFICIENT_MEASURED_SAMPLES");
  if (failureRate > thresholds.maximumFailureRate) blockers.push("FAILURE_RATE_EXCEEDED");
  if (worstP95 > thresholds.maximumP95Ms) blockers.push("LATENCY_EXCEEDED");
  if (criticalIncidents > 0) blockers.push("CRITICAL_INCIDENTS_PRESENT");
  if (!observedSignals?.buy || !observedSignals?.sell) blockers.push("MAINNET_OBSERVATION_EVIDENCE_INCOMPLETE");
  return Object.freeze({ ready: blockers.length === 0, blockers, measurements: { sampleCount: metrics.sampleCount, failureRate, worstP95 } });
}
