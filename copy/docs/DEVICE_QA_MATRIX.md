# Lintcha copy-trading — device QA matrix (to be executed before beta; nothing executed yet)

Preconditions: Copy Worker deployed with `COPY_GLOBAL_KILL_SWITCH=true` then resumed for the QA user only; a QA wallet with dust; Pons V2 curve or Uniswap V2 router in the allowlist; caps set to dust values.

| # | Client | Wallet path | Steps | Pass criteria |
|---|---|---|---|---|
| 1 | Telegram iOS | injected EIP-1193 absent (expected) | /copy → Open copy-trading | `Lintcha — copy-trading` label visible first; "no EIP-1193 wallet in this client" state; nothing else clickable |
| 2 | Telegram Android | same | same | same |
| 3 | Telegram Desktop (macOS/Windows) | same | same | same |
| 4 | Telegram Web (web.telegram.org K and Z) | browser extension wallet (MetaMask/Rabby) on Robinhood Chain | connect → register address → receive BUY review → confirm → wallet → hash | frame allowed by CSP; review fields equal wallet prompt (to/value/data); hash appears; state → CONFIRMED after safe block |
| 5 | Telegram Web | wallet on wrong chain | same | `WALLET_CHAIN_MISMATCH` shown; no `wallet_addEthereumChain`; nothing sent |
| 6 | Telegram Web | wallet with a different account | same | `WALLET_ACCOUNT_MISMATCH`; nothing sent |
| 7 | any | reject in wallet | confirm → reject | CANCELLED (USER_REJECTED_IN_WALLET); intent cancelled server-side; reservation released |
| 8 | any | cancel in sheet | review → Cancel | CANCELLED; wallet never opened |
| 9 | any | double tap Confirm | review → tap twice fast | one wallet prompt; second tap no-op (revision) |
| 10 | any | reopen an old review link | after CONFIRMED/EXPIRED | "closed (STATE)" line; no sheet action |
| 11 | any | expiry | wait past TTL | EXPIRED; reservation released; Telegram line says closed |
| 12 | any | manual SELL | approval intent → confirm → reconcile → trade intent → confirm | two separate confirmations; Telegram `sell.confirm.*` refused; allowance read before trade |
| 13 | any | global pause mid-flow | pause while sheet open | begin refused with 423; nothing sent |
| 14 | any | provider outage (staging: break one URL) | create intent | `SIMULATION_PROVIDER_UNAVAILABLE`; no intent |
| 15 | any | init data older than 1 h | reopen stale Mini App | 401 STALE_INIT_DATA; sheet asks to reopen from Telegram |
| 16 | any | Core drain | queue review while Core cron runs | private-chat line arrives once; button points to `https://lintcha.com/copy/` |

Wallet bridge decision (WalletConnect/Reown or a wallet's Telegram SDK) changes rows 1–3 from "expected absent" to real flows; that decision is the owner's and will require CSP `connect-src` changes and its own review.
