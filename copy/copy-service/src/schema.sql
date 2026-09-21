-- Lintcha Copy — dedicated D1 database/binding only. Never run this schema in the Lintcha Core database
-- (Core keeps SESSIONS/TAPE/WATCH and their SQLite; Copy shares nothing with them). Idempotent.
--
-- Forbidden by design in every column: seed, mnemonic, private key, vault record, raw/signed transaction,
-- Telegram bot token, webhook secret, RPC credentials, analytics identifiers.

CREATE TABLE IF NOT EXISTS copy_users (
  telegram_user_id TEXT PRIMARY KEY,
  private_chat_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('NOTIFY_ONLY', 'AUTO_BUY', 'CONFIRM_EACH')),
  paused INTEGER NOT NULL DEFAULT 1 CHECK (paused IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS copy_wallets (
  telegram_user_id TEXT NOT NULL REFERENCES copy_users(telegram_user_id),
  public_address TEXT NOT NULL,
  wallet_kind TEXT NOT NULL CHECK (wallet_kind IN ('LOCAL_SECURE_SHEET', 'EXTERNAL')),
  public_label TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (telegram_user_id, public_address)
);

-- Public, bounded delegation metadata only. `authorization_ref` is an opaque reference understood by the
-- separately controlled delegated executor; no key, signature or signed transaction is stored here.
CREATE TABLE IF NOT EXISTS copy_delegations (
  telegram_user_id TEXT NOT NULL REFERENCES copy_users(telegram_user_id),
  public_address TEXT NOT NULL,
  architecture TEXT NOT NULL CHECK (architecture IN ('PRIVY_TEE', 'EIP7702_SESSION', 'ERC4337_SESSION')),
  authorization_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
  chain_id INTEGER NOT NULL,
  routers_json TEXT NOT NULL,
  selectors_json TEXT NOT NULL,
  max_transaction_wei TEXT NOT NULL,
  max_daily_spend_wei TEXT NOT NULL,
  max_slippage_bps INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (telegram_user_id, public_address)
);

-- First-party acquisition attribution from Telegram deep links. The Telegram user id is already the Copy account
-- key; no browser fingerprint, cookie, IP address, raw initData or third-party analytics identifier is stored.
CREATE TABLE IF NOT EXISTS copy_referral_users (
  source TEXT NOT NULL CHECK (source IN ('SITE')),
  telegram_user_id TEXT NOT NULL REFERENCES copy_users(telegram_user_id),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  starts INTEGER NOT NULL DEFAULT 1 CHECK (starts > 0),
  PRIMARY KEY (source, telegram_user_id)
);

CREATE TABLE IF NOT EXISTS copy_kill_switches (
  scope TEXT NOT NULL CHECK (scope IN ('GLOBAL', 'USER', 'WALLET')),
  subject_id TEXT NOT NULL,
  paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
  revision INTEGER NOT NULL,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, subject_id)
);

-- The indexed columns are for queries; row_json is the complete public intent record (quote, unsigned
-- transaction, simulation, history). It never contains key material because the service never has any.
CREATE TABLE IF NOT EXISTS copy_confirmation_intents (
  id TEXT PRIMARY KEY,
  replay_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('BUY', 'SELL')),
  operation TEXT NOT NULL CHECK (operation IN ('APPROVAL', 'TRADE')),
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  transaction_hash TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  row_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS copy_intents_state ON copy_confirmation_intents(state, updated_at);
CREATE INDEX IF NOT EXISTS copy_intents_user ON copy_confirmation_intents(user_id, created_at);

CREATE TABLE IF NOT EXISTS copy_daily_spend_reservations (
  intent_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  utc_day TEXT NOT NULL,
  amount_wei TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('RESERVED', 'COMMITTED', 'RELEASED')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS copy_daily_spend_user_day ON copy_daily_spend_reservations(user_id, utc_day, state);

CREATE TABLE IF NOT EXISTS copy_audit_log (
  sequence INTEGER PRIMARY KEY,
  event_hash TEXT NOT NULL UNIQUE,
  previous_hash TEXT NOT NULL,
  event_type TEXT NOT NULL,
  public_payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Durable replay marks for the signed Core→Copy channel (Telegram update ids and service request ids).
CREATE TABLE IF NOT EXISTS copy_gateway_replays (
  replay_key TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS copy_gateway_replays_expiry ON copy_gateway_replays(expires_at);

-- Lines Core delivers with its own bot token. Copy never sends to Telegram directly.
CREATE TABLE IF NOT EXISTS copy_outbox (
  id INTEGER PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  private_chat_id TEXT NOT NULL,
  text TEXT NOT NULL,
  inline_keyboard_json TEXT NOT NULL,
  dedupe_key TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'SENT', 'DEAD')),
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS copy_outbox_pending ON copy_outbox(state, lease_until);
