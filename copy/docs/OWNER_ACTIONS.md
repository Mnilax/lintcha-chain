# Remaining actions that require owner access, money or an irreversible decision

Bootstrap status on 2026-09-21: the integration and deployment-config pull requests are merged; the isolated
`lintcha-copy` D1 database, schema and SQLite Durable Object exist; scoped gateway/confirmation/admin secrets are
stored in Cloudflare; a paused Worker exists without a public route; and the verified Pons V2 manifest is pinned.
No RPC credential, bot token, wallet credential, session key, signature or transaction was stored or used.

1. **Public bot id**: read @lintchabot's numeric id from `getMe` and set `COPY_TELEGRAM_BOT_ID` (public value, not the token). Re-verify Telegram's third-party public key on core.telegram.org.
2. **RPC accounts**: create independent Alchemy and dRPC Robinhood Mainnet endpoints, approve any paid plans, and enter both URLs directly into the trading Worker secrets. Then run `copy-service/tools/rpc-acceptance.mjs`; never paste the URLs into chat or Git.
3. **Wallet bridge account**: create a Reown project for the Telegram Mini App and enter its project id through the deployment secret/config flow. Reown is only the client wallet bridge; it does not receive the Telegram bot token.
4. **Auto-BUY executor account**: provision Alchemy Wallet APIs / Modular Account V2 for Robinhood Mainnet. The selected direction is EIP-7702 with expiring session permissions constrained by target, function, native spend and time. Do not grant root permission. Production activation still requires a provider-specific executor review and one real revocation test.
5. **Caps**: approve dust beta values for per-BUY spend, daily spend, slippage and manual-SELL token limits. Pons V2 is the only pinned venue; Uniswap remains excluded until equivalent evidence exists.
6. **Security and device QA**: nominate an independent reviewer for the threat model, seam, secure sheet and runbook; execute `copy/docs/DEVICE_QA_MATRIX.md` with a dust wallet.
7. **Public activation**: only after the preceding evidence, publish the existing `https://lintcha.com/copy/*` asset route and `https://lintcha.com/api/copy/*` Worker route, enable the Core service binding, deploy the current Core Worker, and verify health/outbox/webhook end to end while the global kill switch remains paused.
8. **Closed beta**: separately approve named beta users and the global resume. Funding, the first delegation, signature and transaction remain explicit gates.

Never send bot token, RPC URLs, API keys, seed, mnemonic or private key in Telegram or this workspace. No wallet is funded until its own gate is approved.

Provider evidence checked 2026-09-21:

- Robinhood Chain production RPC and provider list: https://docs.robinhood.com/chain/connecting/
- Alchemy Robinhood Mainnet bundler/gas support: https://www.alchemy.com/docs/wallets/supported-chains
- Alchemy session permission types: https://www.alchemy.com/docs/wallets/reference/wallet-apis-session-keys
- Reown custom EVM networks: https://docs.reown.com/appkit/next/core/custom-networks
