import crypto from "crypto";
import readline from "readline";

// Simulates the drift detectors writing results in real time, so the dashboard
// (especially the 24h view) has live data to react to.
//
// Run from backend-node:
//   node scripts/live-detector.js
//
// Keys while it runs:
//   d  start drift      (detectors climb above their thresholds, a retraining run starts)
//   c  clear drift      (scores fall back to normal)
//   q  quit
//
// Options:
//   --interval 10         seconds between runs
//   --backfill 24         hours of calm history to write first (default 24, --no-backfill to skip)
//   --retrain-seconds 45  how long a simulated retraining takes before the new model is promoted
//   --drift-after 30      start drift automatically after this many seconds (for terminals without key input)
//   --duration 300        stop automatically after this many seconds
//
// This writes demo data. To wipe it, run: node scripts/seed-monitoring.js --reset

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);
const num = (name, def, min) => {
  const v = Number(opt(name, def));
  if (!Number.isFinite(v) || v < min) {
    console.error(`--${name} must be a number of at least ${min}`);
    process.exit(1);
  }
  return v;
};

const INTERVAL_S = num("interval", 10, 1);
const BACKFILL_H = flag("no-backfill") ? 0 : num("backfill", 24, 0);
const RETRAIN_S = num("retrain-seconds", 45, 1);
const DRIFT_AFTER_S = opt("drift-after", null) === null ? null : num("drift-after", 0, 0);
const DURATION_S = opt("duration", null) === null ? null : num("duration", 0, 1);

const DET = [
  { name: "ks_test", peak: 2.7, kd: 1, ms: [3, 6] },
  { name: "psi", peak: 2.1, kd: 2, ms: [4, 8] },
  { name: "js_divergence", peak: 1.7, kd: 3, ms: [6, 10] },
  { name: "wasserstein", peak: 2.9, kd: 1, ms: [8, 14] },
  { name: "domain_classifier", peak: 2.3, kd: 4, ms: [600, 900] },
];
const FEATURES = ["MonthlyCharges", "TotalCharges", "tenure", "Contract", "InternetService", "PaymentMethod", "SeniorCitizen", "gender"];
const between = (a, b) => a + Math.random() * (b - a);

// ---- state ----
let mode = "calm"; // calm | drift | recovering
let step = 0; // run counter, drives the slow wave in the baseline
let driftK = 0; // runs since drift started
let recoverK = 0; // runs since promotion
let lastRatio = {}; // ratio of each detector when drift ended
let active = null; // { id, startedAt, trigger } retraining run in progress
let skippedFor = new Set(); // detectors already logged as skipped in this drift episode
let stopping = false;
let timer = null;

const base = (d, i) => 0.28 + 0.07 * Math.sin(i / 7 + d.kd) + between(-0.06, 0.06);

function ratioFor(d) {
  if (mode === "drift") {
    const k = driftK;
    if (k < d.kd) return 0.3 + 0.72 * (k / d.kd) + between(-0.03, 0.03);
    return Math.max(1.06, 1.08 + (d.peak - 1.08) * (1 - Math.exp(-(k - d.kd) / 4)) + between(-0.08, 0.08));
  }
  if (mode === "recovering") {
    return Math.max(0.05, base(d, step) + ((lastRatio[d.name] ?? 0.3) - 0.3) * Math.exp(-recoverK / 2.2));
  }
  return Math.max(0.05, base(d, step));
}

// ratios: { detector_name: ratio }, cfg: { detector_name: { threshold, enabled } }
function buildRows(ratios, cfg) {
  const rows = [];
  for (const d of DET) {
    const c = cfg[d.name];
    if (!c || !c.enabled) continue;
    const th = c.threshold;
    const r = ratios[d.name];
    const ms = between(d.ms[0], d.ms[1]);
    if (d.name === "ks_test") {
      const per = {};
      for (const f of FEATURES) {
        per[f] = f === "MonthlyCharges" ? r * th : f === "TotalCharges" ? 0.88 * r * th : between(0.03, 0.06);
      }
      for (const f of FEATURES) rows.push({ det: d.name, feat: f, score: per[f], hit: per[f] > th, ms: ms / FEATURES.length });
      const agg = Math.max(...Object.values(per));
      rows.push({ det: d.name, feat: null, score: agg, hit: agg > th, ms });
    } else if (d.name === "domain_classifier") {
      const auc = Math.min(0.99, 0.5 + r * (th - 0.5));
      rows.push({ det: d.name, feat: null, score: auc, hit: auc > th, ms });
    } else {
      rows.push({ det: d.name, feat: null, score: r * th, hit: r * th > th, ms });
    }
  }
  return rows;
}

