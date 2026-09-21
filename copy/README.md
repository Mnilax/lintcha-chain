# Lintcha copy-trading

Copy-trading is the separately labelled, opt-in trading mode inside the existing Lintcha product and `@lintchabot` identity. Lintcha Core remains read-only. Nothing in this directory is deployed merely by merging it.

`lintcha.com` presents copy-trading first and sends both its first navigation tab and primary call to action to the existing bot. The transaction sheet is served from `/copy/`, while `/api/copy/` is routed to the internally isolated trading Worker. The shared public domain does not merge the Core and trading service, database, secrets, audit or kill-switch boundaries.

## Boundary

`@lintchabot`'s Core webhook owns the bot token. Its minimal trading gateway recognizes only `/copy`, the exact `/start copy_site` acquisition payload, and the `copy.*`, `trade.*`, or `sell.*` callback namespaces, then forwards a signed envelope containing the Telegram user ID, private chat ID, update ID, locale, route, optional bounded `SITE` attribution and namespaced callback data. It never forwards the raw update, arbitrary message text or bot token. All other updates remain in Core.

Trading responses are restricted to text, namespaced callbacks and the exact configured `/copy/` Mini App route. The trading service has its own configuration, database namespace, audit log, RPC pool and kill switches.

The backend may store Telegram numeric identity, public wallet address, public labels, public chain/venue/quote/transaction metadata, transaction hashes, caps, state transitions and redacted audit events. Seed, mnemonic, private key, recovery export, secure-sheet vault, raw or signed transaction, bot token, webhook secret and wallet-provider secret are forbidden server-side. Wallet create/import/reveal/export remains client-only.

## Trading execution

Copy-trading supports notify-only and bounded auto-BUY. An automatic BUY needs an active, expiring, revocable delegation whose public scope matches the user, wallet, chain, router, selector, per-transaction cap, daily cap and slippage cap. The exact unsigned transaction is simulated by two independent read-only providers before a separately controlled delegated executor is called once. An uncertain submission keeps its spend reservation and goes to manual reconciliation; it is never retried automatically.

The trading Worker never receives the signer authorization key or wallet secret. It stores only public delegation metadata and an opaque Privy wallet reference. The production executor is a separate private Worker, disabled and globally paused by default, and unavailable without its own service binding and a second matching activation flag. The selected path and activation gates are documented in [`docs/AUTO_BUY_ARCHITECTURE.md`](docs/AUTO_BUY_ARCHITECTURE.md).

SELL remains manual. Its exact approval and freshly quoted trade are separate secure-sheet confirmations in the user's self-custody wallet. Auto-SELL is forbidden in policy and cannot use the delegated path.

## Packages

- `copy-service/` — HTTP surface, policy and confirm/manual plus auto-BUY intent lifecycles, public delegation records, a separate executor adapter, two-provider RPC/simulation, D1 and Durable Object adapters, audit log, outbox, reconciliation and credential-free fixtures.
- `auto-buy-contract/` — immutable Pons V2 BUY-only wrapper with on-chain user caps, expiry, provenance and pause checks; no SELL/arbitrary-call/upgrade/withdrawal path.
- `delegated-executor/` — private Privy executor Worker with an independent kill switch, cap, expiry, exact calldata validation and durable no-retry idempotency.
- `copy-gateway/` — the platform-only signed gateway also vendored into `bot/src/copy-gateway.js`.
- `copy-app/` — static `/copy/` Mini App with strict CSP and immutable `Lintcha — copy-trading` marking.
- `secure-sheet-crypto/` — client-only wallet and confirmation boundary; the confirm-each controller is copied into the static app.
- `trading/` — observer, matching, wallet-bound controls, bounded auto-BUY, manual SELL and readiness logic with self-contained evidence fixtures.
- `docs/` — threat model, runbook, device matrix, deployment checklist and owner-only activation actions.

## Local verification

Run `npm run test:copy` from the repository root. The RPC acceptance and local-fork replay tools remain opt-in: they require owner-provided production credentials or a loopback fork and never broadcast a transaction.
