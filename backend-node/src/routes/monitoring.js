import { Router } from "express";
import { pool } from "../db/pool.js";

const router = Router();

const DEFAULT_MINUTES = 10080; // 7 days
const MAX_MINUTES = 43200; // 30 days

function clampInt(value, fallback, lo, hi) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

// Drift score divided by the detector's threshold. 1 or more means "alarming".
// The domain classifier reports an AUC, where 0.5 means no drift, so it is rescaled.
function ratioOf(family, score, threshold) {
  if (score === null || score === undefined) return null;
  const r = family === "ml_based" ? (score - 0.5) / (threshold - 0.5) : score / threshold;
  return Number(r.toFixed(3));
}

const round = (v, d = 4) => (v === null || v === undefined ? null : Number(Number(v).toFixed(d)));

// GET /api/drift/overview?minutes=10080
// One row per configured detector: latest score, peak score and alarm count in the window.
router.get("/drift/overview", async (req, res) => {
  const minutes = clampInt(req.query.minutes, DEFAULT_MINUTES, 1, MAX_MINUTES);
  try {
    const { rows } = await pool.query(
      `WITH win AS (
         SELECT r.created_at, s.detector_name, s.score, s.drift_detected
         FROM drift_scores s JOIN detection_runs r USING (run_id)
         WHERE s.feature_name IS NULL
           AND r.created_at >= NOW() - make_interval(mins => $1::int)
       ),
       latest AS (
         SELECT DISTINCT ON (detector_name) detector_name, score, drift_detected, created_at
         FROM win ORDER BY detector_name, created_at DESC
       ),
       agg AS (
         SELECT detector_name, max(score) AS peak_score,
                (count(*) FILTER (WHERE drift_detected))::int AS alarm_count, count(*)::int AS runs
         FROM win GROUP BY detector_name
       )
       SELECT c.detector_name, c.family, c.enabled, c.threshold,
              l.score AS latest_score, l.drift_detected AS latest_alarm, l.created_at AS latest_at,
              a.peak_score, COALESCE(a.alarm_count, 0) AS alarm_count, COALESCE(a.runs, 0) AS runs
       FROM detector_configs c
       LEFT JOIN latest l USING (detector_name)
       LEFT JOIN agg a USING (detector_name)
       ORDER BY c.detector_name`,
      [minutes]
    );
    const { rows: last } = await pool.query("SELECT max(created_at) AS last_run_at FROM detection_runs");

    const detectors = rows.map((r) => ({
      detector_name: r.detector_name,
      family: r.family,
      enabled: r.enabled,
      threshold: r.threshold,
      latest_score: round(r.latest_score),
      latest_ratio: ratioOf(r.family, r.latest_score, r.threshold),
      latest_alarm: r.latest_alarm,
      peak_score: round(r.peak_score),
      peak_ratio: ratioOf(r.family, r.peak_score, r.threshold),
      alarm_count: r.alarm_count,
      runs: r.runs,
    }));

    res.json({
      minutes,
      last_run_at: last[0].last_run_at,
      alarming_now: detectors.filter((d) => d.latest_alarm === true).length,
      detectors_with_data: detectors.filter((d) => d.runs > 0).length,
      detectors,
    });
  } catch (err) {
    console.error("drift overview failed:", err.message);
    res.status(500).json({ error: "Failed to load drift overview" });
  }
});

