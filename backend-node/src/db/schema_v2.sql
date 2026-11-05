-- Schema v2: monitoring, retraining and label tables (SDS Tables 3.3 to 3.8)
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS detector_configs (
    detector_name TEXT PRIMARY KEY,
    family        TEXT NOT NULL CHECK (family IN ('statistical', 'distance', 'ml_based', 'streaming')),
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    threshold     DOUBLE PRECISION NOT NULL,
    params        JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS detection_runs (
    run_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    window_start   TIMESTAMPTZ NOT NULL,
    window_end     TIMESTAMPTZ NOT NULL,
    reference_size INTEGER NOT NULL,
    current_size   INTEGER NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_detection_runs_created ON detection_runs (created_at DESC);

CREATE TABLE IF NOT EXISTS drift_scores (
    score_id       BIGSERIAL PRIMARY KEY,
    run_id         UUID NOT NULL REFERENCES detection_runs (run_id) ON DELETE CASCADE,
    detector_name  TEXT NOT NULL REFERENCES detector_configs (detector_name),
    feature_name   TEXT,
    score          DOUBLE PRECISION NOT NULL,
    drift_detected BOOLEAN NOT NULL,
    compute_ms     DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_drift_scores_run ON drift_scores (run_id);
CREATE INDEX IF NOT EXISTS idx_drift_scores_detector ON drift_scores (detector_name, run_id);

CREATE TABLE IF NOT EXISTS retrain_events (
    event_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    triggered_by_score_id BIGINT REFERENCES drift_scores (score_id) ON DELETE SET NULL,
    trigger_type          TEXT NOT NULL CHECK (trigger_type IN ('auto', 'manual')),
    status                TEXT NOT NULL CHECK (status IN ('running', 'promoted', 'rejected', 'skipped', 'failed')),
    outcome               TEXT,
    started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_retrain_events_started ON retrain_events (started_at DESC);

CREATE TABLE IF NOT EXISTS model_versions (
    model_version     TEXT PRIMARY KEY,
    retrain_event_id  UUID REFERENCES retrain_events (event_id) ON DELETE SET NULL,
    mlflow_run_id     TEXT,
    stage             TEXT NOT NULL CHECK (stage IN ('shadow', 'production', 'archived')),
    validation_metric DOUBLE PRECISION,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- predictions is a hypertable, so request_id cannot be a foreign key target.
-- labels links to predictions by value (a logical reference).
CREATE TABLE IF NOT EXISTS labels (
    label_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id   UUID NOT NULL UNIQUE,
    actual_churn INTEGER NOT NULL CHECK (actual_churn IN (0, 1)),
    labelled_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Default detectors. Thresholds are starting values (TBD-6) and can be edited later.
-- adwin and ddm raise a 0/1 alarm, so their threshold is 1.
INSERT INTO detector_configs (detector_name, family, threshold, params) VALUES
    ('ks_test',           'statistical', 0.15, '{}'),
    ('psi',               'statistical', 0.25, '{"bins": 10}'),
    ('js_divergence',     'distance',    0.08, '{}'),
    ('wasserstein',       'distance',    0.12, '{}'),
    ('domain_classifier', 'ml_based',    0.70, '{"metric": "auc"}'),
    ('adwin',             'streaming',   1.0,  '{"delta": 0.002}'),
    ('ddm',               'streaming',   1.0,  '{}')
ON CONFLICT (detector_name) DO NOTHING;