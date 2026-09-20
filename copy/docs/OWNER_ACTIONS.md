# Actions that require owner access, money or an irreversible decision (CP15 revision)

This is the complete external action list after local work. Nothing here has been done.

1. **Repository review**: review and merge the `codex/lintcha-copy` integration pull request. A merge adds documentation, a disabled Core seam and isolated Copy code; it does not deploy or activate Copy.
2. **Wording**: confirm the section-eight `/start` and NEVER-list amendment plus the README/i18n Core–Copy boundary wording in the pull request before merge.
3. **Copy origin**: choose `https://copy.lintcha.com/` (preferred) or `https://lintcha.com/copy/` (weaker isolation, shares Core's origin and would force telegram-frame CSP onto Core); create DNS/TLS/Worker route.
4. **Copy database and secrets**: create D1 `lintcha-copy` and the `CopyUserCoordinator` DO; generate `COPY_GATEWAY_SECRET` (≥32 bytes), `COPY_CONFIRMATION_SECRET` (64 hex), optional `COPY_ADMIN_SECRET`, in the secret store of each Worker. Never in chat, never in files.
5. **Public bot id**: read @lintchabot's numeric id from `getMe` and set `COPY_TELEGRAM_BOT_ID` (public value, not the token). Re-verify Telegram's third-party public key on core.telegram.org.
6. **RPC**: open Alchemy and QuickNode accounts, confirm Robinhood mainnet production/contract coverage, pay the plans, place both URLs in the Copy secret store, run `copy-service/tools/rpc-acceptance.mjs` from a machine that has them in its environment.
7. **Venue manifest**: confirm the exact router/spender/selector set for beta (Pons V2 curve and/or Uniswap V2 Router02) and the caps; allowlists are empty until then.
8. **Wallet bridge**: decide how a wallet reaches the sheet inside Telegram clients (injected EIP-1193 only, WalletConnect/Reown project, or a wallet's Telegram SDK). This is a vendor/paid decision; the current Mini App shows an explicit "no wallet in this client" state and picks nothing.
9. **Security review**: nominate a reviewer for the threat model, the seam, the sheet flow and the runbook; run the device QA matrix.
10. **Deployment**, then **closed beta** (global resume for named users), as two separate decisions with the checklist evidence.
11. Only for a future auto-copy experiment: a separate decision on one real EIP-7702 delegation after its own audit. Basic and the confirm-each beta do not need it.

Never send bot token, RPC URLs, API keys, seed, mnemonic or private key in Telegram or this workspace. No wallet is funded until its own gate is approved.
