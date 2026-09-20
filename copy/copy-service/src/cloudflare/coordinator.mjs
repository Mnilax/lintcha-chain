/**
 * Per-user ordering. Every state-changing call for one Telegram user runs inside that user's Durable Object,
 * one at a time, so two clicks, a sweep and a reconciliation cannot interleave on the same intent or ledger day.
 * The object holds no state of its own beyond the queue: D1 remains the record, and the object can be evicted
 * at any moment without losing anything. Reads bypass the object.
 */
export const COORDINATED_OPERATIONS = Object.freeze(new Set([
  "createConfirmEachIntent", "beginSecureSheetConfirmation", "recordClientSubmission", "cancelIntent", "reconcile", "expireIntent",
]));

function userIdOf(op, args) {
  if (op === "reconcile" || op === "expireIntent") return null; // resolved from the intent row by the proxy
  const id = args?.userId;
  if (!/^-?\d{1,20}$/.test(String(id ?? ""))) throw new Error("COORDINATOR_USER_REQUIRED");
  return String(id);
}

/** Service-shaped proxy: coordinated operations go to the user's object, everything else runs locally. */
export function createCoordinatedService({ localService, stubFor, clock = () => Math.floor(Date.now() / 1000) }) {
  async function forward(userId, op, args) {
    const response = await stubFor(userId).fetch("https://copy-user/op", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, args }) });
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== "object") throw new Error("COORDINATOR_UNAVAILABLE");
    if (!body.ok) throw new Error(String(body.why || "COORDINATOR_FAILURE"));
    return body.result;
  }
  async function ownerOf(intentId) {
    const row = await localService.intentStore.get(intentId);
    if (!row) throw new Error("NOT_RECONCILABLE");
    return row.userId;
  }
  return {
    clock,
    intentStore: localService.intentStore,
    policyGate: localService.policyGate,
    createConfirmEachIntent: (args) => forward(userIdOf("createConfirmEachIntent", args), "createConfirmEachIntent", args),
    beginSecureSheetConfirmation: (args) => forward(userIdOf("beginSecureSheetConfirmation", args), "beginSecureSheetConfirmation", args),
    recordClientSubmission: (args) => forward(userIdOf("recordClientSubmission", args), "recordClientSubmission", args),
    cancelIntent: (args) => forward(userIdOf("cancelIntent", args), "cancelIntent", args),
    reconcile: async (intentId, options = {}) => forward(await ownerOf(intentId), "reconcile", { intentId, now: options.now }),
    expireIntent: async ({ intentId, now }) => forward(await ownerOf(intentId), "expireIntent", { intentId, now }),
    async expireStale({ now = clock(), limit = 200 } = {}) {
      const expired = [];
      for (const row of await localService.intentStore.listByStates(new Set(["AWAITING_USER_CONFIRMATION", "CLIENT_CONFIRMING"]), limit)) {
        const result = await forward(row.userId, "expireIntent", { intentId: row.id, now });
        if (result.expired) expired.push(row.id);
      }
      return Object.freeze({ expired });
    },
    async reconcilePending({ now = clock(), limit = 50 } = {}) {
      const results = [];
      for (const row of await localService.intentStore.listByStates(new Set(["SUBMITTED_PENDING_RECONCILIATION", "INCLUDED_AWAITING_SAFE"]), limit)) {
        try { results.push(await forward(row.userId, "reconcile", { intentId: row.id, now })); } catch (error) { results.push({ intentId: row.id, error: error.message }); }
      }
      return results;
    },
    getIntentForUser: (args) => localService.getIntentForUser(args),
    listUserIntents: (userId, limit) => localService.listUserIntents(userId, limit),
  };
}

/** The Durable Object. `buildLocalService(env)` is injected so this file stays free of the runtime wiring. */
export function defineCopyUserCoordinator(buildLocalService) {
  return class CopyUserCoordinator {
    constructor(state, env) { this.state = state; this.env = env; this.queue = Promise.resolve(); }
    async fetch(request) {
      let body;
      try { body = await request.json(); } catch { return Response.json({ ok: false, why: "INVALID_BODY" }, { status: 400 }); }
      if (!COORDINATED_OPERATIONS.has(body?.op)) return Response.json({ ok: false, why: "INVALID_OPERATION" }, { status: 400 });
      const run = async () => {
        const service = await buildLocalService(this.env);
        const args = body.args || {};
        if (body.op === "reconcile") return service.reconcile(args.intentId, { now: args.now ?? service.clock() });
        if (body.op === "expireIntent") return service.expireIntent({ intentId: args.intentId, now: args.now ?? service.clock() });
        return service[body.op](args);
      };
      const turn = this.queue.then(run, run);
      this.queue = turn.catch(() => {});
      try { return Response.json({ ok: true, result: await turn }); }
      catch (error) { return Response.json({ ok: false, why: String(error?.message || "COORDINATOR_FAILURE").slice(0, 80) }); }
    }
  };
}