// GET /api/drift/scores?minutes=10080&detector=ks_test,psi
// Time series of each detector's overall score, ready for a line chart.
router.get("/drift/scores", async (req, res) => {
  const minutes = clampInt(req.query.minutes, DEFAULT_MINUTES, 1, MAX_MINUTES);
  let names = null;
  if (req.query.detector !== undefined) {
    names = String(req.query.detector).split(",").map((s) => s.trim()).filter(Boolean);
    if (names.length === 0 || names.some((n) => !/^[a-z0-9_]+$/.test(n))) {
      return res.status(400).json({ error: "detector must be a comma-separated list of detector names" });
    }
  }
  try {
    const { rows } = await pool.query(
      `SELECT r.created_at AS t, s.detector_name, s.score, s.drift_detected
       FROM drift_scores s JOIN detection_runs r USING (run_id)
       WHERE s.feature_name IS NULL
         AND r.created_at >= NOW() - make_interval(mins => $1::int)
         AND ($2::text[] IS NULL OR s.detector_name = ANY($2::text[]))
       ORDER BY r.created_at`,
      [minutes, names]
    );
    const { rows: cfg } = await pool.query("SELECT detector_name, family, threshold FROM detector_configs");
    const meta = Object.fromEntries(cfg.map((c) => [c.detector_name, c]));

    const out = {};
    for (const r of rows) {
      const m = meta[r.detector_name];
      if (!out[r.detector_name]) out[r.detector_name] = { family: m?.family, threshold: m?.threshold, points: [] };
      out[r.detector_name].points.push({
        t: r.t,
        score: round(r.score),
        ratio: m ? ratioOf(m.family, r.score, m.threshold) : null,
        alarm: r.drift_detected,
      });
    }
    res.json({ minutes, detectors: out });
  } catch (err) {
    console.error("drift scores failed:", err.message);
    res.status(500).json({ error: "Failed to load drift scores" });
  }
});

// GET /api/drift/features?minutes=10080&detector=ks_test
// Per-feature scores for one detector: peak and latest value in the window.
router.get("/drift/features", async (req, res) => {
  const minutes = clampInt(req.query.minutes, DEFAULT_MINUTES, 1, MAX_MINUTES);
  const detector = req.query.detector === undefined ? "ks_test" : String(req.query.detector);
  if (!/^[a-z0-9_]+$/.test(detector)) return res.status(400).json({ error: "Invalid detector name" });
  try {
    const { rows: cfg } = await pool.query("SELECT threshold FROM detector_configs WHERE detector_name = $1", [detector]);
    if (cfg.length === 0) return res.status(404).json({ error: `Unknown detector: ${detector}` });

    const { rows } = await pool.query(
      `WITH win AS (
         SELECT s.feature_name, s.score, r.created_at
         FROM drift_scores s JOIN detection_runs r USING (run_id)
         WHERE s.detector_name = $2 AND s.feature_name IS NOT NULL
           AND r.created_at >= NOW() - make_interval(mins => $1::int)
       ),
       latest AS (SELECT DISTINCT ON (feature_name) feature_name, score FROM win ORDER BY feature_name, created_at DESC),
       peak AS (SELECT feature_name, max(score) AS peak FROM win GROUP BY feature_name)
       SELECT p.feature_name, p.peak, l.score AS latest
       FROM peak p JOIN latest l USING (feature_name)
       ORDER BY p.peak DESC`,
      [minutes, detector]
    );
    res.json({
      minutes,
      detector,
      threshold: cfg[0].threshold,
      features: rows.map((r) => ({ feature_name: r.feature_name, peak: round(r.peak), latest: round(r.latest) })),
    });
  } catch (err) {
    console.error("feature drift failed:", err.message);
    res.status(500).json({ error: "Failed to load feature drift" });
  }
});

// GET /api/retrain/events?minutes=10080&limit=50
router.get("/retrain/events", async (req, res) => {
  const minutes = clampInt(req.query.minutes, DEFAULT_MINUTES, 1, MAX_MINUTES);
  const limit = clampInt(req.query.limit, 50, 1, 200);
  try {
    const { rows } = await pool.query(
      `SELECT e.event_id, e.trigger_type, e.status, e.outcome, e.started_at, e.finished_at,
              (EXTRACT(EPOCH FROM (e.finished_at - e.started_at)))::int AS duration_seconds,
              s.detector_name, s.feature_name, s.score AS trigger_score, c.threshold AS trigger_threshold,
              m.model_version, m.validation_metric
       FROM retrain_events e
       LEFT JOIN drift_scores s ON s.score_id = e.triggered_by_score_id
       LEFT JOIN detector_configs c ON c.detector_name = s.detector_name
       LEFT JOIN model_versions m ON m.retrain_event_id = e.event_id
       WHERE e.started_at >= NOW() - make_interval(mins => $1::int)
       ORDER BY e.started_at DESC
       LIMIT $2`,
      [minutes, limit]
    );
    const summary = { total: rows.length, promoted: 0, rejected: 0, skipped: 0, failed: 0, running: 0 };
    for (const r of rows) summary[r.status] += 1;
    res.json({
      minutes,
      summary,
      events: rows.map((r) => ({ ...r, trigger_score: round(r.trigger_score), validation_metric: round(r.validation_metric) })),
    });
  } catch (err) {
    console.error("retrain events failed:", err.message);
    res.status(500).json({ error: "Failed to load retrain events" });
  }
});

