# Lintcha Copy

Lintcha Copy is the separately labelled, opt-in trading module inside the existing `@lintchabot` identity. Lintcha Core remains read-only. Nothing in this directory is deployed merely by merging it.

`lintcha.com` presents Copy first and sends both its first navigation tab and primary call to action to the existing bot. The transaction sheet remains on the isolated `copy.lintcha.com` origin so public positioning does not collapse the Core/Copy security boundary.

## Boundary

`@lintchabot`'s Core webhook owns the bot token. Its minimal Copy gateway recognizes only `/copy`, the exact `/start copy_site` acquisition payload, and the `copy.*`, `trade.*`, or `sell.*` callback namespaces, then forwards a signed envelope containing the Telegram user ID, private chat ID, update ID, locale, route, optional bounded `SITE` attribution and namespaced callback data. It never forwards the raw update, arbitrary message text or bot token. All other updates remain in Core.

Copy responses are restricted to text, namespaced callbacks and the exact configured `/copy/` Mini App origin. The Copy service has its own configuration, database namespace, audit log, RPC pool and kill switches.

The backend may store Telegram numeric identity, public wallet address, public labels, public chain/venue/quote/transaction metadata, transaction hashes, caps, state transitions and redacted audit events. Seed, mnemonic, private key, recovery export, secure-sheet vault, raw or signed transaction, bot token, webhook secret and wallet-provider secret are forbidden server-side. Wallet create/import/reveal/export remains client-only.

## Copy execution

Copy supports notify-only and bounded auto-BUY. An automatic BUY needs an active, expiring, revocable delegation whose public scope matches the user, wallet, chain, router, selector, per-transaction cap, daily cap and slippage cap. The exact unsigned transaction is simulated by two independent read-only providers before a separately controlled delegated executor is called once. An uncertain submission keeps its spend reservation and goes to manual reconciliation; it is never retried automatically.

The Copy Worker never receives the session key or wallet secret. It stores only public delegation metadata and an opaque authorization reference. The production executor adapter is disabled by default and unavailable without its own binding and a second matching activation flag.

SELL remains manual. Its exact approval and freshly quoted trade are separate secure-sheet confirmations in the user's self-custody wallet. Auto-SELL is forbidden in policy and cannot use the delegated path.

## Packages

- `copy-service/` — HTTP surface, policy and confirm/manual plus auto-BUY intent lifecycles, public delegation records, a separate executor adapter, two-provider RPC/simulation, D1 and Durable Object adapters, audit log, outbox, reconciliation and credential-free fixtures.
- `copy-gateway/` — the platform-only signed gateway also vendored into `bot/src/copy-gateway.js`.
- `copy-app/` — static `/copy/` Mini App with strict CSP and immutable `Lintcha Copy — trading` marking.
- `secure-sheet-crypto/src/confirm-each.mjs` — the single source for the confirm-each sheet controller copied into the static app.
- `docs/` — threat model, runbook, device matrix, deployment checklist and owner-only activation actions.

## Local verification

Run `npm run test:copy` from the repository root. The RPC acceptance and local-fork replay tools remain opt-in: they require owner-provided production credentials or a loopback fork and never broadcast a transaction.
