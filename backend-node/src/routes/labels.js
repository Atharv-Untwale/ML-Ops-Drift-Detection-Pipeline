import { Router } from "express";
import { pool } from "../db/pool.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BATCH = 1000;

// POST /api/labels
// Body: { "labels": [ { "request_id": "<uuid>", "actual_churn": 0 }, ... ] }
//   or a single { "request_id": "<uuid>", "actual_churn": 1 }
// Sending a label again for the same request_id overwrites the earlier one.
router.post("/labels", async (req, res) => {
  const body = req.body ?? {};
  const items = Array.isArray(body.labels)
    ? body.labels
    : body.request_id !== undefined
    ? [body]
    : null;

  if (!items || items.length === 0) {
    return res.status(400).json({
      error: "Send { labels: [{ request_id, actual_churn }] } or a single { request_id, actual_churn }",
    });
  }
  if (items.length > MAX_BATCH) {
    return res.status(400).json({ error: `At most ${MAX_BATCH} labels per request` });
  }

  // Validate and de-duplicate (a duplicate id inside one insert would make Postgres fail).
  const byId = new Map();
  for (const [i, item] of items.entries()) {
    const id = typeof item?.request_id === "string" ? item.request_id.toLowerCase() : null;
    if (!id || !UUID_RE.test(id)) {
      return res.status(400).json({ error: `labels[${i}].request_id must be a UUID` });
    }
    if (item.actual_churn !== 0 && item.actual_churn !== 1) {
      return res.status(400).json({ error: `labels[${i}].actual_churn must be 0 or 1` });
    }
    byId.set(id, item.actual_churn);
  }

  const ids = [...byId.keys()];
  const values = ids.map((id) => byId.get(id));

  try {
    // Only labels whose prediction exists are stored.
    const { rows } = await pool.query(
      `INSERT INTO labels (request_id, actual_churn)
       SELECT t.request_id, t.actual_churn
       FROM unnest($1::uuid[], $2::int[]) AS t(request_id, actual_churn)
       WHERE EXISTS (SELECT 1 FROM predictions p WHERE p.request_id = t.request_id)
       ON CONFLICT (request_id)
       DO UPDATE SET actual_churn = EXCLUDED.actual_churn, labelled_at = NOW()
       RETURNING request_id`,
      [ids, values]
    );

    const stored = new Set(rows.map((r) => r.request_id));
    const unmatched = ids.filter((id) => !stored.has(id));

    res.json({
      received: ids.length,
      stored: stored.size,
      unmatched_count: unmatched.length,
      unmatched: unmatched.slice(0, 20),
    });
  } catch (err) {
    console.error("store labels failed:", err.message);
    res.status(500).json({ error: "Failed to store labels" });
  }
});

// GET /api/labels/coverage?minutes=10080
// Share of recent successful predictions that already have a true label.
router.get("/labels/coverage", async (req, res) => {
  const n = Number.parseInt(req.query.minutes, 10);
  const minutes = Number.isNaN(n) ? 10080 : Math.min(525600, Math.max(1, n));
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS predictions,
              count(l.request_id)::int AS labelled
       FROM predictions p
       LEFT JOIN labels l ON l.request_id = p.request_id
       WHERE p.prediction IS NOT NULL
         AND p.created_at >= NOW() - make_interval(mins => $1::int)`,
      [minutes]
    );
    const { predictions, labelled } = rows[0];
    res.json({
      minutes,
      predictions,
      labelled,
      coverage: predictions === 0 ? null : Number((labelled / predictions).toFixed(4)),
    });
  } catch (err) {
    console.error("label coverage failed:", err.message);
    res.status(500).json({ error: "Failed to load label coverage" });
  }
});

export default router;