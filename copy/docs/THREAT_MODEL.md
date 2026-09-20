# Lintcha Copy — threat model (CP15 revision)

Assets: user funds (never held), user wallet key material (never seen), the Telegram bot token (Core only), the gateway/admin/confirmation secrets, RPC credentials, the intent/ledger/audit records, the public promise that Core is read-only.

## Trust boundaries

1. **Telegram → Core Worker** (`lintcha-chain-api`): webhook secret header, durable dedupe, per-user metering. Unchanged by Copy.
2. **Core → Copy** (signed gateway channel): HMAC-SHA256 over a minimal envelope (`schema, route, updateId, telegramUserId, privateChatId, locale, receivedAt[, callbackData]`), 30 s freshness, durable replay marks in D1. Raw update, message text and bot token never cross. Copy replies are validated by Core before delivery: text only, namespaced callbacks, buttons only to the exact Copy origin. A Copy failure is a fixed line, never a Core error.
3. **Mini App → Copy** (browser): Telegram third-party Ed25519 initData (bot id public, key published by Telegram), one-hour freshness, exact Origin on every POST, per-user rate window, owner binding on every intent route, confirmation token (HMAC, revision-bound, single-use).
4. **Copy → RPC**: two independent vendors, read-only method allowlist, common-block health, projection-based quorum, no URL in any error/log/audit.
5. **Sheet → wallet**: EIP-1193 only; the sheet cross-checks the server's review card against the unsigned transaction; the wallet asks again; only a public hash returns.
6. **Operator → Copy**: separate admin HMAC secret and request ids for kill switches and manual reconcile passes.

## Threats and controls

| Threat | Control | Evidence |
|---|---|---|
| Copy service obtains the bot token | config and runtime refuse any `BOT_TOKEN`/`TELEGRAM_BOT_TOKEN`/webhook-secret binding; Core never forwards it | `config` test, worker test |
| Forged or replayed gateway envelope | HMAC + freshness + D1 replay marks; non-minimal shape rejected | gateway/verifier tests |
| Forged Telegram identity in the Mini App | Ed25519 signature bound to bot id; tampered user id fails; stale data fails | init-data tests |
| CSRF / cross-origin calls to Copy API | Origin exact-match on POST; Sec-Fetch-Site check on GET; `frame-ancestors` limited to Telegram Web | http tests, `_headers` test |
| XSS in the sheet | `default-src 'none'`, `script-src 'self'`, no inline handlers, `textContent` only, no innerHTML | copy-app tests |
| Another user opens/drives someone's intent | owner check on read/begin/submit/cancel (403) | http negative test |
| Double click / replay of confirm | revision + single-use state transitions; DO serialization per user | service, worker concurrency test |
| Stale quote / stale simulation | quote expiry checked at creation; intent TTL ≤ quote expiry; sweep expires; sheet re-checks expiry before opening the wallet | service + sheet tests |
| Caps bypass by mismatched value | `value == amountIn` for native BUY; token-denominated SELL caps; daily reservation before signing | policy tests |
| Caps bypass by reporting a foreign hash | mismatch → manual, reservation kept | reconciliation test |
| Replaced/dropped transaction | drop deadline → manual, reservation kept; never re-broadcast (there is no broadcaster) | reconciliation test |
| Provider disagreement / one provider lying | quorum on projections, health block-hash agreement, simulation output+gas agreement, safe-block minimum across both | rpc/simulation tests |
| Reorg after inclusion | CONFIRMED only at/below both providers' `safe` | reconciliation test |
| Auto-SELL / auto-copy | `AUTO_SELL_FORBIDDEN` in policy; `COPY_AUTO_COPY_ENABLED=true` refuses to start; Telegram `sell.confirm.*` refused | policy, surface tests |
| Approval abuse | exact amount only, allowlisted spender only, token must equal quoted token, zero value | policy tests |
| Unknown venue/router/selector | fail-closed allowlists from the verified manifest; empty lists in every example config | policy tests |
| Secrets in logs/audit | audit rejects sensitive keys/values; RPC errors carry no URL; acceptance runner redacts; health endpoint exposes ids only | audit, runner, worker tests |
| Copy outage affecting Core | fixed unavailable line; cron drain failure swallowed; disabled seam = silence | seam test |
| Storage confusion with Core | separate D1 binding and DO class; schema comment forbids Core DB; `SESSIONS/TAPE/WATCH` never referenced by Copy | runtime |

## Residual risks (must be closed before beta)

- Telegram third-party public key: confirmed against tma.js platform docs; must be re-read from core.telegram.org by the owner (or the first credentialed run) before beta.
- Cloudflare runtime specifics (D1 batch semantics, DO eviction under load, Ed25519 in `crypto.subtle`, assets `run_worker_first`) are proven only against the node:sqlite shim and fakes.
- Wallet availability inside Telegram clients: an injected EIP-1193 provider is not typical; the bridge vendor (WalletConnect/Reown, a wallet's Telegram SDK) is an owner decision and will change the Mini App CSP (`connect-src`).
- Same-nonce replacement transactions cannot be tied to the reported hash; they land in manual review by design.
- Hash-only submission means the service trusts the wallet's reported hash only after two-provider reconciliation; a wallet that lies about the hash delays but cannot fake a CONFIRMED state.
