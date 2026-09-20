# Lintcha Copy service

An isolated, fail-closed service for the opt-in trading module inside the existing `@lintchabot` identity. It has no bot token, no signer and no broadcaster.

## Layout

- `src/config.mjs` — environment → frozen config; refuses bot-token bindings, server broadcast and auto-copy flags.
- `src/policy.mjs` — kill switches, spend ledger contract, allowlists, caps, exact-approval decoding.
- `src/rpc-pool.mjs`, `src/simulation.mjs` — two-vendor read-only pool: health (chain, finality tags, head skew, common block hash, conservative safe/finalized), failover reads, projection-based quorum, simulation with revert classification.
- `src/service.mjs` — confirm-each intent lifecycle: create → AWAITING_USER_CONFIRMATION → CLIENT_CONFIRMING → SUBMITTED_PENDING_RECONCILIATION → (INCLUDED_AWAITING_SAFE) → CONFIRMED | FAILED; CANCELLED/EXPIRED; RECONCILIATION_REQUIRED/DROPPED_OR_REPLACED for humans. SELL trade requires a live allowance.
- `src/gateway-auth.mjs` — HMAC verification of the Core gateway envelope with a durable replay store.
- `src/telegram-init-data.mjs` — Ed25519 third-party validation of Mini App init data (no bot token).
- `src/telegram-surface.mjs` — what `/copy` and the namespaced callbacks say; review lines for the outbox.
- `src/stores.mjs` — memory user/wallet/outbox stores (contracts shared with D1).
- `src/http.mjs` — the whole HTTP surface (`/copy/api/*`), three authentications, stable error codes.
- `src/cloudflare/` — D1 adapters, per-user Durable Object coordinator, runtime wiring, Worker entry.
- `src/schema.sql` — dedicated D1 schema, idempotent; never for the Core database.
- `tools/rpc-acceptance.mjs` — credentialed acceptance, URLs/keys never in output. `tools/fork-replay.mjs` — local fork replay of fixtures, skipped without a local fork.
- `test/` — unit, HTTP end-to-end, D1 (node:sqlite shim), Worker/DO, recorded Pons V2 mainnet fixtures, acceptance-runner sanitization.

## Run

```
node --test test/*.test.mjs          # 34 tests
node tools/fork-replay.mjs           # SKIPPED unless COPY_FORK_RPC_URL is a local fork
node tools/rpc-acceptance.mjs        # needs COPY_RPC_PRIMARY_URL / COPY_RPC_SECONDARY_URL in the environment
```

`wrangler.copy.example.toml` is the Worker shape with placeholders only. Nothing here is deployed.
