import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { testConnection } from "./db/pool.js";
import predictRouter from "./routes/predict.js";
import mockMlRouter from "./routes/mockMl.js";

const app = express();

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use("/predict", predictRouter);

// Temporary mock ML service, mounted under /mock-ml
app.use("/mock-ml", mockMlRouter);

async function start() {
  await testConnection();

  app.listen(config.port, () => {
    console.log(`🚀 Server running on http://localhost:${config.port}`);
  });
}

start().catch((err) => {
  console.error("❌ Failed to start server:", err);
  process.exit(1);
});