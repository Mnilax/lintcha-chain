# Lintcha Copy

Lintcha Copy is the separately labelled, opt-in trading module inside the existing `@lintchabot` identity. Lintcha Core remains read-only. Nothing in this directory is deployed merely by merging it.

## Boundary

`@lintchabot`'s Core webhook owns the bot token. Its minimal Copy gateway recognizes only `/copy` and the `copy.*`, `trade.*`, or `sell.*` callback namespaces, then forwards a signed envelope containing the Telegram user ID, private chat ID, update ID, locale, route and namespaced callback data. It never forwards the raw update, arbitrary message text or bot token. All other updates remain in Core.

Copy responses are restricted to text, namespaced callbacks and the exact configured `/copy/` Mini App origin. The Copy service has its own configuration, database namespace, audit log, RPC pool and kill switches.

The backend may store Telegram numeric identity, public wallet address, public labels, public chain/venue/quote/transaction metadata, transaction hashes, caps, state transitions and redacted audit events. Seed, mnemonic, private key, recovery export, secure-sheet vault, raw or signed transaction, bot token, webhook secret and wallet-provider secret are forbidden server-side. Wallet create/import/reveal/export remains client-only.

## Basic execution

Basic supports notify-only or confirm-each. It has no delegation and no server broadcaster. Every BUY and every manual SELL is simulated by two independent read-only providers, reviewed locally, separately confirmed and submitted by the user's self-custody wallet, then reconciled without automatic rebroadcast. SELL approval is exact and separate from the freshly quoted trade. Auto-SELL is disabled.

The historical delegated and Telegram-confirm executors are not connected to Basic and must not be deployed.

## Packages

- `copy-service/` — HTTP surface, policy and intent lifecycle, two-provider RPC/simulation, D1 and Durable Object adapters, audit log, outbox, reconciliation and credential-free fixtures.
- `copy-gateway/` — the platform-only signed gateway also vendored into `bot/src/copy-gateway.js`.
- `copy-app/` — static `/copy/` Mini App with strict CSP and immutable `Lintcha Copy — trading` marking.
- `secure-sheet-crypto/src/confirm-each.mjs` — the single source for the confirm-each sheet controller copied into the static app.
- `docs/` — threat model, runbook, device matrix, deployment checklist and owner-only activation actions.

## Local verification

Run `npm run test:copy` from the repository root. The RPC acceptance and local-fork replay tools remain opt-in: they require owner-provided production credentials or a loopback fork and never broadcast a transaction.
