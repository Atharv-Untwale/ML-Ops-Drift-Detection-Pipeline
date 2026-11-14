// All calls to the Node.js backend. The base URL comes from VITE_API_URL.
const BASE = (import.meta.env.VITE_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

async function get(path, params = {}, signal) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new Error(`Cannot reach the API at ${BASE}. Is the backend running?`);
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body.error) msg = body.error;
    } catch {
      /* keep the status text */
    }
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  driftOverview: (minutes, signal) => get("/api/drift/overview", { minutes }, signal),
  driftScores: (minutes, signal) => get("/api/drift/scores", { minutes }, signal),
  driftFeatures: (minutes, detector, signal) => get("/api/drift/features", { minutes, detector }, signal),
  retrainEvents: (minutes, signal) => get("/api/retrain/events", { minutes }, signal),
  modelVersions: (signal) => get("/api/models/versions", {}, signal),
  performance: (minutes, bucketHours, signal) =>
    get("/api/performance", { minutes, bucket_hours: bucketHours }, signal),
  detectors: (signal) => get("/api/detectors", {}, signal),
};
