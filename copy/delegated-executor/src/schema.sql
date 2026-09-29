-- Dedicated executor D1. Stores public idempotency/reconciliation state only; never a Privy secret or user key.
CREATE TABLE IF NOT EXISTS delegated_submissions (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'SUBMITTED', 'UNCERTAIN')),
  transaction_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS delegated_submissions_state ON delegated_submissions(state, updated_at);

-- Public authorization identifiers only. A row blocks the entire wallet across every app-generated epoch
-- until a fresh server-side Privy read proves the configured signer absent. No key, signature or raw
-- transaction is stored.
CREATE TABLE IF NOT EXISTS delegated_authorization_blocks (
  telegram_user_id TEXT NOT NULL,
  wallet_address TEXT PRIMARY KEY,
  authorization_ref TEXT NOT NULL,
  blocked_at INTEGER NOT NULL
);
