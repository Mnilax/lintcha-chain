-- Lintcha Copy — dedicated D1 database/binding only. Never run this schema in the Lintcha Core database
-- (Core keeps SESSIONS/TAPE/WATCH and their SQLite; Copy shares nothing with them). Idempotent.
--
-- Forbidden by design in every column: seed, mnemonic, private key, vault record, raw/signed transaction,
-- Telegram bot token, webhook secret, RPC credentials, analytics identifiers.

CREATE TABLE IF NOT EXISTS copy_users (
  telegram_user_id TEXT PRIMARY KEY,
  private_chat_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('NOTIFY_ONLY', 'CONFIRM_EACH')),
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

CREATE TABLE IF NOT EXISTS copy_kill_switches (
  scope TEXT NOT NULL CHECK (scope IN ('GLOBAL', 'USER')),
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