let pool;

async function insertRuns(runs) {
  await pool.query(
    `INSERT INTO detection_runs (run_id, window_start, window_end, reference_size, current_size, created_at)
     SELECT * FROM unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[], $4::int[], $5::int[], $6::timestamptz[])`,
    [runs.map((r) => r.id), runs.map((r) => new Date(r.at.getTime() - 2 * 3600 * 1000)), runs.map((r) => r.at), runs.map(() => 2000), runs.map(() => 200), runs.map((r) => r.at)]
  );
  const flat = runs.flatMap((r) => r.rows.map((x) => ({ ...x, run: r.id })));
  const out = [];
  for (let s = 0; s < flat.length; s += 2000) {
    const part = flat.slice(s, s + 2000);
    const { rows } = await pool.query(
      `INSERT INTO drift_scores (run_id, detector_name, feature_name, score, drift_detected, compute_ms)
       SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::float8[], $5::boolean[], $6::float8[])
       RETURNING score_id, detector_name, feature_name`,
      [part.map((x) => x.run), part.map((x) => x.det), part.map((x) => x.feat), part.map((x) => x.score), part.map((x) => x.hit), part.map((x) => x.ms)]
    );
    out.push(...rows);
  }
  return out;
}

async function loadConfig() {
  const { rows } = await pool.query("SELECT detector_name, threshold, enabled FROM detector_configs");
  return Object.fromEntries(rows.map((r) => [r.detector_name, { threshold: r.threshold, enabled: r.enabled }]));
}

async function backfill(cfg) {
  const stepMin = 10;
  const n = Math.floor((BACKFILL_H * 60) / stepMin);
  if (n === 0) return;
  const runs = [];
  for (let k = n; k >= 1; k--) {
    const ratios = Object.fromEntries(DET.map((d) => [d.name, Math.max(0.05, base(d, -k))]));
    runs.push({ id: crypto.randomUUID(), at: new Date(Date.now() - k * stepMin * 60000), rows: buildRows(ratios, cfg) });
  }
  await insertRuns(runs);
  console.log(`Wrote ${n} calm runs covering the last ${BACKFILL_H} hours.`);
}

async function nextVersion() {
  const { rows } = await pool.query("SELECT model_version FROM model_versions");
  const nums = rows.map((r) => /^v(\d+)$/.exec(r.model_version)).filter(Boolean).map((m) => Number(m[1]));
  return `v${(nums.length ? Math.max(...nums) : 1) + 1}`;
}

async function finishRetrain() {
  const ev = active;
  active = null;
  const promoted = mode === "drift";
  if (promoted) {
    const version = await nextVersion();
    await pool.query("UPDATE model_versions SET stage = 'archived' WHERE stage = 'production'");
    await pool.query(
      `INSERT INTO model_versions (model_version, retrain_event_id, stage, validation_metric) VALUES ($1, $2, 'production', $3)`,
      [version, ev.id, Number(between(0.62, 0.7).toFixed(3))]
    );
    await pool.query("UPDATE retrain_events SET status = 'promoted', outcome = $2, finished_at = NOW() WHERE event_id = $1", [
      ev.id,
      `candidate beat production on held-out data, promoted ${version}`,
    ]);
    for (const d of DET) lastRatio[d.name] = ratioFor(d);
    mode = "recovering";
    recoverK = 0;
    console.log(`  >> retraining finished: ${version} promoted, scores will recover`);
  } else {
    await pool.query("UPDATE retrain_events SET status = 'rejected', outcome = 'drift cleared before retraining finished, nothing promoted', finished_at = NOW() WHERE event_id = $1", [ev.id]);
    console.log("  >> retraining finished: drift had cleared, candidate rejected");
  }
}

