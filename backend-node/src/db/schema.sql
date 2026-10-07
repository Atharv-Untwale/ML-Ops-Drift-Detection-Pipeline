CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS predictions (
    id SERIAL,
    request_id UUID NOT NULL DEFAULT gen_random_uuid(),
    features JSONB NOT NULL,
    prediction INTEGER,
    probability DOUBLE PRECISION,
    model_version TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id, created_at)
);

CREATE EXTENSION IF NOT EXISTS pgcrypto;

SELECT create_hypertable('predictions', 'created_at', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_predictions_created_at ON predictions (created_at DESC);