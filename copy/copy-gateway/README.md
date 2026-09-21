# Lintcha Copy gateway

The only integration seam inside the existing `@lintchabot` webhook service. `src/gateway.mjs` is vendored byte-for-byte into the Core Worker as `bot/src/copy-gateway.js` (see `migration/lintcha-copy-gateway-seam.patch`); it uses platform primitives only (WebCrypto, TextEncoder), no node builtins.

- Recognizes only `/copy`, the exact site-attribution deep link `/start copy_site` (both optionally `@lintchabot`-suffixed), and namespaced `copy.*`, `trade.*`, `sell.*` callbacks.
- Forwards a minimal, HMAC-signed identity envelope to the separate Copy service; never the raw update, message text or bot token.
- Constrains every Copy reply to text, namespaced callbacks and the exact configured Copy origin under `/copy/`.
- A group `/copy` gets a fixed private-only line; a Copy outage, timeout or malformed reply gets a fixed unavailable line; an update without a usable identity is silence. Nothing throws into the Core webhook.
- `drainCopyOutbox` lets Core deliver Copy's queued lines with Core's own token, after the same validation, acknowledging only accepted sends.

Every non-Copy update returns `handled: false` and stays entirely in Lintcha Core.
