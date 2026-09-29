# Auto-BUY architecture

Status: implemented and tested locally through a first-party Mini App bridge contract, and disabled by default. The official Privy React host bridge is not bundled or runtime-tested. No wrapper has been deployed, no real Privy signer has been attached or removed, and no real transaction has been signed or broadcast by this tree.

## Identity and activation

Auto-BUY activation is deliberately multi-step. A public address or a browser claim is never enough.

1. The Mini App request is authenticated with Telegram third-party Ed25519 init data. Copy binds the request to that Telegram user and requires the public wallet address to be registered to the same Copy account.
2. `POST /api/copy/delegations/prepare` validates the requested per-trade, daily-spend, slippage and expiry limits against the system ceilings. Before consent, the executor resolves the Telegram-linked Privy wallet, checks that it is active and requires an empty additional-signer set. Only then does Copy return a short-lived, user/wallet/limits-bound activation token and the exact unsigned `LintchaPonsAutoBuy.configure(...)` transaction.
3. The client controller derives the configure calldata independently and refuses any server transaction or limits that differ from the user's exact input. The user's wallet must sign and send this zero-value wrapper configuration transaction.
4. Activation waits for finalized inclusion and exact readback of all wrapper limits through the embedded-wallet provider. The client then calls `POST /api/copy/delegations/verify-configuration`; the server reads the same exact limits through both independent RPC providers at one finalized block and records that this activation nonce passed configuration verification. A mismatch, provider disagreement, paused record or expired record fails closed before any signer is attached.
5. Only after the finalized wrapper readback does the client call Privy's `addSigners` for the exact configured signer and one policy id:

   ```ts
   addSigners({
     address: walletAddress,
     signers: [{ signerId, policyIds: [policyId] }]
   })
   ```

6. `POST /api/copy/delegations/activate` requires the same nonce's server configuration-verification mark and consumes the activation token once. The private executor resolves the user with Privy's Telegram identity, requires exactly one matching Privy embedded Ethereum wallet, re-reads that wallet, and proves that the expected additional signer has only the expected override policy.
7. The executor also fetches the mutable policy by id and checks its pinned owner plus the exact canonical BUY-only content hash: chain `4663`, the one deployed wrapper address, `eth_sendTransaction`, `buy(address,uint256,uint256)` (`0xa59ac6dd`), and the system transaction-value ceiling. Any extra or broader rule fails closed.
8. Only after both the Privy proof and a defensive second server-side finalized wrapper readback during activation does Copy create the active delegation record and switch that user to `AUTO_BUY`.

If the final activation call fails after the executor has verified the attached signer, Copy stores a revoked pending-removal record. The controller then runs the full deactivation sequence rather than treating activation as successful. Any unfinished cleanup is returned as signer-removal-pending and is recoverable from `/me` after reload; failure to persist that server record is an explicit manual-recovery case.

## Runtime path

1. The read-only observer accepts a Pons V2 source transaction only after the two RPC providers agree on the canonical block and the configured finality policy marks it confirmed.
2. `AutoBuyDispatcher` applies the user's direction, sizing, token, cooldown, per-trade and daily rules. Notifications stop here. Every source SELL becomes `MANUAL_SELL_REQUIRED` and cannot enter delegated execution.
3. `PonsV2QuoteEngine` re-reads the current curve state and computes a fresh, expiring quote. It rejects graduation, unsupported quote assets, provenance mismatch, partial fill, excessive price impact and bad fees.
4. The builder emits exactly `LintchaPonsAutoBuy.buy(token, amountIn, minimumOutput)`. Copy checks the wrapper address, selector and every encoded value against the quote before it reserves spend or simulates.
5. Both RPC providers must return the same simulation result at one common block. The user, wallet and global kill switches are checked again after simulation.
6. For every submission, not only at activation, the executor fetches and verifies the pinned policy owner and canonical SHA-256 content again. A policy id is not treated as immutable: drift or an unavailable policy blocks signing. The Telegram-bound wallet and attached-signer proof is the activation boundary; subsequent submissions also require the active local delegation, matching opaque wallet reference and absence of an executor authorization block.
7. The executor applies its own global kill switch, durable authorization block, address/selector/value/TTL checks, hard system cap and idempotency record. It asks Privy to send only the already validated unsigned transaction from the referenced user-owned wallet. An uncertain result is never retried automatically.
8. The immutable wrapper resolves token to curve through the official Pons V2 factory and rechecks provenance, live phase, native quote asset, fees, reserves, partial fill, the user's on-chain per-trade/daily/slippage/expiry limits and both pause states. Bought tokens go directly to the caller.
9. Copy stores only the public hash and reconciles it through both RPC providers. Safe inclusion is required before confirmation.

