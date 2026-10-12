import { Router } from "express";

const router = Router();

// Temporary stand-in for the Python ML service.
// Delete this once your teammate's /predict endpoint is live.
router.post("/predict", (req, res) => {
  const { features } = req.body;

  if (!features || typeof features !== "object") {
    return res.status(400).json({ error: "Missing 'features' object in request body" });
  }

  const probability = Math.random();
  const prediction = probability > 0.5 ? 1 : 0;

  res.json({
    prediction,
    probability: Number(probability.toFixed(4)),
    model_version: "mock-v0",
  });
});

export default router;