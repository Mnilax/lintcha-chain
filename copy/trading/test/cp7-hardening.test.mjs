import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyAtomicOutputFee, FeeSchedule, FREE_PERIOD_SECONDS } from "../src/fee/fee-policy.mjs";
import { TradingStore } from "../src/persistence/store.mjs";
import { AdminAuthorizer } from "../src/referral/referral.mjs";
import { assertNoExternalRuntimeDependencies, backupDatabase, EmergencyControl, FixedWindowRateLimiter, readRpcQuorum, sanitizeMetadata, SECURE_SHEET_CSP } from "../src/security/hardening.mjs";

test("CP7: CSP and dependency surface are strict", () => {
  assert.match(SECURE_SHEET_CSP, /default-src 'none'/);
  assert.match(SECURE_SHEET_CSP, /connect-src 'self'/);
  assert.doesNotMatch(SECURE_SHEET_CSP, /unsafe-inline|unsafe-eval|https:\/\/\*/);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(assertNoExternalRuntimeDependencies(pkg), true);
});

test("CP7: rate limits are explicit and deterministic", () => {
  const limiter = new FixedWindowRateLimiter({ limit: 2, windowSeconds: 10 });
  assert.equal(limiter.allow("user:1", 1), true);
  assert.equal(limiter.allow("user:1", 2), true);
  assert.equal(limiter.allow("user:1", 3), false);
  assert.equal(limiter.allow("user:1", 10), true);
});

test("CP7: RPC matrix accepts agreement and rejects failure/disagreement", async () => {
  const value = { number: 10, hash: "0xabc" };
  assert.deepEqual(await readRpcQuorum([{ read: async () => value }, { read: async () => value }], { method: "fixture" }), value);
  await assert.rejects(() => readRpcQuorum([{ read: async () => value }, { read: async () => ({ ...value, hash: "0xdef" }) }], {}), /RPC_DISAGREEMENT/);
  await assert.rejects(() => readRpcQuorum([{ read: async () => value }, { read: async () => { throw new Error("offline"); } }], {}), /RPC_QUORUM_UNAVAILABLE/);
});

test("CP7: malicious metadata is rendered inert", () => {
  const value = sanitizeMetadata("<script>alert(1)</script>\u0000Alias", 32);
  assert.doesNotMatch(value, /[<>\u0000]/);
  assert.match(value, /scriptalert/);
});

test("CP7: emergency pause starts closed and rollback does not touch Core", () => {
  const control = new EmergencyControl();
  assert.throws(() => control.assertNewWorkAllowed(), /GLOBAL_EMERGENCY_PAUSE/);
  control.resume({ actorId: "owner", reason: "local fixture start" });
  assert.doesNotThrow(() => control.assertNewWorkAllowed());
  control.pause({ actorId: "owner", reason: "local rollback drill" });
  assert.throws(() => control.assertNewWorkAllowed(), /GLOBAL_EMERGENCY_PAUSE/);
  assert.equal(control.reason, "local rollback drill");
});

test("CP7: SQLite backup restores data and idempotency constraints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lintcha-v2-cp7-"));
  const backupPath = join(dir, "backup.sqlite");
  try {
    const source = new TradingStore();
    source.createUser({ id: "u1", telegramUserId: "1", now: 0 });
    assert.equal(source.claimIdempotency("fixture", "same", "result", 0), true);
    assert.equal(source.claimIdempotency("fixture", "same", "result", 0), false);
    await backupDatabase(source, backupPath);
    source.close();
    const restored = new TradingStore(backupPath);
    assert.equal(restored.db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 1);
    assert.equal(restored.db.prepare("SELECT COUNT(*) AS n FROM idempotency_keys").get().n, 1);
    restored.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CP7: fee invariant rejects extra or missing output", () => {
  const asset = "0x9999999999999999999999999999999999999999";
  const schedule = new FeeSchedule({ version: 1, activationAtSeconds: 0 });
  const preview = schedule.preview({ timestampSeconds: FREE_PERIOD_SECONDS, feeBaseAmount: "10000", feeAsset: asset });
  assert.doesNotThrow(() => verifyAtomicOutputFee({ preview, grossOutput: "10000", userOutput: "9900", feeTransferAmount: "100", feeTransferRecipient: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", expectedRecipient: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }));
  assert.throws(() => verifyAtomicOutputFee({ preview, grossOutput: "10000", userOutput: "9900", feeTransferAmount: "101", feeTransferRecipient: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", expectedRecipient: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), /FEE_AMOUNT_MISMATCH/);
});

test("CP7: admin authorization requires exact owner, strong auth, step-up and reason", () => {
  const auth = new AdminAuthorizer("owner");
  assert.throws(() => auth.require({ actorId: "other", strongAuth: true, stepUp: true, reason: "x" }), /OWNER_REQUIRED/);
  assert.throws(() => auth.require({ actorId: "owner", strongAuth: true, stepUp: false, reason: "x" }), /STEP_UP_REQUIRED/);
  assert.throws(() => auth.require({ actorId: "owner", strongAuth: true, stepUp: true, reason: "" }), /REASON_REQUIRED/);
  assert.equal(auth.require({ actorId: "owner", strongAuth: true, stepUp: true, reason: "fixture" }), true);
});
