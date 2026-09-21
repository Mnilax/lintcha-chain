# Lintcha Copy deployment checklist (CP15 revision)

Boxes are checked only when the whole line is complete. Items marked (local ✓) have local test evidence only, not runtime evidence.

Live bootstrap evidence (2026-09-21): PRs #40 and #41 merged with green CI; isolated D1 schema and SQLite
`CopyUserCoordinator` migration applied; gateway/confirmation/admin secret names present in Cloudflare; paused Copy
Worker created without a public route; Pons V2 router bytecode and recorded BUY/SELL transactions re-verified on
Robinhood Mainnet. `copy.lintcha.com` still has no DNS record, Core seam is disabled, caps are zero, and every
broadcast/auto/delegation flag remains false.

- [ ] Integration pull request reviewed and merged; Core and Copy regression suites green on the exact merge candidate.
- [ ] Owner approved the section-eight text amendment included in the integration pull request.
- [ ] Copy-first entry and Telegram CTA published on `https://lintcha.com/`; isolated secure-sheet origin `https://copy.lintcha.com/` has DNS/TLS and its `_headers` CSP verified live (local ✓ contract test).
- [ ] Existing Core webhook owns the Telegram token; Copy Worker environment proven token-free (runtime refuses token bindings: local ✓).
- [ ] `COPY_GATEWAY_SECRET` generated in the secret store and staged on both Workers; `COPY_CONFIRMATION_SECRET` (64 hex) and `COPY_ADMIN_SECRET` staged on Copy; rotation procedure in `copy/docs/RUNBOOK.md`.
- [ ] `COPY_TELEGRAM_BOT_ID` set to @lintchabot's numeric id (public); Telegram third-party public key re-verified against core.telegram.org.
- [ ] Copy D1 created as a separate binding; `schema.sql` applied; backup/export + restore drill done; retention decided for `copy_audit_log` (never truncated) and `copy_outbox`.
- [ ] `CopyUserCoordinator` Durable Object migration applied; per-user serialization observed under a real burst (local ✓ fake runtime).
- [ ] Alchemy and QuickNode endpoints pass `copy-service/tools/rpc-acceptance.mjs` (chain 4663, finality tags, common block, archive read, simulation quorum, log range, burst); sanitized report archived.
- [ ] Public RPC excluded from Copy quorum (config allows only the two named providers).
- [ ] Venue manifest pins exact chain/router/spender/selectors (Pons V2 curve BUY `0x59a87bc1` / SELL `0xd04c6983`, Uniswap V2 Router02 as evidenced) with bytecode/provenance; allowlists populated from it, not by hand.
- [ ] Caps non-zero only after owner review: per BUY, daily BUY spend, per-token SELL amount, slippage.
- [ ] Global kill switch starts paused; `admin/kill-switch` pause/resume audited (local ✓).
- [ ] Wallet bridge decision made (injected EIP-1193 only vs WalletConnect/Reown vs wallet Telegram SDK); Mini App CSP adjusted accordingly and re-reviewed.
- [ ] Secure-sheet flow independently reviewed; device QA matrix executed (`copy/docs/DEVICE_QA_MATRIX.md`).
- [ ] Auto-BUY delegation architecture and executor provider selected after capability/security review; exact wallet, chain, router, selector, per-transaction, daily-spend, slippage and expiry scope proven.
- [ ] Executor binding holds no user funds, has its own caps and kill switch, returns only a public transaction hash, and an ambiguous response is proven not to retry (local ✓ adapter contract).
- [ ] Manual SELL review shows module label, chain, token, amount, minimum output, slippage, target, selector, simulation block and expiry (local ✓).
- [ ] SELL approval exact and separate; trade freshly quoted and simulated with a live allowance read (local ✓).
- [ ] Duplicate/replay/concurrency tests pass against the real D1 + DO runtime (`wrangler dev --remote` or staging).
- [ ] Reconciliation requires two-provider agreement and safe-block inclusion; no path automatically repeats a delegated submission (local ✓).
- [ ] `COPY_AUTO_BUY_ENABLED` and `COPY_DELEGATED_SUBMISSION_ENABLED` remain false until every preceding gate passes; generic `COPY_BROADCAST_ENABLED` stays false; auto-SELL has no flag or path.
- [ ] Rate limits, audit monitoring, alerting, support and incident rollback exercised (`copy/docs/RUNBOOK.md`).
- [ ] Core seam staged disabled first; `/copy` silent in production confirmed; then enabled for the beta chat only.
- [ ] Deployment approved separately.
- [ ] Closed beta approved separately after deployment evidence.
