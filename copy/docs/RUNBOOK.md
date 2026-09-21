# Lintcha copy-trading — runbook (pre-production draft)

Every step below is an owner action or needs owner-provisioned access. Nothing here has been executed.

## Deploy order (after the three production patches are merged)

1. **Trading Worker** (`lintcha-copy`): create D1 `lintcha-copy`, run `copy-service/src/schema.sql`, stage secrets `COPY_GATEWAY_SECRET`, `COPY_CONFIRMATION_SECRET` (64 hex), `COPY_ADMIN_SECRET`, `COPY_RPC_PRIMARY_URL`, `COPY_RPC_SECONDARY_URL`; set `COPY_TELEGRAM_BOT_ID` (numeric id of @lintchabot from `getMe`, public), `COPY_APP_ORIGIN=https://lintcha.com`, allowlists/caps from the verified venue manifest. Deploy with `COPY_GLOBAL_KILL_SWITCH=true`, `COPY_AUTO_BUY_ENABLED=false`, `COPY_DELEGATED_SUBMISSION_ENABLED=false`, and no executor binding. Verify `GET /api/copy/health` shows `globallyPaused: true`, `rpcReady: true`, both auto-BUY flags false and no URLs.

The website uses the exact Telegram payload `copy_site`. Each verified `/start copy_site` increments a first-party counter in Copy D1; no browser analytics, cookie, IP address or raw Telegram payload is stored. Read the aggregate through signed operator route `POST /api/copy/admin/referrals`: it returns `SITE` starts and unique Telegram users only, never identities.
2. **Mini App**: served by the same Worker's assets binding from `copy-app/`; verify `_headers` CSP on the live origin (`default-src 'none'`, `script-src 'self'`), and that `/copy/` opens from a private-chat button only.
3. **Core seam** (`lintcha-chain-api`): stage `COPY_GATEWAY_SECRET` (same value), add the `COPY_SERVICE` service binding (or `COPY_SERVICE_URL`), set `COPY_APP_ORIGIN`. Until all three are set, `/copy` is silence. Deploy Core; `npm run check-config:production` first.
4. **Credentialed RPC acceptance**: `node copy-service/tools/rpc-acceptance.mjs` with the two URLs in the environment of the runner only. The default profile requires a 10-block log agreement from both providers and a separate 2,000-block backfill from paid dRPC; broad dRPC results never replace two-provider transaction/simulation quorum. Keep the sanitized report as evidence. Not accepted → do not resume.
5. **Delegated executor**: after the provider and architecture review, bind the separately controlled executor, verify it holds no user funds or Lintcha bot/RPC secrets, exercise its own cap and kill switch, then enable both auto-BUY flags together. A one-flag deployment must fail closed.
6. **Resume for beta users only**: `admin/kill-switch` `GLOBAL RESUME` with a reason, then per-user pause remains the user's own control. Global resume is the beta activation and is a separate owner decision.

## Rollback

- Fastest: `admin/kill-switch` `GLOBAL PAUSE` (every open intent stops before the sheet opens; nothing on chain changes).
- Core side: remove `COPY_GATEWAY_SECRET`/`COPY_APP_ORIGIN` → seam disabled, `/copy` silent, no redeploy of Copy needed. Or `git revert --no-edit <seam commit>` and redeploy Core (forward-only rollback, per repository rules).
- Copy Worker: `wrangler versions` rollback to the previous version; D1 data is additive (no destructive migration in `schema.sql`).
- Never delete or rewrite `copy_audit_log`; the hash chain is the incident record.

## Incidents

| Symptom | First action | Then |
|---|---|---|
| Users report a stuck spinner on Copy buttons | check Core cron logs for `answerCallbackQuery` refusals | verify `COPY_SERVICE` binding health |
| `RECONCILIATION_REQUIRED` rows accumulate | do NOT resend anything; read both providers' view of each hash | classify: mismatch (user reported wrong hash), disagreement (provider), attempts exhausted (outage) |
| `DROPPED_OR_REPLACED` | ask the user for the replacement hash (same nonce); reconcile manually against both providers | keep reservation until resolved |
| Provider disagreement spikes | GLOBAL PAUSE; run acceptance runner; compare block hashes | resume only when both agree again |
| Delegated submission is uncertain | GLOBAL PAUSE if clustered; do not resend; keep the reservation and reconcile the intended hash or account activity manually | classify executor/provider fault before any resume |
| Suspected secret exposure | rotate `COPY_GATEWAY_SECRET` on both Workers together; rotate admin secret; RPC keys at the vendor | audit chain review |
| Telegram key rotation (third-party public key) | update `TELEGRAM_THIRD_PARTY_PUBLIC_KEYS` from core.telegram.org and redeploy | all sheets fail closed meanwhile |

## Routine

- Cron every minute: expiry sweep + reconciliation pass (Copy), outbox drain (Core). Both idempotent.
- Before merge and on every release candidate: run the Core and Copy suites. Keep `copy/copy-app/tools/sync-sheet.mjs` plus its test as the guard for the sheet controller, and compare `copy/copy-gateway/src/gateway.mjs` with `bot/src/copy-gateway.js` to prevent vendored gateway drift.
- Backups: D1 export of `lintcha-copy` before every schema change; restore drill before beta (checklist item).
