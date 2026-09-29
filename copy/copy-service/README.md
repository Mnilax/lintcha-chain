# Lintcha Copy service

An isolated, fail-closed service for the opt-in trading module inside the existing `@lintchabot` identity. It has no bot token, user key material, wallet signature or signed transaction. Optional auto-BUY submission crosses only a dedicated executor service binding and is disabled by default. Automatic execution is BUY-only; SELL always uses the explicit secure-sheet/manual-wallet path.

This auto-BUY activation/removal revision is not deployed; the earlier paused Copy bootstrap is not evidence that these changes are live. No real Privy signer/delegation exists, and no real configure, pause, BUY, SELL or revocation transaction has been signed or broadcast.

## Layout

- `src/config.mjs` — environment → frozen config; refuses bot-token bindings and generic server broadcast; auto-BUY requires two matching opt-in flags.
- `src/policy.mjs` — kill switches, spend ledger contract, allowlists, caps, exact-approval decoding.
- `src/rpc-pool.mjs`, `src/simulation.mjs` — two-vendor read-only pool: health (chain, finality tags, head skew, common block hash, conservative safe/finalized), failover reads, projection-based quorum, simulation with revert classification.
- `src/service.mjs` — one-shot auto-BUY plus explicit secure-sheet lifecycles. Both converge on SUBMITTED_PENDING_RECONCILIATION → (INCLUDED_AWAITING_SAFE) → CONFIRMED | FAILED, with RECONCILIATION_REQUIRED/DROPPED_OR_REPLACED for humans and no blind retry. SELL requires a live allowance and explicit wallet confirmation.
- `src/delegation-activation.mjs` — bounded activation limits, exact wrapper `configure`/pause calldata, short-lived single-use activation challenge contract, and finalized two-provider on-chain limit readback.
- `src/delegated-execution.mjs` — validates public scoped delegation metadata and isolates the optional executor service binding; accepts no key, signature or signed transaction.
- `src/gateway-auth.mjs` — HMAC verification of the Core gateway envelope with a durable replay store.
- `src/telegram-init-data.mjs` — Ed25519 third-party validation of Mini App init data (no bot token).
- `src/telegram-surface.mjs` — what `/copy` and the namespaced callbacks say; review lines for the outbox.
- `src/stores.mjs` — memory user/wallet/outbox stores (contracts shared with D1).
- `src/http.mjs` — the whole HTTP surface (`/api/copy/*`), three authentications, stable error codes.
- `src/cloudflare/` — D1 adapters, per-user Durable Object coordinator, runtime wiring, Worker entry.
- `src/schema.sql` — dedicated D1 schema, idempotent; never for the Core database.
- `tools/rpc-acceptance.mjs` — credentialed acceptance, URLs/keys never in output. `tools/fork-replay.mjs` — local fork replay of fixtures, skipped without a local fork.
- `test/` — unit, HTTP end-to-end, D1 (node:sqlite shim), Worker/DO, recorded Pons V2 mainnet fixtures, acceptance-runner sanitization.

## Run

```
node --test test/*.test.mjs
node tools/fork-replay.mjs           # SKIPPED unless COPY_FORK_RPC_URL is a local fork
node tools/rpc-acceptance.mjs        # needs COPY_RPC_PRIMARY_URL / COPY_RPC_SECONDARY_URL in the environment
```

`wrangler.copy.example.toml` is the Worker shape with placeholders only. This auto-BUY activation/removal revision is not deployed.

## Auto-BUY activation and removal

The local API implements a two-phase activation boundary:

1. `POST /api/copy/delegations/prepare` authenticates Telegram init data, verifies that the public wallet is registered to that user, validates requested limits against system ceilings, and asks the executor to prove that the same Telegram user's active Privy embedded wallet has no existing additional signer. It then returns a user/wallet/limits-bound activation token plus the exact unsigned wrapper `configure` transaction. Production onboarding must select/create this as a dedicated Privy wallet rather than silently repurpose an unrelated wallet.
2. The client controller requires a user wallet signature and finalized embedded-provider readback, then calls `POST /api/copy/delegations/verify-configuration`. Copy performs an exact finalized two-RPC wrapper readback and marks that activation nonce verified before the client may call Privy `addSigners`.
3. Activation rejects a nonce without that configuration-verification mark and consumes the activation challenge once. The private executor proves the same Telegram user's Privy embedded wallet, exact signer and exact pinned mutable-policy owner/content; Copy defensively repeats the finalized two-RPC wrapper readback before storing an active delegation.

Every delegated submission repeats a fresh executor read and verification of the mutable policy. The policy id alone is not sufficient: production pins a non-null policy owner and the canonical SHA-256 of the exact chain/wrapper/function/value-cap policy and rejects drift or broader rules. The full Telegram-wallet/signer proof remains the activation boundary; subsequent submissions also require the active local delegation, matching opaque wallet reference and no durable executor block.

Deactivation is intentionally available even when auto-BUY submission flags are off. Copy first revokes its local active record and requests a durable executor authorization block. The user-facing controller then obtains a user-signed on-chain pause and finalized embedded-wallet-provider readback with `paused == true`. Immediately before Privy `removeSigners({address})`, both the bridge and `POST /api/copy/delegations/removal-readiness` must freshly prove exactly the sole configured Lintcha signer, its sole policy and the matching authorization epoch; ambiguity stops for manual recovery. `POST /api/copy/delegations/verify-revocation` finally accepts completion only after a fresh Telegram-bound server read proves the signer is absent. Partial cleanup stays locally inactive and is reported as pending; independent two-RPC runtime acceptance remains a deployment gate.

A revoked row remains as `PENDING_REMOVAL` until that final proof. This includes a final activation failure after signer attachment: the controller calls the token-bound `recover-removal` route so Copy can verify the signer, persist and block that cleanup epoch before running the full deactivation flow. `/me` returns only public wallet/wrapper/chain status, the visible sheet restores cleanup after reload for the original wallet, and a successful proof deletes the stale row. The opaque authorization reference never enters that browser response. Both the visible sheet and service reject new activation while the row is pending.

## Mini App integration status

`copy-app/copy/auto-buy-onboarding.mjs` contains the tested provider-neutral orchestration. The visible sheet instantiates it only when a same-origin first-party bridge exposes a Telegram-identity-matched Privy embedded wallet, exact public setup ids and `addSigners`/`removeSigners`; it also wires bounded limit inputs, wallet transaction submission, finalized readback and partial-cleanup states.

The official Privy React host bridge itself is not bundled or runtime-tested. Wallet creation/recovery, real consent/removal behavior and device compatibility still require production bridge work and QA; the wired local UI must not be presented as production-operational.

Independent wrapper review/deployment, production policy creation and hash pinning, bridge completion, real Privy and two-RPC runtime acceptance, a paused dust-wallet exercise, deployment and public resume remain owner gates.
