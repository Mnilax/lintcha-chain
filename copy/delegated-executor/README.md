# Lintcha delegated executor

This is a separate, private service boundary between `Lintcha Copy` and Privy. It never receives the Telegram bot token, a user recovery secret, a user signature or a signed transaction. The Privy app secret and P-256 authorization private key belong only in this runtime's production secret store.

Nothing in this directory is deployed. No real Privy signer/delegation exists and no real transaction has been signed or broadcast by this implementation.

## What it accepts

Submission accepts one calldata shape only: `LintchaPonsAutoBuy.buy(address,uint256,uint256)` (`0xa59ac6dd`) on chain `4663`, sent to the configured immutable wrapper. The executor checks target, selector, ABI length, `transaction.value == amountIn`, hard value cap, short expiry and durable idempotency before asking Privy to send the unsigned transaction. An uncertain Privy result is stored for reconciliation and never submitted again automatically.

There is no auto-SELL, arbitrary-call or token-approval branch.

## Telegram-bound Privy proof

`/verify-delegation` does not trust a wallet id supplied by the browser. Given only the authenticated Telegram user id and public wallet address, it:

1. calls Privy's Telegram-user lookup;
2. requires exactly one matching linked Privy embedded Ethereum wallet;
3. re-reads that wallet by its server-side id and checks address, chain and active state;
4. requires exactly one configured additional signer with exactly one configured override policy id;
5. fetches that mutable policy and validates its pinned non-null owner plus the canonical SHA-256 of the complete effective BUY-only security projection.

Before the client is allowed to request consent, `/verify-wallet-preflight` resolves the same Telegram-linked wallet and requires it to be active with no existing additional signers. Activation later requires exactly the configured signer; unknown or stacked signers fail closed. Production onboarding must also enforce the product requirement that this is a dedicated Privy wallet rather than silently repurposing a wallet used for unrelated activity.

The expected projection allows only `eth_sendTransaction` on chain `4663` to the configured wrapper, with a value no greater than the system cap and calldata decoded by the exact `buy(address,uint256,uint256)` ABI. Any extra/broader rule, wildcard, owner mismatch, content-hash drift or unavailable policy fails closed. A policy id and `version: "1.0"` are not treated as immutable content.

The complete Telegram-wallet/signer/policy proof runs at activation. Immediately before every submission the executor fetches and verifies the exact mutable policy owner/content hash again; it also requires the active Copy delegation's opaque wallet reference and checks that the executor has no durable block for that authorization.

## Deactivation and revocation

`/wallets/deactivate` durably blocks the `(wallet address, authorization reference)` before any later idempotency claim. This emergency block is callable even when executor submission is disabled or globally paused.

The user's complete removal flow additionally requires a user-signed wrapper `setUserPaused(true)`. Immediately before Privy's client-side `removeSigners({address})`, the first-party bridge must freshly report exactly the sole configured Lintcha signer with exactly its one policy, and `/verify-removal-readiness` must independently re-resolve the same Telegram-linked wallet and prove that exact sole signer, policy and authorization reference. Ambiguous, stacked or mismatched state stops for manual recovery. `/verify-revocation` then resolves the wallet afresh and succeeds only when the configured signer is absent from `additional_signers`; `delegated: false` or a Copy database status alone is insufficient.

## Deployment gates

The Worker must remain disabled/paused until all of the following are complete:

- the wrapper is independently reviewed, deployed and its bytecode/constructor inputs verified;
- the exact policy is created with a separate owner quorum, and policy id, owner id and canonical content SHA are reviewed and pinned;
- the Copy Mini App's official Privy bridge and `addSigners`/`removeSigners` flows pass device QA;
- credentialed Cloudflare/D1, Privy and two-RPC runtime acceptance passes, including cleanup while submission flags are off;
- an owner-controlled dust-wallet activation, BUY, local block, on-chain pause, signer removal and server revocation proof succeeds while public trading remains paused;
- deployment and public resume are approved separately.
