-- Dedicated executor D1. Stores public idempotency/reconciliation state only; never a Privy secret or user key.
CREATE TABLE IF NOT EXISTS delegated_submissions (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('PENDING', 'SUBMITTED', 'UNCERTAIN')),
  transaction_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS delegated_submissions_state ON delegated_submissions(state, updated_at);
