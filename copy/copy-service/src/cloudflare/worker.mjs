import { buildRuntime } from "./runtime.mjs";
import { defineCopyUserCoordinator } from "./coordinator.mjs";

/**
 * Lintcha Copy Worker. Separate from `lintcha-chain` (site) and `lintcha-chain-api` (Core bot): its own name,
 * origin, D1 database, Durable Object namespace and secrets. It serves the Mini App (assets binding) and the
 * `/copy/api/*` routes, and runs the expiry/reconciliation sweep on its own cron. It has no bot token, no
 * signer and no broadcaster.
 */
export const CopyUserCoordinator = defineCopyUserCoordinator(async (env) => (await buildRuntime(env, { coordinated: false })).localService);

export default {
  async fetch(request, env) {
    let runtime;
    try { runtime = await buildRuntime(env); }
    catch (error) {
      // A misconfigured service answers nothing but a fail-closed code; it never falls back to a Core binding.
      return Response.json({ ok: false, why: /REQUIRED|MUST_NOT/.test(error.message) ? error.message : "misconfigured" }, { status: 503, headers: { "cache-control": "no-store" } });
    }
    const url = new URL(request.url);
    const apiPrefix = `${runtime.config.appPath.replace(/\/$/, "")}/api/`;
    if (url.pathname.startsWith(apiPrefix)) return runtime.handler(request);
    // Static Mini App files are served by the assets binding before this handler; anything else is not ours.
    return new Response(null, { status: 404 });
  },

  async scheduled(event, env, ctx) {
    const work = (async () => {
      const runtime = await buildRuntime(env);
      await runtime.service.expireStale();
      await runtime.service.reconcilePending();
    })();
    ctx.waitUntil(work.catch(() => {}));
  },
};