Privy policies are mutable in place. `version: "1.0"` is a schema version, not a content revision. Production therefore pins the policy id, a non-null owner quorum id and a locally reviewed canonical content SHA-256. Policy changes require a new reviewed policy id/hash rather than an in-place widening.

## Deactivation and revocation

Deactivation is fail-safe and ordered from fastest local protection to externally verifiable revocation:

1. Copy revokes the local delegation first and returns an `AUTO_BUY` user to notification mode. This cleanup route remains available when auto-BUY submission flags are off.
2. The private executor durably blocks that wallet/authorization reference before any later claim; this block route is independent of its submission enable/pause flags.
3. The user's wallet signs `LintchaPonsAutoBuy.setUserPaused(true)`. The embedded-wallet EIP-1193 provider must report finalized inclusion and an exact wrapper readback showing `paused == true`; this client check does not replace the separately required two-RPC production acceptance.
4. Immediately before removal, the first-party bridge must return a fresh signer state containing exactly the one configured Lintcha signer and exactly its one pinned policy. Copy then requires a second fresh server check through `/delegations/removal-readiness`, which re-resolves the same Telegram-linked wallet and proves the same sole signer, sole policy and authorization epoch. Unknown, missing, stacked or mismatched state stops automated cleanup for manual recovery; `removeSigners` is never called against an ambiguous signer set.
5. The client calls Privy's user-authorized `removeSigners({address: walletAddress})`.
6. Copy asks the executor for a fresh server-side revocation proof. The executor re-resolves the Telegram-linked wallet and requires the configured signer to be absent from `additional_signers`; a merely local status change is not accepted as revocation.

Failure after step 1 leaves auto-BUY locally inactive and reports which external cleanup stage remains pending. The revoked delegation stays server-side as `PENDING_REMOVAL`, is returned by `/me` without its opaque authorization reference, makes the visible sheet withhold new activation, and restores the cleanup control after reload so the original wallet can retry pause/removal. Only a successful server revocation proof deletes that stale record. Unknown signer state is routed to explicit manual recovery. The UI must not collapse local shutdown, executor block, on-chain pause and signer removal into one success state.

## Client integration status

`copy-app/copy/auto-buy-onboarding.mjs` implements and tests the provider-neutral activation/deactivation controller described above. The visible sheet exposes limit inputs and activation/removal states, instantiates the controller when a matching first-party `window.lintchaPrivy` bridge is present, verifies that bridge's public ids, binds its wallet identity to the Telegram user, and uses the embedded wallet provider for transaction finality/readback.

The bridge contract is not the official Privy React host implementation: no SDK bundle, wallet creation/recovery integration or credentialed device run is present here. Production must supply that same-origin bridge for a user-owned Privy embedded wallet and its `addSigners`/`removeSigners` calls without exposing key material or adding an unreviewed remote script. The local UI is therefore wired but not production-operational; device testing of the exact consent and removal flows remains an owner gate.

Auto-BUY must use a dedicated Privy embedded wallet, not silently add authority to a wallet already used for unrelated activity. Local preflight proves that the selected Telegram-linked wallet has no existing additional signer; creation/recovery UX and the stronger dedicated-wallet product requirement still need bridge/device acceptance.

## Deliberately absent

- no auto-SELL function, selector, policy rule or executor branch;
- no arbitrary call, token approval, upgrade or owner withdrawal in the wrapper;
- no user seed, private key, signature, signed transaction or Privy authorization key in Telegram, Copy D1, audit, analytics or Git;
- no automatic retry after an ambiguous submission;
- no production activation from configuration alone: bridge completion, independent wrapper review and deployment, exact policy creation/pinning, runtime acceptance, device QA, a dust-wallet exercise and explicit global resume are separate gates.

## Selected signer model

The first production path is a user-owned Privy embedded wallet with a removable additional TEE signer. ERC-4337 and EIP-7702 are not required for this boundary because the immutable wrapper and exact Privy policy constrain the call itself. Alchemy and dRPC remain the independent read/simulation/finality/reconciliation providers. Account abstraction can be considered later for gas sponsorship without widening the wrapper or enabling auto-SELL.
