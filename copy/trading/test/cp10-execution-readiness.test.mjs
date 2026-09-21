import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateExecutionLaunchReadiness } from "../src/beta/execution-readiness.mjs";
import { SIGNING_ARCHITECTURES } from "../src/execution/authorization.mjs";

const ready = Object.freeze({
  chainId: 4663,
  telegramTransportConfigured: true,
  productionRpcAccepted: true,
  signingArchitecture: SIGNING_ARCHITECTURES.ERC4337_SESSION_KEY,
  activeDelegation: true,
  atomicSpendReservation: true,
  mainnetSimulationPassed: true,
  monitoringAndPauseReady: true,
  platformFeeBps: 0,
  atomicFeeRouteProven: false,
  broadcastEnabled: true,
});

test("CP10: automatic launch readiness lists concrete missing external inputs", () => {
  const result = evaluateExecutionLaunchReadiness({ ...ready, telegramTransportConfigured: false, productionRpcAccepted: false, activeDelegation: false, broadcastEnabled: false });
  assert.deepEqual(result.blockers, ["TELEGRAM_TRANSPORT_NOT_CONFIGURED", "PRODUCTION_RPC_NOT_ACCEPTED", "ACTIVE_USER_DELEGATION_REQUIRED", "BROADCAST_KILL_SWITCH_OFF"]);
});

test("CP10: zero-fee beta can pass without an invented fee route", () => {
  assert.deepEqual(evaluateExecutionLaunchReadiness(ready), { ready: true, blockers: [] });
});

test("CP10: active platform fee fails closed until atomic collection is proven", () => {
  const result = evaluateExecutionLaunchReadiness({ ...ready, platformFeeBps: 100 });
  assert.equal(result.ready, false);
  assert.deepEqual(result.blockers, ["ATOMIC_FEE_ROUTE_REQUIRED"]);
});
