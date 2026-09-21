# Auto-BUY architecture

Status: implemented locally and disabled. No contract is deployed, no Privy permission exists, and no real transaction has been signed or broadcast by this tree.

## Runtime path

1. The read-only observer accepts a Pons V2 source transaction only after the two RPC providers agree on the canonical block and the configured finality policy marks it confirmed.
2. `AutoBuyDispatcher` applies the user's direction, sizing, token, cooldown, per-trade and daily rules. Notifications stop here. Every source SELL becomes `MANUAL_SELL_REQUIRED` and cannot enter delegated execution.
3. `PonsV2QuoteEngine` re-reads the current curve state and computes a fresh, expiring quote. It rejects graduation, unsupported quote assets, provenance mismatch, partial fill, excessive price impact and bad fees.
4. The builder emits exactly `LintchaPonsAutoBuy.buy(token, amountIn, minimumOutput)`. Copy service checks the executor address, selector and every encoded value against the quote before it reserves spend or simulates.
5. Both RPC providers must return the same simulation result at one common block. The user, wallet and global kill switches are checked again after simulation.
6. During activation, the private delegated executor re-reads the Privy wallet and proves its public address, active Ethereum state, exact configured signer id and exact BUY-only policy id. Copy then stores only the opaque wallet reference and lower user-selected caps. A browser assertion alone can never activate auto-BUY.
7. For a matched trade, the private delegated executor applies a second kill switch, address/selector/value/TTL checks, a hard system cap and durable idempotency. It asks Privy to send the unsigned transaction from the referenced user-owned wallet. An uncertain result is never retried automatically.
8. The immutable wrapper resolves token → curve through the official Pons V2 factory and rechecks provenance, live phase, native quote asset, fees, reserves, partial fill, the user's on-chain per-trade/daily/slippage/expiry limits and both pause states. Bought tokens go directly to the caller.
9. Copy stores only the public hash and reconciles it through both RPC providers. Safe inclusion is required before confirmation.

## Deliberately absent

- no auto-SELL function, selector or executor branch;
- no arbitrary call, token approval, upgrade or owner withdrawal in the wrapper;
- no user seed, private key, signed transaction or Privy authorization key in Telegram, Copy D1, audit, analytics or Git;
- no automatic retry after an ambiguous submission;
- no production activation from configuration alone: contract deployment/review, Privy policy proof, dust acceptance and explicit global resume are separate gates.

## Client activation seam

`copy-app/copy/auto-buy-onboarding.mjs` is the credential-free controller around Privy's consent UI. The production UI must call Privy's documented `useHeadlessDelegatedActions().delegateWallet({address, chainType: "ethereum"})`, then submit only the public wallet address and user-selected limits to Copy. The executor resolves the wallet id through Privy's server SDK; the browser never supplies it. The API refuses values above system caps or beyond `COPY_DELEGATION_MAX_TTL_SECONDS`, and the executor independently verifies the signer and policy before activation. The Privy application id and bundled React bridge are deployment configuration; no placeholder credential or third-party remote script is committed here.

`delegations/deactivate` immediately removes the active Copy record and returns an `AUTO_BUY` user to notification mode. It is deliberately not described as Privy signer revocation: the official client integration must expose and device-test a user-authorized signer-removal flow before public activation. Until that proof exists, deactivation is a Lintcha kill switch and the global system remains paused.

## Selected signer model

The first production path is a user-owned Privy embedded wallet with a revocable TEE signer. ERC-4337 and EIP-7702 are not required for the safety boundary because the immutable wrapper and Privy policy constrain the call itself. Alchemy and dRPC remain the independent read/simulation/reconciliation providers. Account abstraction can be added later for gas sponsorship without widening the wrapper or enabling auto-SELL.