async function tick() {
  const cfg = await loadConfig();
  const ratios = Object.fromEntries(DET.map((d) => [d.name, ratioFor(d)]));
  const rows = buildRows(ratios, cfg);
  const run = { id: crypto.randomUUID(), at: new Date(), rows };
  const ids = await insertRuns([run]);

  const alarming = [...new Set(rows.filter((r) => r.feat === null && r.hit).map((r) => r.det))];
  const enabledCount = DET.filter((d) => cfg[d.name]?.enabled).length;

  // The first alarm starts a retraining run. Later alarms from other detectors are logged as skipped.
  for (const det of alarming) {
    const scoreId = ids.find((x) => x.detector_name === det && x.feature_name === null)?.score_id ?? null;
    if (!active && mode === "drift" && skippedFor.size === 0 && !skippedFor.has("started")) {
      const { rows: ins } = await pool.query(
        `INSERT INTO retrain_events (triggered_by_score_id, trigger_type, status, outcome) VALUES ($1, 'auto', 'running', 'retraining started') RETURNING event_id`,
        [scoreId]
      );
      active = { id: ins[0].event_id, startedAt: Date.now(), trigger: det };
      skippedFor.add("started");
      console.log(`  >> ${det} crossed its threshold: retraining started (about ${RETRAIN_S} s)`);
    } else if (active && det !== active.trigger && !skippedFor.has("skipped")) {
      skippedFor.add("skipped");
      await pool.query(
        `INSERT INTO retrain_events (triggered_by_score_id, trigger_type, status, outcome, finished_at) VALUES ($1, 'auto', 'skipped', 'retraining already pending', NOW())`,
        [scoreId]
      );
    }
  }

  const stamp = new Date().toTimeString().slice(0, 8);
  const pretty = DET.filter((d) => cfg[d.name]?.enabled).map((d) => `${d.name.split("_")[0].slice(0, 4)} ${ratios[d.name].toFixed(2)}x`).join("  ");
  console.log(`${stamp}  ${mode.padEnd(10)} ${pretty}   alarming ${alarming.length}/${enabledCount}`);

  step += 1;
  if (mode === "drift") driftK += 1;
  if (mode === "recovering") {
    recoverK += 1;
    if (recoverK > 14) {
      mode = "calm";
      skippedFor = new Set();
      console.log("  >> back to normal");
    }
  }
  if (active && Date.now() - active.startedAt >= RETRAIN_S * 1000) await finishRetrain();
}

function startDrift() {
  if (mode !== "calm") {
    console.log(`  (already ${mode}, wait until it is back to normal)`);
    return;
  }
  mode = "drift";
  driftK = 0;
  skippedFor = new Set();
  console.log("  >> drift started");
}

function clearDrift() {
  if (mode !== "drift") return;
  for (const d of DET) lastRatio[d.name] = ratioFor(d);
  mode = "recovering";
  recoverK = 0;
  console.log("  >> drift cleared");
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  try {
    if (active) {
      await pool.query("UPDATE retrain_events SET status = 'failed', outcome = 'live simulator stopped before retraining finished', finished_at = NOW() WHERE event_id = $1", [active.id]);
    }
  } finally {
    await pool.end();
    console.log("Stopped.");
    process.exit(0);
  }
}

async function loop() {
  if (stopping) return;
  try {
    await tick();
  } catch (err) {
    console.error("Run failed:", err.message);
  }
  timer = setTimeout(loop, INTERVAL_S * 1000);
}

async function main() {
  ({ pool } = await import("../src/db/pool.js"));
  const cfg = await loadConfig();
  if (!DET.every((d) => d.name in cfg)) {
    console.error("detector_configs is missing rows. Run schema_v2.sql first.");
    process.exit(1);
  }
  if (BACKFILL_H > 0) await backfill(cfg);

  console.log(`Writing one detection run every ${INTERVAL_S} s. Open the dashboard and pick the 24h range.`);
  if (process.stdin.isTTY) {
    console.log("Keys: d = start drift, c = clear drift, q = quit");
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on("keypress", (str, key) => {
      if (key.ctrl && key.name === "c") shutdown();
      else if (key.name === "q") shutdown();
      else if (key.name === "d") startDrift();
      else if (key.name === "c") clearDrift();
    });
  } else {
    console.log("No keyboard input available here. Use --drift-after to start drift automatically.");
  }
  if (DRIFT_AFTER_S !== null) setTimeout(startDrift, DRIFT_AFTER_S * 1000);
  if (DURATION_S !== null) setTimeout(shutdown, DURATION_S * 1000);
  loop();
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});