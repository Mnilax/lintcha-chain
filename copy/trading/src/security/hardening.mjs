import { backup } from "node:sqlite";

export const SECURE_SHEET_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "frame-ancestors https://web.telegram.org",
].join("; ");

export function sanitizeMetadata(value, maxLength = 64) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>]/g, "")
    .normalize("NFKC")
    .slice(0, maxLength);
}

export class FixedWindowRateLimiter {
  constructor({ limit, windowSeconds }) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(windowSeconds) || windowSeconds <= 0) throw new TypeError("explicit rate policy required");
    this.limit = limit;
    this.windowSeconds = windowSeconds;
    this.buckets = new Map();
  }

  allow(key, nowSeconds) {
    const window = Math.floor(nowSeconds / this.windowSeconds);
    const current = this.buckets.get(key);
    if (!current || current.window !== window) {
      this.buckets.set(key, { window, count: 1 });
      return true;
    }
    if (current.count >= this.limit) return false;
    current.count += 1;
    return true;
  }
}

export async function readRpcQuorum(providers, request) {
  if (!Array.isArray(providers) || providers.length < 2) throw new Error("RPC_REDUNDANCY_REQUIRED");
  const settled = await Promise.allSettled(providers.map((provider) => provider.read(request)));
  const successes = settled.filter((result) => result.status === "fulfilled").map((result) => JSON.stringify(result.value));
  if (successes.length < 2) throw new Error("RPC_QUORUM_UNAVAILABLE");
  if (new Set(successes).size !== 1) throw new Error("RPC_DISAGREEMENT");
  return JSON.parse(successes[0]);
}

export class EmergencyControl {
  constructor() {
    this.paused = true;
    this.revision = 1;
    this.reason = "STARTS_FAIL_CLOSED";
  }

  resume({ actorId, reason }) {
    if (!actorId || !String(reason ?? "").trim()) throw new Error("PAUSE_AUDIT_REQUIRED");
    this.paused = false;
    this.reason = reason;
    this.revision += 1;
  }

  pause({ actorId, reason }) {
    if (!actorId || !String(reason ?? "").trim()) throw new Error("PAUSE_AUDIT_REQUIRED");
    this.paused = true;
    this.reason = reason;
    this.revision += 1;
  }

  assertNewWorkAllowed() {
    if (this.paused) throw new Error("GLOBAL_EMERGENCY_PAUSE");
  }
}

export async function backupDatabase(store, destinationPath) {
  await backup(store.db, destinationPath);
  return destinationPath;
}

export function assertNoExternalRuntimeDependencies(packageJson) {
  const runtime = Object.keys(packageJson.dependencies ?? {});
  if (runtime.length) throw new Error(`EXTERNAL_RUNTIME_DEPENDENCIES:${runtime.join(",")}`);
  return true;
}
