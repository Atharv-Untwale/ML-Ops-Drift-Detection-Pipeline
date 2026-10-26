import { Router } from "express";
import { pool } from "../db/pool.js";

const router = Router();

// Whitelists: column names are never taken from user input.
const NUMERIC_FEATURES = ["tenure", "MonthlyCharges", "TotalCharges"];
const CATEGORICAL_FEATURES = ["Contract", "InternetService", "PaymentMethod"];

function toInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Optional ?from=<ISO>&to=<ISO>. Defaults to the whole table.
function parseWindow(query) {
  const out = { from: "-infinity", to: "infinity" };
  for (const key of ["from", "to"]) {
    if (query[key] === undefined) continue;
    if (Number.isNaN(Date.parse(query[key]))) {
      return { error: `'${key}' must be an ISO timestamp, e.g. 2026-10-12T06:00:00Z` };
    }
    out[key] = new Date(query[key]).toISOString();
  }
  return out;
}

// GET /api/predictions/recent?limit=20
router.get("/predictions/recent", async (req, res) => {
  const limit = toInt(req.query.limit, 20, 1, 200);
  try {
    const { rows } = await pool.query(
      `SELECT request_id, features, prediction, probability, model_version, created_at
       FROM predictions
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ count: rows.length, predictions: rows });
  } catch (err) {
    console.error("recent predictions failed:", err.message);
    res.status(500).json({ error: "Failed to load predictions" });
  }
});

// GET /api/stats/volume?bucket_seconds=60&minutes=1440
router.get("/stats/volume", async (req, res) => {
  const bucketSeconds = toInt(req.query.bucket_seconds, 60, 1, 86400);
  const minutes = toInt(req.query.minutes, 1440, 1, 525600);
  try {
    const { rows } = await pool.query(
      `SELECT time_bucket(make_interval(secs => $1::double precision), created_at) AS bucket,
              count(*)::int AS total,
              (count(*) FILTER (WHERE prediction IS NULL))::int AS failed,
              (count(*) FILTER (WHERE prediction = 1))::int AS positive
       FROM predictions
       WHERE created_at >= NOW() - make_interval(mins => $2::int)
       GROUP BY bucket
       ORDER BY bucket`,
      [bucketSeconds, minutes]
    );
    res.json({ bucket_seconds: bucketSeconds, minutes, buckets: rows });
  } catch (err) {
    console.error("volume stats failed:", err.message);
    res.status(500).json({ error: "Failed to load volume stats" });
  }
});

// GET /api/stats/features?from=...&to=...
// Summary of the feature distributions inside one time window.
router.get("/stats/features", async (req, res) => {
  const win = parseWindow(req.query);
  if (win.error) return res.status(400).json({ error: win.error });

  try {
    const numericSelect = NUMERIC_FEATURES.map(
      (c) => `avg((features->>'${c}')::numeric) AS "${c}_mean",
              stddev((features->>'${c}')::numeric) AS "${c}_std",
              min((features->>'${c}')::numeric) AS "${c}_min",
              max((features->>'${c}')::numeric) AS "${c}_max"`
    ).join(",\n");

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n, ${numericSelect}
       FROM predictions
       WHERE prediction IS NOT NULL
         AND created_at >= $1::timestamptz AND created_at < $2::timestamptz`,
      [win.from, win.to]
    );
    const row = rows[0];

    const numeric = {};
    for (const c of NUMERIC_FEATURES) {
      const f = (v) => (v === null ? null : Number(Number(v).toFixed(3)));
      numeric[c] = {
        mean: f(row[`${c}_mean`]),
        std: f(row[`${c}_std`]),
        min: f(row[`${c}_min`]),
        max: f(row[`${c}_max`]),
      };
    }

    const categorical = {};
    for (const c of CATEGORICAL_FEATURES) {
      const { rows: counts } = await pool.query(
        `SELECT features->>$1 AS value, count(*)::int AS n
         FROM predictions
         WHERE prediction IS NOT NULL
           AND features->>$1 IS NOT NULL
           AND created_at >= $2::timestamptz AND created_at < $3::timestamptz
         GROUP BY value
         ORDER BY n DESC`,
        [c, win.from, win.to]
      );
      categorical[c] = counts;
    }

    res.json({ window: win, n: row.n, numeric, categorical });
  } catch (err) {
    console.error("feature stats failed:", err.message);
    res.status(500).json({ error: "Failed to load feature stats" });
  }
});

export default router;