// GET /api/models/versions
router.get("/models/versions", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.model_version, m.stage, m.validation_metric, m.mlflow_run_id, m.created_at,
              m.retrain_event_id, e.status AS event_status, e.trigger_type
       FROM model_versions m
       LEFT JOIN retrain_events e ON e.event_id = m.retrain_event_id
       ORDER BY m.created_at DESC`
    );
    const versions = rows.map((r) => ({ ...r, validation_metric: round(r.validation_metric) }));
    res.json({
      production: versions.find((v) => v.stage === "production") ?? null,
      shadow: versions.find((v) => v.stage === "shadow") ?? null,
      versions,
    });
  } catch (err) {
    console.error("model versions failed:", err.message);
    res.status(500).json({ error: "Failed to load model versions" });
  }
});

// GET /api/performance?minutes=10080&bucket_hours=3
// Accuracy, precision, recall and F1 per time bucket, using only predictions that have a label.
router.get("/performance", async (req, res) => {
  const minutes = clampInt(req.query.minutes, DEFAULT_MINUTES, 1, MAX_MINUTES);
  const bucketHours = clampInt(req.query.bucket_hours, 3, 1, 168);
  try {
    const { rows } = await pool.query(
      `SELECT date_bin(make_interval(hours => $2::int), p.created_at, TIMESTAMPTZ '2000-01-01') AS bucket,
              count(*)::int AS requests,
              (count(*) FILTER (WHERE p.prediction = 1))::int AS predicted_positive,
              count(l.request_id)::int AS labelled,
              (count(*) FILTER (WHERE p.prediction = 1 AND l.actual_churn = 1))::int AS tp,
              (count(*) FILTER (WHERE p.prediction = 1 AND l.actual_churn = 0))::int AS fp,
              (count(*) FILTER (WHERE p.prediction = 0 AND l.actual_churn = 1))::int AS fn,
              (count(*) FILTER (WHERE p.prediction = 0 AND l.actual_churn = 0))::int AS tn
       FROM predictions p
       LEFT JOIN labels l ON l.request_id = p.request_id
       WHERE p.prediction IS NOT NULL
         AND p.created_at >= NOW() - make_interval(mins => $1::int)
       GROUP BY bucket
       ORDER BY bucket`,
      [minutes, bucketHours]
    );

    const metrics = ({ tp, fp, fn, tn }) => {
      const n = tp + fp + fn + tn;
      if (n === 0) return { accuracy: null, precision: null, recall: null, f1: null };
      const precision = tp + fp === 0 ? null : tp / (tp + fp);
      const recall = tp + fn === 0 ? null : tp / (tp + fn);
      const f1 = precision === null || recall === null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall);
      return { accuracy: round((tp + tn) / n), precision: round(precision), recall: round(recall), f1: round(f1) };
    };

    const total = { tp: 0, fp: 0, fn: 0, tn: 0, requests: 0, predicted_positive: 0, labelled: 0 };
    const buckets = rows.map((r) => {
      for (const k of Object.keys(total)) total[k] += r[k];
      return {
        bucket: r.bucket,
        requests: r.requests,
        labelled: r.labelled,
        positive_rate: round(r.predicted_positive / r.requests),
        ...metrics(r),
      };
    });

    res.json({
      minutes,
      bucket_hours: bucketHours,
      totals: {
        requests: total.requests,
        labelled: total.labelled,
        label_coverage: total.requests === 0 ? null : round(total.labelled / total.requests),
        positive_rate: total.requests === 0 ? null : round(total.predicted_positive / total.requests),
        confusion: { tp: total.tp, fp: total.fp, fn: total.fn, tn: total.tn },
        ...metrics(total),
      },
      buckets,
    });
  } catch (err) {
    console.error("performance failed:", err.message);
    res.status(500).json({ error: "Failed to load performance" });
  }
});

export default router;