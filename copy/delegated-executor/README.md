# Lintcha delegated executor

This is a separate, private service boundary between `Lintcha Copy` and Privy. It never receives the Telegram bot token or user recovery material.

It accepts only one calldata shape: `LintchaPonsAutoBuy.buy(address,uint256,uint256)` on the configured chain and deployed executor address. It applies its own global kill switch, hard transaction cap, short expiry and idempotency record. An uncertain upstream result is marked for reconciliation and is never submitted again automatically.

The private `/verify-delegation` route is the activation trust boundary. It re-reads the referenced wallet through Privy's server SDK and accepts it only when the wallet address, Ethereum chain type, active status, configured signer id and configured BUY-only policy id all match. It returns public metadata only. Copy never activates auto-BUY from a browser assertion alone.

The `PrivyDelegatedWalletClient` adapter follows Privy's server wallet API shape. The production runtime must construct the official `PrivyClient` from production secrets and a P-256 authorization key in the executor environment only. Those values must never be stored in this repository, Copy D1, Telegram, analytics or logs.

Deployment remains disabled until the BUY-only contract has an independent review, is deployed, its address is pinned in both services, a Privy policy restricts calls to that address and selector, `PRIVY_AUTHORIZATION_SIGNER_ID` and `PRIVY_POLICY_ID` are pinned in this service, and the global kill switches are explicitly released.
