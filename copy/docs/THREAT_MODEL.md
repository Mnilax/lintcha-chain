# Lintcha Copy — threat model (CP15 revision)

Assets: user funds (never held), user wallet key material (never seen), the Telegram bot token (Core only), the gateway/admin/confirmation secrets, RPC credentials, the intent/ledger/audit records, the public promise that Core is read-only.

Scope note: these controls are implemented/tested locally unless explicitly described as a runtime gate. No wrapper or auto-BUY Worker revision has been deployed, no real Privy signer/delegation exists, and no real transaction has been signed or broadcast.

## Trust boundaries

1. **Telegram → Core Worker** (`lintcha-chain-api`): webhook secret header, durable dedupe, per-user metering. Unchanged by Copy.
2. **Core → Copy** (signed gateway channel): HMAC-SHA256 over a minimal envelope (`schema, route, updateId, telegramUserId, privateChatId, locale, receivedAt[, callbackData]`), 30 s freshness, durable replay marks in D1. Raw update, message text and bot token never cross. Copy replies are validated by Core before delivery: text only, namespaced callbacks, buttons only to the exact Copy origin. A Copy failure is a fixed line, never a Core error.
3. **Mini App → Copy** (browser): Telegram third-party Ed25519 initData (bot id public, key published by Telegram), one-hour freshness, exact Origin on every POST, per-user rate window, owner binding on every intent/delegation route, confirmation token (HMAC, revision-bound, single-use) and a short-lived, single-use activation token bound to Telegram user, wallet and exact limits.
4. **Copy → RPC**: two independent vendors, read-only method allowlist, common-block health, projection-based quorum, no URL in any error/log/audit.
5. **Copy → delegated executor** (auto-BUY only, optional): a separate service binding receives public transaction data plus an opaque Privy wallet reference. It independently resolves the Telegram user's linked Privy wallet, signer and exact mutable-policy content. Copy never receives the authorization private key, user key, signature or raw signed transaction. Submission flags are false by default; local shutdown and executor authorization blocking are separate cleanup paths.
6. **Sheet → user wallet / Privy**: the sheet registers only a public address. Auto-BUY setup requires a user-signed wrapper configuration, finalized exact readback and explicit `addSigners`; removal requires local shutdown, a user-signed on-chain pause, finalized pause readback and `removeSigners`. Manual SELL always remains an explicit wallet-confirmed path.
7. **Operator → Copy**: separate admin HMAC secret and request ids for kill switches and manual reconcile passes.

## Threats and controls

