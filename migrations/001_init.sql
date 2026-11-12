CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TYPE cash_in_status AS ENUM ('PENDING', 'PROCESSING', 'UNKNOWN', 'COMPLETED', 'FAILED');

CREATE TABLE wallets (
  user_id VARCHAR(128) PRIMARY KEY,
  balance_minor BIGINT NOT NULL DEFAULT 0 CHECK (balance_minor >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE cash_in_operations (
  id UUID PRIMARY KEY,
  idempotency_key UUID NOT NULL UNIQUE,
  request_hash CHAR(64) NOT NULL,
  user_id VARCHAR(128) NOT NULL,
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency CHAR(3) NOT NULL,
  payment_method VARCHAR(128) NOT NULL,
  status cash_in_status NOT NULL DEFAULT 'PENDING',
  provider_payment_id VARCHAR(128),
  failure_code VARCHAR(64),
  failure_reason VARCHAR(512),
  new_balance_minor BIGINT,
  provider_attempts INTEGER NOT NULL DEFAULT 0 CHECK (provider_attempts >= 0),
  processing_lease_until TIMESTAMPTZ,
  last_provider_event_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status <> 'COMPLETED') OR (new_balance_minor IS NOT NULL)),
  CHECK ((status <> 'FAILED') OR (failure_code IS NOT NULL))
);

CREATE UNIQUE INDEX cash_in_provider_payment_id_unique
  ON cash_in_operations(provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX cash_in_reconciliation_idx
  ON cash_in_operations(status, updated_at) WHERE status IN ('UNKNOWN', 'PROCESSING');

CREATE TABLE wallet_ledger_entries (
  id UUID PRIMARY KEY,
  operation_id UUID NOT NULL UNIQUE REFERENCES cash_in_operations(id),
  user_id VARCHAR(128) NOT NULL REFERENCES wallets(user_id),
  entry_type VARCHAR(32) NOT NULL CHECK (entry_type = 'CASH_IN'),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  balance_after_minor BIGINT NOT NULL CHECK (balance_after_minor >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE payment_webhook_events (
  provider_event_id VARCHAR(128) PRIMARY KEY,
  operation_id UUID NOT NULL REFERENCES cash_in_operations(id),
  provider_payment_id VARCHAR(128) NOT NULL,
  event_type VARCHAR(32) NOT NULL CHECK (event_type IN ('payment.succeeded', 'payment.failed')),
  occurred_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX payment_webhook_operation_idx ON payment_webhook_events(operation_id, occurred_at DESC);

CREATE TABLE outbox_events (
  id UUID PRIMARY KEY,
  aggregate_id UUID NOT NULL REFERENCES cash_in_operations(id),
  event_type VARCHAR(64) NOT NULL,
  payload JSONB NOT NULL,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (aggregate_id, event_type)
);

-- Standalone simulator table. In production this belongs to the external provider.
CREATE TABLE provider_simulator_payments (
  id VARCHAR(128) PRIMARY KEY,
  idempotency_key UUID NOT NULL UNIQUE,
  operation_id UUID NOT NULL,
  amount_minor BIGINT NOT NULL,
  currency CHAR(3) NOT NULL,
  payment_method VARCHAR(128) NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('succeeded', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
