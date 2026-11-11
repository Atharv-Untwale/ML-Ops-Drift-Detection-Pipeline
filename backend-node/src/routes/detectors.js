import crypto from "crypto";
import { Router } from "express";
import { pool } from "../db/pool.js";

const router = Router();

const NAME_RE = /^[a-z0-9_]+$/;
const ALLOWED_FIELDS = ["enabled", "threshold", "params"];
const COLUMNS = "detector_name, family, enabled, threshold, params, updated_at";

// Changing settings needs the shared key in the x-api-key header.
// If ADMIN_API_KEY is not set on the server, changes are switched off.
function requireAdminKey(req, res, next) {
  const expected = process.env.ADMIN_API_KEY;
  if (!expected) {
    return res.status(503).json({ error: "Admin actions are disabled: ADMIN_API_KEY is not set on the server" });
  }
  const given = Buffer.from(req.get("x-api-key") ?? "");
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.status(401).json({ error: "Missing or invalid x-api-key header" });
  }
  next();
}

// GET /api/detectors
router.get("/detectors", async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ${COLUMNS} FROM detector_configs ORDER BY detector_name`);
    res.json({ detectors: rows });
  } catch (err) {
    console.error("list detectors failed:", err.message);
    res.status(500).json({ error: "Failed to load detectors" });
  }
});

// PATCH /api/detectors/:name
// Body: any of { "enabled": true, "threshold": 0.2, "params": { ... } }
router.patch("/detectors/:name", requireAdminKey, async (req, res) => {
  const name = req.params.name;
  if (!NAME_RE.test(name)) return res.status(400).json({ error: "Invalid detector name" });

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
  if (!body || Object.keys(body).length === 0) {
    return res.status(400).json({ error: "Send at least one of: enabled, threshold, params" });
  }
  const unknown = Object.keys(body).filter((k) => !ALLOWED_FIELDS.includes(k));
  if (unknown.length) return res.status(400).json({ error: `Unknown field(s): ${unknown.join(", ")}` });

  try {
    const { rows: found } = await pool.query("SELECT family FROM detector_configs WHERE detector_name = $1", [name]);
    if (found.length === 0) return res.status(404).json({ error: `Unknown detector: ${name}` });
    const family = found[0].family;

    if ("enabled" in body && typeof body.enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be true or false" });
    }
    if ("threshold" in body) {
      const t = body.threshold;
      if (typeof t !== "number" || !Number.isFinite(t)) {
        return res.status(400).json({ error: "threshold must be a number" });
      }
      // The domain classifier reports an AUC, so its threshold sits between 0.5 and 1.
      if (family === "ml_based" ? !(t > 0.5 && t <= 1) : !(t > 0 && t <= 1000)) {
        return res.status(400).json({
          error: family === "ml_based" ? "threshold for an AUC detector must be above 0.5 and at most 1" : "threshold must be above 0 and at most 1000",
        });
      }
    }
    let paramsJson = null;
    if ("params" in body) {
      const p = body.params;
      if (p === null || typeof p !== "object" || Array.isArray(p)) {
        return res.status(400).json({ error: "params must be a JSON object" });
      }
      paramsJson = JSON.stringify(p);
      if (paramsJson.length > 2000) return res.status(400).json({ error: "params is too large (2000 characters max)" });
    }

    const { rows } = await pool.query(
      `UPDATE detector_configs
       SET enabled = COALESCE($2, enabled),
           threshold = COALESCE($3, threshold),
           params = COALESCE($4::jsonb, params),
           updated_at = NOW()
       WHERE detector_name = $1
       RETURNING ${COLUMNS}`,
      [name, "enabled" in body ? body.enabled : null, "threshold" in body ? body.threshold : null, paramsJson]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error("update detector failed:", err.message);
    res.status(500).json({ error: "Failed to update detector" });
  }
});

export default router;