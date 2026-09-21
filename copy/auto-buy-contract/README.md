# Lintcha Pons auto-BUY executor

This package contains the intentionally narrow on-chain target for delegated Lintcha Copy BUY sessions.

Security properties:

- resolves every token and curve through the immutable Pons V2 factory;
- accepts native-asset Pons V2 launches in the live bonding-curve phase only;
- enforces user-owned per-transaction, per-day, slippage and expiry limits on-chain;
- starts globally paused and has independent global and per-user pause controls;
- sends bought tokens directly to the caller;
- exposes no SELL, arbitrary-call, approval, upgrade or owner-withdrawal function.

This source is not deployed by adding it to the repository. Deployment, configuration, delegation, funding, signing and broadcasting are separate owner-approved production actions.
