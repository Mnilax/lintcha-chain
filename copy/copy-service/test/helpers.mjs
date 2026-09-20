import { HashChainedAuditLog, MemoryAuditSink } from "../src/audit.mjs";
import { ExecutionPolicyGate, InMemorySpendLedger, KillSwitches } from "../src/policy.mjs";
import { RpcPool, RpcError } from "../src/rpc-pool.mjs";
import { SimulationQuorum } from "../src/simulation.mjs";
import { LintchaCopyService } from "../src/service.mjs";

export const WALLET = "0x1111111111111111111111111111111111111111";
export const ROUTER = "0x2222222222222222222222222222222222222222";
export const TOKEN = "0x3333333333333333333333333333333333333333";
export const HASH = `0x${"a".repeat(64)}`;
export const BLOCK_HASH = `0x${"b".repeat(64)}`;
export const NOW = 1_700_000_000;
export const word = (value) => BigInt(value).toString(16).padStart(64, "0");
export const addressWord = (address) => address.slice(2).toLowerCase().padStart(64, "0");

/** Deterministic mock provider. `overrides` may be values, functions of ({method, params}), or Error/RpcError instances. */
export function provider(id, overrides = {}) {
  const calls = [];
  const base = {
    eth_chainId: "0x1237",
    eth_blockNumber: "0x64",
    eth_getBlockByNumber: ({ params }) => ({ number: /^0x/.test(params[0]) ? params[0] : "0x64", hash: BLOCK_HASH, parentHash: `0x${"0".repeat(64)}` }),
    eth_call: ({ params }) => String(params[0]?.data || "").startsWith("0xdd62ed3e") ? `0x${word(1_000_000)}` : "0x01",
    eth_estimateGas: "0x5208",
    eth_getTransactionByHash: { hash: HASH, from: WALLET, to: ROUTER, input: "0x12345678", value: "0x1f4", nonce: "0x1", blockHash: BLOCK_HASH, blockNumber: "0x63" },
    eth_getTransactionReceipt: { transactionHash: HASH, from: WALLET, to: ROUTER, status: "0x1", blockHash: BLOCK_HASH, blockNumber: "0x63", gasUsed: "0x5208", logs: [] },
    ...overrides,
  };
  return {
    id, calls,
    async request(method, params = []) {
      calls.push({ method, params });
      const result = base[method];
      if (result instanceof Error) throw result;
      return typeof result === "function" ? result({ method, params }) : structuredClone(result);
    },
  };
}

export function revert(message = "execution reverted") { return new RpcError("RPC_JSON_FAILURE", { rpcError: { code: 3, message } }); }

export function fixture({ paused = false, firstOverrides = {}, secondOverrides = {}, maxTx = "1000", maxDay = "1500", clock, service: serviceOptions = {} } = {}) {
  let now = NOW;
  const tick = clock || (() => now);
  const primary = provider("alchemy", firstOverrides);
  const secondary = provider("quicknode", secondOverrides);
  const rpcPool = new RpcPool({ providers: [primary, secondary], chainId: 4663, maxHeadSkewBlocks: 2 });
  const killSwitches = new KillSwitches({ globallyPaused: paused });
  const spendLedger = new InMemorySpendLedger();
  const policyGate = new ExecutionPolicyGate({
    killSwitches, spendLedger,
    config: { chains: [4663], routers: [ROUTER], spenders: [ROUTER], selectors: ["0x12345678", "0x095ea7b3", "0xabcdef01"], maxSlippageBps: 100, maxTransactionWei: maxTx, maxDailySpendWei: maxDay, maxSellAmountByToken: { [TOKEN]: "1000" } },
  });
  const sink = new MemoryAuditSink();
  const auditLog = new HashChainedAuditLog({ sink, clock: () => 1_700_000_000_000 });
  const simulator = new SimulationQuorum({ rpcPool, maxGasEstimateSkewBps: 1500 });
  const service = new LintchaCopyService({ policyGate, simulator, rpcPool, auditLog, confirmationSecret: Buffer.alloc(32, 7), clock: tick, ...serviceOptions });
  return { primary, secondary, rpcPool, killSwitches, spendLedger, sink, service, policyGate, advance: (seconds) => { now += seconds; } };
}

export function input(overrides = {}) {
  return {
    userId: "42", walletAddress: WALLET, sourceTradeId: "source-1", utcDay: "2023-11-14", manualSell: false,
    quote: { id: "q1", direction: "BUY", targetToken: TOKEN, amountIn: "500", expectedOutput: "900", minimumOutput: "850", slippageBps: 50, expiresAt: NOW + 80 },
    transaction: { chainId: 4663, to: ROUTER, value: "500", data: "0x12345678" },
    ...overrides,
  };
}

export function sellTradeInput(overrides = {}) {
  return input({
    sourceTradeId: "sell-trade-1", manualSell: true,
    quote: { id: "sq1", direction: "SELL", targetToken: TOKEN, amountIn: "500", expectedOutput: "400", minimumOutput: "380", slippageBps: 50, expiresAt: NOW + 80 },
    transaction: { chainId: 4663, to: ROUTER, value: "0", data: "0xabcdef01" },
    ...overrides,
  });
}

export function approvalInput(amount = 500, overrides = {}) {
  return input({
    sourceTradeId: "sell-trade-1", manualSell: true, operation: "APPROVAL",
    quote: { id: "aq1", direction: "SELL", targetToken: TOKEN, amountIn: "500", expectedOutput: "400", minimumOutput: "380", slippageBps: 50, expiresAt: NOW + 80 },
    transaction: { chainId: 4663, to: TOKEN, value: "0", data: `0x095ea7b3${addressWord(ROUTER)}${word(amount)}` },
    ...overrides,
  });
}

/** Drives one intent through open → submit. Returns the service views. */
export async function openAndSubmit(current, created, { userId = "42", hash = HASH } = {}) {
  const opened = await current.service.beginSecureSheetConfirmation({ token: created.confirmationToken, userId, revision: created.revision });
  const submitted = await current.service.recordClientSubmission({ intentId: created.intentId, userId, revision: opened.revision, transactionHash: hash });
  return { opened, submitted };
}