| Threat | Control | Evidence |
|---|---|---|
| Copy service obtains the bot token | config and runtime refuse any `BOT_TOKEN`/`TELEGRAM_BOT_TOKEN`/webhook-secret binding; Core never forwards it | `config` test, worker test |
| Forged or replayed gateway envelope | HMAC + freshness + D1 replay marks; non-minimal shape rejected | gateway/verifier tests |
| Forged Telegram identity in the Mini App | Ed25519 signature bound to bot id; tampered user id fails; stale data fails | init-data tests |
| A public wallet from another Telegram/Privy tenant is activated | executor resolves `getByTelegramUserID`, requires exactly one matching linked Privy embedded Ethereum account, then re-reads the same wallet id/address | executor verifier tests |
| Existing or unknown signer survives into a new activation | preflight requires the Telegram-linked wallet's additional-signer set to be empty; activation later requires exactly the configured signer and its one policy | executor verifier tests |
| `removeSigners` removes authority not owned by Lintcha | immediately before removal both the first-party bridge and a fresh Telegram-bound server readiness proof must report exactly one signer, matching the configured Lintcha signer, sole policy and authorization epoch; unknown, missing, stacked or mismatched state stops for manual recovery | onboarding + verifier tests |
| CSRF / cross-origin calls to Copy API | Origin exact-match on POST; Sec-Fetch-Site check on GET; `frame-ancestors` limited to Telegram Web | http tests, `_headers` test |
| XSS in the sheet | `default-src 'none'`, `script-src 'self'`, no inline handlers, `textContent` only, no innerHTML | copy-app tests |
| Another user opens/drives someone's intent | owner check on read/begin/submit/cancel (403) | http negative test |
| Double click / replay of confirm | revision + single-use state transitions; DO serialization per user | service, worker concurrency test |
| Stale quote / stale simulation | quote expiry checked at creation; intent TTL ≤ quote expiry; sweep expires; sheet re-checks expiry before opening the wallet | service + sheet tests |
| Caps bypass by mismatched value | `value == amountIn` for native BUY; token-denominated SELL caps; daily reservation before signing | policy tests |
| Browser/server substitutes broader wrapper limits | client derives configure calldata locally; activation token binds exact limits; two providers and the server must read the same exact limits at a finalized block | onboarding + delegation-activation tests |
| Signer is attached before wrapper limits are final | client orders finalized embedded-provider readback and a nonce-bound server two-RPC finalized verification before `addSigners`; activation rejects an unverified nonce and defensively repeats the server readback before recording active state | onboarding + service tests |
| Activation fails after signer attachment | after server signer verification, Copy persists a revoked pending-removal row and the controller runs the full deactivation path; unfinished cleanup remains recoverable after reload and is never reported active. Persistence failure requires manual recovery | onboarding + service tests |
| Mutable Privy policy is widened under the same id | executor fetches the policy at activation and every submission; exact owner and canonical security-content SHA are pinned; extra rules/conditions, hash drift or read failure deny execution | policy-verifier + executor tests |
| Caps bypass by reporting a foreign hash | mismatch → manual, reservation kept | reconciliation test |
| Replaced/dropped transaction | drop deadline → manual, reservation kept; never re-broadcast (there is no broadcaster) | reconciliation test |
| Provider disagreement / one provider lying | quorum on projections, health block-hash agreement, simulation output+gas agreement, safe-block minimum across both | rpc/simulation tests |
| Reorg after inclusion | CONFIRMED only at/below both providers' `safe` | reconciliation test |
| Auto-SELL or unbounded auto-copy | delegated path accepts BUY trade only; active expiring delegation must match wallet/chain/router/selector/caps/slippage; Telegram cannot create it; `AUTO_SELL_FORBIDDEN` remains fail-closed | policy, delegation and surface tests |
| Ambiguous delegated submission | intent moves to manual reconciliation, reservation stays charged and no automatic retry occurs | auto-BUY service test |
| Approval abuse | exact amount only, allowlisted spender only, token must equal quoted token, zero value | policy tests |
| Unknown venue/router/selector | fail-closed allowlists from the verified manifest; empty lists in every example config | policy tests |
| Secrets in logs/audit | audit rejects sensitive keys/values; RPC errors carry no URL; acceptance runner redacts; health endpoint exposes ids only | audit, runner, worker tests |
| Copy outage affecting Core | fixed unavailable line; cron drain failure swallowed; disabled seam = silence | seam test |
| Storage confusion with Core | separate D1 binding and DO class; schema comment forbids Core DB; `SESSIONS/TAPE/WATCH` never referenced by Copy | runtime |
| Disabling auto-BUY flags also disables emergency cleanup | Copy revokes locally before external cleanup; executor authorization block is durable and independent of submission enable/pause flags; cleanup routes remain callable while submission is off | service, HTTP and executor tests |
| UI reports deactivation while signer remains usable | local shutdown, executor block, finalized on-chain pause, `removeSigners` and fresh server revocation proof are distinct states; any unfinished stage is reported pending | onboarding + revocation-verifier tests |
| Reload hides incomplete removal | revoked delegation remains a server-side `PENDING_REMOVAL`; `/me` exposes only wallet/wrapper/chain status, the sheet restores retry for the original wallet, both UI and service reject reactivation while pending, and final server proof deletes the record | service + HTTP + sheet tests |

## Residual risks (must be closed before public resume)

- Telegram third-party public key: confirmed against tma.js platform docs; must be re-read from core.telegram.org by the owner (or the first credentialed run) before public resume.
- Cloudflare runtime specifics (D1 batch semantics, DO eviction under load, Ed25519 in `crypto.subtle`, assets `run_worker_first`) are proven only against the node:sqlite shim and fakes.
- The visible Mini App, provider-neutral auto-BUY controller and same-origin API are wired to a strict first-party bridge contract, but the official Privy React host bridge is not bundled. Consent, wallet creation/recovery and `addSigners`/`removeSigners` behavior remain unverified on real Telegram devices.
- Auto-BUY is intended for a dedicated Privy embedded wallet. Local preflight proves an empty additional-signer set, but it does not by itself prove that an existing wallet has no unrelated assets or history; production onboarding must create/select the dedicated wallet explicitly and device-test recovery.
- The selected direction is a user-owned Privy embedded wallet with a removable additional TEE signer restricted to the immutable BUY-only wrapper. Real Privy credentials, the separately owned exact policy and hash pin, real revocation behavior and server SDK response shapes remain unverified until the owner-controlled acceptance run.
- A Privy policy is mutable and its API does not supply an immutable content revision. The local canonical SHA check detects drift but is not a Privy-signed immutability proof; the independently reviewed deployed wrapper remains the harder call/limit boundary.
- Contract deployment/bytecode verification, two-provider credentialed finality/readback, Cloudflare binding behavior and the complete activation/removal runtime are still owner gates.
- Same-nonce replacement transactions cannot be tied to the reported hash; they land in manual review by design.
- Hash-only submission means the service trusts the wallet's reported hash only after two-provider reconciliation; a wallet that lies about the hash delays but cannot fake a CONFIRMED state.
