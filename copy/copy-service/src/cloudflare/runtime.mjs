import { loadCopyConfig } from "../config.mjs";
import { HashChainedAuditLog } from "../audit.mjs";
import { ExecutionPolicyGate, KillSwitches } from "../policy.mjs";
import { ReadOnlyJsonRpcProvider, RpcPool } from "../rpc-pool.mjs";
import { SimulationQuorum } from "../simulation.mjs";
import { LintchaCopyService } from "../service.mjs";
import { ServiceBindingDelegatedExecutor, UnconfiguredDelegatedExecutor } from "../delegated-execution.mjs";
import { GatewayRequestVerifier } from "../gateway-auth.mjs";
import { SignedServiceRequestVerifier, createCopyHttpHandler } from "../http.mjs";
import { CopyTelegramSurface } from "../telegram-surface.mjs";
import { TelegramInitDataVerifier } from "../telegram-init-data.mjs";
import { D1AuditSink, D1DelegationStore, D1IntentStore, D1KillSwitchStore, D1OutboxStore, D1ReplayStore, D1SpendLedger, D1UserStore } from "./d1-store.mjs";
import { createCoordinatedService } from "./coordinator.mjs";

const FORBIDDEN_ENV = /^(?:BOT_TOKEN|TELEGRAM_BOT_TOKEN|TELEGRAM_WEBHOOK_SECRET|SEED|MNEMONIC|PRIVATE_KEY|WALLET_VAULT)$/i;

function secret(env, name, minBytes = 32) {
  const value = env[name];
  if (typeof value !== "string" || Buffer.byteLength(value) < minBytes) throw new Error(`${name}_REQUIRED`);
  return value;
}

/** A provider that has no endpoint yet. Every read fails closed; nothing pretends to be simulated. */
class UnconfiguredProvider {
  constructor(id) { this.id = id; }
  async request() { throw new Error("RPC_NOT_CONFIGURED"); }
}

/**
 * Builds one request's runtime from Worker bindings. Nothing here reads a bot token; if one is present the
 * config loader refuses, and any other secret-looking binding is refused here as well. RPC URLs are never
 * logged, echoed or included in errors.
 */
export async function buildRuntime(env, { coordinated = true, fetchImpl = globalThis.fetch, clock = () => Math.floor(Date.now() / 1000) } = {}) {
  for (const key of Object.keys(env)) if (FORBIDDEN_ENV.test(key)) throw new Error("COPY_SERVICE_MUST_NOT_RECEIVE_BOT_TOKEN");
  const config = loadCopyConfig(env);
  if (!env.COPY_DB) throw new Error("COPY_DB_BINDING_REQUIRED");
  if (coordinated && !env.COPY_USER) throw new Error("COPY_USER_BINDING_REQUIRED");
  if (config.delegatedSubmissionEnabled && !env.COPY_DELEGATED_EXECUTOR) throw new Error("COPY_DELEGATED_EXECUTOR_BINDING_REQUIRED");
  const gatewaySecret = secret(env, "COPY_GATEWAY_SECRET");
  const confirmationSecret = Buffer.from(secret(env, "COPY_CONFIRMATION_SECRET", 64), "hex");
  if (confirmationSecret.length < 32) throw new Error("COPY_CONFIRMATION_SECRET_REQUIRED");
  const adminSecret = env.COPY_ADMIN_SECRET ? secret(env, "COPY_ADMIN_SECRET") : null;
  const db = env.COPY_DB;

  const providers = config.rpc.endpoints.map((item) => item.url ? new ReadOnlyJsonRpcProvider({ id: item.id, url: item.url, fetchImpl }) : new UnconfiguredProvider(item.id));
  const rpcPool = new RpcPool({ providers, chainId: config.chainId, maxHeadSkewBlocks: config.rpc.maxHeadSkewBlocks });
  const killSwitchStore = new D1KillSwitchStore(db);
  const killSwitches = KillSwitches.load(await killSwitchStore.rows());
  if (config.startsGloballyPaused && killSwitches.revision === 1) killSwitches.globallyPaused = true;
  const policyGate = new ExecutionPolicyGate({ config: config.policy, killSwitches, spendLedger: new D1SpendLedger(db) });
  const auditLog = await HashChainedAuditLog.resume({ sink: new D1AuditSink(db), clock: () => Date.now() });
  const delegationStore = new D1DelegationStore(db, clock);
  const delegatedExecutor = config.delegatedSubmissionEnabled ? new ServiceBindingDelegatedExecutor(env.COPY_DELEGATED_EXECUTOR) : new UnconfiguredDelegatedExecutor();
  const localService = new LintchaCopyService({
    policyGate, simulator: new SimulationQuorum({ rpcPool, maxGasEstimateSkewBps: config.rpc.maxGasEstimateSkewBps }), rpcPool,
    auditLog, intentStore: new D1IntentStore(db), confirmationSecret, clock, delegationStore,
    delegatedExecutor,
    autoBuyEnabled: config.autoBuyEnabled, delegatedSubmissionEnabled: config.delegatedSubmissionEnabled, autoBuyExecutorAddress: config.autoBuyExecutorAddress,
  });
  const service = coordinated
    ? createCoordinatedService({ localService, clock, stubFor: (userId) => env.COPY_USER.get(env.COPY_USER.idFromName(`copy-user:${userId}`)) })
    : localService;
  const userStore = new D1UserStore(db, clock);
  const outbox = new D1OutboxStore(db, clock);
  const replayStore = new D1ReplayStore(db);
  const surface = new CopyTelegramSurface({ userStore, delegationStore, killSwitches, appOrigin: config.appOrigin, appPath: config.appPath, service, autoBuyAvailable: config.autoBuyEnabled });
  const handler = createCopyHttpHandler({
    config, service, surface, userStore, delegationStore, delegationVerifier: delegatedExecutor, outbox, killSwitches, clock,
    gatewayVerifier: new GatewayRequestVerifier({ secret: gatewaySecret, replayStore }),
    serviceVerifier: {
      outbox: new SignedServiceRequestVerifier({ secret: gatewaySecret, schema: "lintcha.copy.outbox.v1", replayStore }),
      notify: new SignedServiceRequestVerifier({ secret: gatewaySecret, schema: "lintcha.copy.notify.v1", replayStore }),
      intent: new SignedServiceRequestVerifier({ secret: gatewaySecret, schema: "lintcha.copy.intent.v1", replayStore }),
      autoBuy: new SignedServiceRequestVerifier({ secret: gatewaySecret, schema: "lintcha.copy.auto-buy.v1", replayStore }),
    },
    adminVerifier: adminSecret ? new SignedServiceRequestVerifier({ secret: adminSecret, schema: "lintcha.copy.admin.v1", replayStore }) : null,
    // A key override exists for local/preproduction test rigs only; production always uses Telegram's published key.
    initDataVerifier: new TelegramInitDataVerifier({ botId: env.COPY_TELEGRAM_BOT_ID, environment: env.COPY_TELEGRAM_ENV || "production", publicKeyHex: config.mode !== "production" && env.COPY_TELEGRAM_PUBLIC_KEY_HEX ? env.COPY_TELEGRAM_PUBLIC_KEY_HEX : null }),
    persistKillSwitches: (snapshot, meta) => killSwitchStore.persist(snapshot, meta),
  });
  return Object.freeze({ config, service, localService, handler, killSwitches, userStore, delegationStore, outbox, rpcPool });
}
