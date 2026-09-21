PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL UNIQUE,
  locale TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','blocked')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  public_address TEXT NOT NULL,
  wallet_mode TEXT NOT NULL CHECK (wallet_mode IN ('external','local','watch_only')),
  alias TEXT NOT NULL,
  verification_status TEXT NOT NULL CHECK (verification_status IN ('unverified','verified')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(user_id, public_address)
);

CREATE TABLE IF NOT EXISTS execution_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  public_address TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('NOTIFY_ONLY','COPY_TRADING')),
  authorization_status TEXT NOT NULL CHECK (authorization_status IN ('missing','pending','active','revoked','expired')),
  authorization_id TEXT,
  signing_architecture TEXT CHECK (signing_architecture IS NULL OR signing_architecture IN ('ERC4337_SESSION_KEY','EIP7702_SESSION_KEY')),
  authorization_expires_at INTEGER,
  max_per_trade TEXT NOT NULL,
  max_per_day TEXT NOT NULL,
  allowed_directions_json TEXT NOT NULL DEFAULT '["BUY"]',
  allowed_targets_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (mode <> 'COPY_TRADING' OR authorization_status = 'active')
);

CREATE TABLE IF NOT EXISTS execution_reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  utc_day TEXT NOT NULL,
  amount TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('RESERVED','SIGNING','SUBMITTED','CONFIRMED','RELEASED')),
  transaction_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS execution_reservations_user_day
  ON execution_reservations(user_id, utc_day, state);

CREATE TABLE IF NOT EXISTS manual_sell_intents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token TEXT NOT NULL,
  amount TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  quote_fingerprint TEXT NOT NULL,
  order_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('AWAITING_CONFIRMATION','SIGNING','SUBMITTED','CONFIRMED','EXPIRED','CANCELLED')),
  transaction_hash TEXT,
  expires_at INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS manual_sell_intents_user_token
  ON manual_sell_intents(user_id, token, state);

CREATE TABLE IF NOT EXISTS copy_targets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  source_address TEXT NOT NULL,
  alias TEXT NOT NULL,
  network_chain_id INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','paused','archived')),
  cursor_block INTEGER,
  cursor_hash TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, network_chain_id, source_address)
);

CREATE TABLE IF NOT EXISTS copy_rules (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES copy_targets(id),
  direction TEXT NOT NULL CHECK (direction IN ('BUY_ONLY','SELL_ONLY','BUY_AND_SELL')),
  min_source_amount TEXT,
  sizing_policy TEXT NOT NULL CHECK (sizing_policy IN ('FIXED_QUOTE','SOURCE_RATIO','BALANCE_PERCENT')),
  sizing_value TEXT NOT NULL,
  max_per_trade TEXT NOT NULL,
  max_per_day TEXT NOT NULL,
  max_slippage_bps INTEGER NOT NULL,
  max_price_impact_bps INTEGER NOT NULL,
  quote_ttl_seconds INTEGER NOT NULL,
  cooldown_seconds INTEGER NOT NULL,
  filters_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','paused','archived')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_events (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES copy_targets(id),
  transaction_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  direction TEXT NOT NULL,
  facts_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PROVISIONAL','CONFIRMED','FINALIZED','RETRACTED')),
  created_at TEXT NOT NULL,
  UNIQUE(transaction_hash, log_index)
);

CREATE TABLE IF NOT EXISTS rule_matches (
  id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  rule_id TEXT NOT NULL REFERENCES copy_rules(id),
  rule_revision INTEGER NOT NULL,
  matched INTEGER NOT NULL CHECK (matched IN (0,1)),
  reason TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source_event_id, rule_id)
);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  rule_match_id TEXT NOT NULL REFERENCES rule_matches(id),
  block_number INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  route_hash TEXT NOT NULL,
  quote_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  rule_match_id TEXT NOT NULL UNIQUE REFERENCES rule_matches(id),
  state TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  intent_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  transaction_hash TEXT,
  submitted_block INTEGER,
  confirmed_block INTEGER,
  receipt_status INTEGER,
  receipt_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_usage (
  rule_id TEXT NOT NULL REFERENCES copy_rules(id),
  utc_day TEXT NOT NULL,
  amount TEXT NOT NULL,
  PRIMARY KEY(rule_id, utc_day)
);

CREATE TABLE IF NOT EXISTS audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  result_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(scope, key)
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS referral_codes (
  code TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('active','blocked')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS referral_bindings (
  invited_user_id TEXT PRIMARY KEY REFERENCES users(id),
  referrer_user_id TEXT NOT NULL REFERENCES users(id),
  code TEXT NOT NULL REFERENCES referral_codes(code),
  created_at TEXT NOT NULL,
  CHECK (invited_user_id <> referrer_user_id)
);

CREATE TABLE IF NOT EXISTS fee_schedule (
  version INTEGER PRIMARY KEY,
  activation_at TEXT NOT NULL,
  free_until TEXT NOT NULL,
  fee_bps INTEGER NOT NULL CHECK (fee_bps BETWEEN 0 AND 10000),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS referral_rates (
  id TEXT PRIMARY KEY,
  referrer_user_id TEXT,
  share_bps INTEGER NOT NULL CHECK (share_bps BETWEEN 0 AND 6000),
  effective_from TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fee_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  transaction_hash TEXT NOT NULL,
  receipt_block INTEGER NOT NULL,
  fee_asset TEXT NOT NULL,
  fee_base TEXT NOT NULL,
  fee_amount TEXT NOT NULL,
  schedule_version INTEGER NOT NULL REFERENCES fee_schedule(version),
  state TEXT NOT NULL CHECK (state IN ('FINALIZED','REVERSED')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS referral_accruals (
  id TEXT PRIMARY KEY,
  fee_event_id TEXT NOT NULL UNIQUE REFERENCES fee_events(id),
  referrer_user_id TEXT NOT NULL REFERENCES users(id),
  share_bps INTEGER NOT NULL,
  asset TEXT NOT NULL,
  amount TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','batched','paid','reversed')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS referral_payouts (
  id TEXT PRIMARY KEY,
  asset TEXT NOT NULL,
  amount TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared','approved','submitted','confirmed','cancelled')),
  transaction_hash TEXT,
  created_by TEXT NOT NULL,
  approved_by TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_audit (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
