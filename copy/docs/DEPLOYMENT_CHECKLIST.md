# Lintcha copy-trading deployment checklist (CP16 revision)

Boxes are checked only when the whole line is complete. Items marked (local ✓) have local test evidence only, not runtime evidence.

Current local state: no wrapper or Worker from this auto-BUY revision has been deployed, no production Privy policy has been created or pinned, no real additional signer/delegation exists, and no real configure, pause, BUY, SELL or revocation transaction has been signed or broadcast. Local controller/service tests are not runtime acceptance.

Live bootstrap evidence (2026-09-21): PRs #40 and #41 merged with green CI; isolated D1 schema and SQLite
`CopyUserCoordinator` migration applied; gateway/confirmation/admin secret names present in Cloudflare; paused Copy
Worker created without a public route; Pons V2 router bytecode and recorded BUY/SELL transactions re-verified on
Robinhood Mainnet. The `/copy/*` and `/api/copy/*` routes are not activated, Core seam is disabled, caps are zero, and every
broadcast/auto/delegation flag remains false.

- [ ] Integration pull request reviewed and merged; Core and Copy regression suites green on the exact merge candidate.
- [ ] Owner approved the section-eight text amendment included in the integration pull request.
- [ ] Copy-first entry and Telegram CTA published on `https://lintcha.com/`; `/copy/` secure-sheet assets and `/api/copy/` trading API have their route precedence and `_headers` CSP verified live (local ✓ contract test).
- [ ] Existing Core webhook owns the Telegram token; Copy Worker environment proven token-free (runtime refuses token bindings: local ✓).
- [ ] `COPY_GATEWAY_SECRET` generated in the secret store and staged on both Workers; `COPY_CONFIRMATION_SECRET` (64 hex) and `COPY_ADMIN_SECRET` staged on Copy; rotation procedure in `copy/docs/RUNBOOK.md`.
- [ ] `COPY_TELEGRAM_BOT_ID` set to @lintchabot's numeric id (public); Telegram third-party public key re-verified against core.telegram.org.
- [ ] Copy D1 created as a separate binding; `schema.sql` applied; backup/export + restore drill done; retention decided for `copy_audit_log` (never truncated) and `copy_outbox`.
- [ ] `CopyUserCoordinator` Durable Object migration applied; per-user serialization observed under a real burst (local ✓ fake runtime).
- [ ] Independent Alchemy and dRPC endpoints pass `copy-service/tools/rpc-acceptance.mjs` (chain 4663, finality tags, common block, archive read, simulation quorum, 10-block two-provider log agreement, paid dRPC 2,000-block backfill, burst); sanitized report archived.
- [ ] Public RPC excluded from Copy quorum (config allows only the two named providers).
- [ ] Venue manifest pins exact chain/router/spender/selectors (Pons V2 curve BUY `0x59a87bc1` / SELL `0xd04c6983`, Uniswap V2 Router02 as evidenced) with bytecode/provenance; allowlists populated from it, not by hand.
- [ ] Caps non-zero only after owner review: per BUY, daily BUY spend, per-token SELL amount, slippage.
- [ ] Global kill switch starts paused; `admin/kill-switch` pause/resume audited (local ✓).
- [ ] Production Mini App bridge bundles the official Privy React SDK from the same origin (no remote script) and creates/uses a user-owned embedded Ethereum wallet bound to the authenticated Telegram user. The visible sheet is wired to the tested first-party bridge contract, but that official host bridge is not yet bundled or runtime-tested.
- [ ] Auto-BUY uses a dedicated Privy embedded wallet rather than silently extending an unrelated wallet. Preflight proves the selected Telegram-linked wallet is active and signer-empty; wallet creation/recovery and dedicated-wallet UX are verified on every target device.
- [ ] Activation UI wires the tested sequence without reordering it: prepare → user-signed wrapper `configure` → finalized client readback → exact finalized two-provider server `verify-configuration` → Privy `addSigners({address, signers: [{signerId, policyIds: [policyId]}]})` → one-time server activation. Activation rejects a nonce without its configuration-verification mark and defensively repeats the two-provider readback before recording active state (local ✓ contracts only).
- [ ] The client independently derives the configure calldata and exact user limits; both RPC providers and the server agree on one finalized readback before signer attachment (local ✓ controller, activation codec, nonce-gate and RPC readback contracts).
- [ ] Before `addSigners`, the private executor resolves `getByTelegramUserID`, requires exactly one matching active Privy embedded Ethereum wallet and proves its additional-signer set is empty; activation then re-reads the same wallet and requires exactly the one configured signer/policy (local ✓ verifier contract).
- [ ] Production Privy policy has a non-null, separately controlled owner quorum and exactly one BUY-only effective rule: chain 4663, deployed wrapper target, `eth_sendTransaction`, exact `buy(address,uint256,uint256)`/`0xa59ac6dd`, and the reviewed transaction-value ceiling. No wildcard or additional ALLOW rule exists.
- [ ] `PRIVY_POLICY_ID`, `PRIVY_POLICY_OWNER_ID` and the reviewed canonical `PRIVY_POLICY_CONTENT_SHA256` are pinned. A fresh policy read verifies all three at activation and before every submission; drift/unavailability fails closed (local ✓ policy-verifier contract only).
- [ ] Auto-BUY delegation scope proves exact Telegram owner, wallet, chain, wrapper, selector, per-transaction, daily-spend, slippage and expiry; user values cannot exceed system caps (local ✓ HTTP contract).
- [ ] Deactivation remains callable while auto-BUY flags are off: Copy first revokes the local delegation and the executor durably blocks the authorization reference before any new claim (local ✓ service/executor contracts).
- [ ] User-facing removal then obtains a user-signed wrapper `setUserPaused(true)` and finalized embedded-wallet-provider `paused == true`; immediately before `removeSigners({address})`, both a fresh bridge read and `/delegations/removal-readiness` server proof must show exactly the sole Lintcha signer, sole pinned policy and matching authorization epoch. Unknown/stacked/mismatched state goes to manual recovery. The server finally proves that signer absent from the same Telegram-linked wallet (local ✓ controller/verifier contracts; independent two-RPC runtime acceptance remains separate).
- [ ] Interrupted deactivation or post-signer activation failure survives reload as a public `PENDING_REMOVAL` item with no authorization reference exposed; the original wallet can retry cleanup, both the visible sheet and server reject new activation while the row is pending, and only successful server revocation proof removes the stale record (local ✓ service/HTTP/sheet contract).
- [ ] Secure-sheet and auto-BUY setup/removal flows independently reviewed; device QA matrix executed (`copy/docs/DEVICE_QA_MATRIX.md`).
- [ ] Executor binding holds no user funds, has its own caps and kill switch, returns only a public transaction hash, and an ambiguous response is proven not to retry (local ✓ adapter contract).
- [ ] Manual SELL review shows module label, chain, token, amount, minimum output, slippage, target, selector, simulation block and expiry (local ✓).
- [ ] SELL approval exact and separate; trade freshly quoted and simulated with a live allowance read (local ✓).
- [ ] Duplicate/replay/concurrency tests pass against the real D1 + DO runtime (`wrangler dev --remote` or staging).
- [ ] Reconciliation requires two-provider agreement and safe-block inclusion; no path automatically repeats a delegated submission (local ✓).
- [ ] `COPY_AUTO_BUY_ENABLED` and `COPY_DELEGATED_SUBMISSION_ENABLED` remain false until every preceding gate passes; generic `COPY_BROADCAST_ENABLED` stays false; auto-SELL has no flag or path.
- [ ] Rate limits, audit monitoring, alerting, support and incident rollback exercised (`copy/docs/RUNBOOK.md`).
- [ ] Core seam staged disabled first; `/copy` silent in production confirmed; then enabled while trading remains globally paused.
- [ ] Independent wrapper review completed; immutable constructor inputs and deployed bytecode verified, then address pinned in Copy, executor and Privy policy.
- [ ] Credentialed runtime acceptance proves Cloudflare service bindings, D1/DO concurrency, two-RPC finality/readback, fresh Privy policy checks and cleanup routes while submission flags are both on and off.
- [ ] Deployment approved separately. Creating the production policy, attaching a real signer, funding a wallet, signing any configure/pause/trade, or enabling broadcast each requires an owner-controlled step.
- [ ] One owner-controlled dust-wallet activation, BUY, local shutdown, on-chain pause, `removeSigners` and server revocation-proof test passes on the device matrix while public trading remains paused; public resume approved separately.
