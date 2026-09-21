# Remaining actions that require owner access, money or an irreversible decision

Bootstrap status on 2026-09-21: the integration and deployment-config pull requests are merged; the isolated
`lintcha-copy` D1 database, schema and SQLite Durable Object exist; scoped gateway/confirmation/admin secrets are
stored in Cloudflare; a paused Worker exists without a public route; and the verified Pons V2 manifest is pinned.
No RPC credential, bot token, wallet credential, session key, signature or transaction was stored or used.

1. **Telegram verification**: `COPY_TELEGRAM_BOT_ID=8954636276` is set from the owner's `getMe` result (public value, not the token). Re-verify Telegram's third-party public key on core.telegram.org before public resume.
2. **RPC accounts**: create independent Alchemy and dRPC Robinhood Mainnet endpoints. Alchemy Free is sufficient for the bounded two-provider probe, simulation, finality and transaction reconciliation path; approve a paid dRPC key for the required 2,000-block backfill capability. Enter both URLs directly into the trading Worker secrets. Then run `copy-service/tools/rpc-acceptance.mjs`; never paste the URLs into chat or Git.
3. **Privy application**: create the production Privy app, enable user-owned embedded wallets, create a P-256 server authorization key in the executor secret store, and define a policy that permits only the deployed `LintchaPonsAutoBuy.buy(address,uint256,uint256)` call on chain 4663. Record the public signer and policy ids as `PRIVY_AUTHORIZATION_SIGNER_ID` and `PRIVY_POLICY_ID` in the executor environment, add the public Privy app id to the same-origin Mini App build, and connect the prepared onboarding controller to Privy's `useHeadlessDelegatedActions().delegateWallet` consent UI. Confirm with Privy and device-test the user-authorized signer-removal flow; Copy deactivation alone is not represented as removing the Privy signer. Do not grant arbitrary-call, export or root permission to the signer.
4. **BUY-only contract**: commission an independent review, deploy `copy/auto-buy-contract/src/LintchaPonsAutoBuy.sol` with the official Pons V2 factory and owner-controlled pause address, verify source/bytecode, then pin the deployed address in Copy, the delegated executor and the Privy policy.
5. **Caps**: approve dust acceptance values for per-BUY spend, daily spend, slippage and manual-SELL token limits. Pons V2 is the only pinned venue; Uniswap remains excluded until equivalent evidence exists.
6. **Security and device QA**: nominate an independent reviewer for the threat model, seam, secure sheet and runbook; execute `copy/docs/DEVICE_QA_MATRIX.md` with a dust wallet.
7. **Public activation**: only after the preceding evidence, publish the existing `https://lintcha.com/copy/*` asset route and `https://lintcha.com/api/copy/*` Worker route, enable the Core service binding, deploy the current Core Worker, and verify health/outbox/webhook end to end while the global kill switch remains paused.
8. **Activation**: fund only the owner-controlled dust wallet, create the first revocable delegation, run one BUY plus revocation while public trading remains paused, reconcile it through both RPCs, then separately approve the global public resume. There is no closed-beta phase.

Never send bot token, RPC URLs, API keys, seed, mnemonic or private key in Telegram or this workspace. No wallet is funded until its own gate is approved.

Provider evidence checked 2026-09-21:

- Robinhood Chain production RPC and provider list: https://docs.robinhood.com/chain/connecting/
- Privy Telegram trading-bot architecture: https://docs.privy.io/recipes/bankr-bot-guide
- Privy delegated signers: https://docs.privy.io/wallets/using-wallets/signers/delegate-wallet
- Privy wallet policies and controls: https://docs.privy.io/security/wallet-infrastructure/policy-and-controls
