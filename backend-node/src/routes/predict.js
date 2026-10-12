import { Router } from "express";
import axios from "axios";
import { config } from "../config.js";
import { pool } from "../db/pool.js";

const router = Router();

const INSERT_SQL = `
  INSERT INTO predictions (features, prediction, probability, model_version)
  VALUES ($1, $2, $3, $4)
  RETURNING request_id, created_at
`;

router.post("/", async (req, res) => {
  const { features } = req.body;

  if (!features || typeof features !== "object" || Array.isArray(features)) {
    return res
      .status(400)
      .json({ error: "Body must contain a 'features' object" });
  }

  let mlResult;
  try {
    const response = await axios.post(
      `${config.mlServiceUrl}/predict`,
      { features },
      { timeout: 5000 }
    );
    mlResult = response.data;
  } catch (err) {
    // Still keep a record of the request, with empty prediction fields.
    try {
      await pool.query(INSERT_SQL, [JSON.stringify(features), null, null, null]);
    } catch (dbErr) {
      console.error("Failed to log failed request:", dbErr.message);
    }

    if (err.response) {
      return res.status(502).json({
        error: "ML service returned an error",
        details: err.response.data,
      });
    }
    return res.status(503).json({ error: "ML service unreachable or timed out" });
  }

  try {
    const { rows } = await pool.query(INSERT_SQL, [
      JSON.stringify(features),
      mlResult.prediction,
      mlResult.probability,
      mlResult.model_version,
    ]);

    res.json({
      request_id: rows[0].request_id,
      prediction: mlResult.prediction,
      probability: mlResult.probability,
      model_version: mlResult.model_version,
      created_at: rows[0].created_at,
    });
  } catch (dbErr) {
    console.error("Failed to log prediction:", dbErr.message);
    res.status(500).json({ error: "Prediction succeeded but logging failed" });
  }
});

export default router;