import crypto from "crypto";

// Fills the monitoring tables with a demo story for dashboard development:
// 7 days of detector scores every 30 minutes, one real drift episode, five
// retraining events and four model versions.
//
// Run from backend-node:
//   node scripts/seed-monitoring.js --dry      show what would be written, no database needed
//   node scripts/seed-monitoring.js            write the data (refuses if data already exists)
//   node scripts/seed-monitoring.js --reset    wipe the monitoring tables first, then write
//
// --reset empties drift_scores, detection_runs, retrain_events and model_versions.
// It does NOT touch predictions, labels or detector_configs.

const flags = new Set(process.argv.slice(2));
const DRY = flags.has("--dry");
const RESET = flags.has("--reset");

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(11);
const between = (a, b) => a + rand() * (b - a);

// ---- timeline: 7 days, one run every 30 minutes ----
const STEP_MS = 30 * 60 * 1000;
const DAYS = 7;
const N = DAYS * 48 + 1;
const NOW = Date.now();
const START = NOW - DAYS * 24 * 3600 * 1000;
const T = (i) => new Date(START + i * STEP_MS);
const DI = N - 1 - (3 * 48 + 10); // drift starts 3 days 5 hours before now
const PI = DI + 51; // promotion about 25.5 hours later

// ---- detectors (thresholds are replaced by the values in detector_configs) ----
const DET = [
  { name: "ks_test", peak: 2.7, kd: 1, blip: null, ms: [3, 6] },
  { name: "psi", peak: 2.1, kd: 2, blip: null, ms: [4, 8] },
  { name: "js_divergence", peak: 1.7, kd: 3, blip: 24, ms: [6, 10] },
  { name: "wasserstein", peak: 2.9, kd: 1, blip: 16, ms: [8, 14] },
  { name: "domain_classifier", peak: 2.3, kd: 4, blip: null, ms: [600, 900] },
];
const DEFAULT_THR = { ks_test: 0.15, psi: 0.25, js_divergence: 0.08, wasserstein: 0.12, domain_classifier: 0.7 };
const FEATURES = ["MonthlyCharges", "TotalCharges", "tenure", "Contract", "InternetService", "PaymentMethod", "SeniorCitizen", "gender"];

// Ratio = score divided by threshold. 1 or more means the detector alarms.
function genRatio(peak, kd, blip) {
  const out = [];
  for (let i = 0; i < N; i++) {
    const base = 0.28 + 0.07 * Math.sin(i / 7 + kd) + between(-0.06, 0.06);
    let v;
    if (i < DI) v = base;
    else if (i <= PI) {
      const k = i - DI;
      if (k < kd) v = 0.3 + 0.72 * (k / kd) + between(-0.03, 0.03);
      else v = 1.08 + (peak - 1.08) * (1 - Math.exp(-(k - kd) / 4)) + between(-0.08, 0.08);
      if (k === kd) v = Math.max(v, 1.06);
    } else {
      v = base + (out[PI] - 0.3) * Math.exp(-(i - PI) / 2.2);
    }
    if (blip !== null && Math.abs(i - blip) <= 1) v = i === blip ? 1.12 : 0.78;
    out.push(Math.max(0.05, v));
  }
  return out;
}

export function build(thr) {
  const ratios = Object.fromEntries(DET.map((d) => [d.name, genRatio(d.peak, d.kd, d.blip)]));
  const runs = [];
  const rows = []; // { run: index, det, feat, score, hit, ms }

  for (let i = 0; i < N; i++) {
    const t = T(i);
    runs.push({
      id: crypto.randomUUID(),
      start: new Date(t.getTime() - 2 * 3600 * 1000),
      end: t,
      refSize: 2000,
      curSize: 200,
    });
    for (const d of DET) {
      const r = ratios[d.name][i];
      const th = thr[d.name];
      const ms = between(d.ms[0], d.ms[1]);
      if (d.name === "ks_test") {
        const per = {};
        for (const f of FEATURES) {
          if (f === "MonthlyCharges") per[f] = r * th;
          else if (f === "TotalCharges") per[f] = 0.88 * r * th;
          else per[f] = between(0.03, 0.06);
        }
        for (const f of FEATURES) rows.push({ run: i, det: d.name, feat: f, score: per[f], hit: per[f] > th, ms: ms / FEATURES.length });
        const agg = Math.max(...Object.values(per));
        rows.push({ run: i, det: d.name, feat: null, score: agg, hit: agg > th, ms });
      } else if (d.name === "domain_classifier") {
        const auc = Math.min(0.99, 0.5 + r * (th - 0.5));
        rows.push({ run: i, det: d.name, feat: null, score: auc, hit: auc > th, ms });
      } else {
        const s = r * th;
        rows.push({ run: i, det: d.name, feat: null, score: s, hit: s > th, ms });
      }
    }
  }

  const firstAlarm = (name) => {
    for (let i = DI; i <= PI; i++) {
      const row = rows.find((x) => x.run === i && x.det === name && x.feat === null);
      if (row.hit) return i;
    }
    return null;
  };
  const alarmKS = firstAlarm("ks_test");
  const alarmPSI = firstAlarm("psi");
  const MANUAL_IDX = 99;

  const sec = (d, s) => new Date(d.getTime() + s * 1000);
  const events = [
    { key: "promoted", trigger: "auto", status: "promoted", outcome: "F1 0.65 vs 0.53 on held-out data, promoted v2", scoreRun: alarmKS, scoreDet: "ks_test", start: T(alarmKS), end: T(PI), version: "v2" },
    { key: "skipped", trigger: "auto", status: "skipped", outcome: "retraining already pending", scoreRun: alarmPSI, scoreDet: "psi", start: T(alarmPSI), end: sec(T(alarmPSI), 1), version: null },
    { key: "manual", trigger: "manual", status: "rejected", outcome: "improvement below the 0.02 promotion margin (F1 0.58 vs 0.57)", scoreRun: null, scoreDet: null, start: T(MANUAL_IDX), end: sec(T(MANUAL_IDX), 408), version: "v1.2" },
    { key: "jsfalse", trigger: "auto", status: "rejected", outcome: "no improvement (F1 0.57 vs 0.57), false alarm", scoreRun: 24, scoreDet: "js_divergence", start: T(24), end: sec(T(24), 261), version: "v1.1" },
    { key: "wfalse", trigger: "auto", status: "failed", outcome: "training error: not enough labelled rows", scoreRun: 16, scoreDet: "wasserstein", start: T(16), end: sec(T(16), 63), version: null },
  ];
  const versions = [
    { v: "v1", stage: "archived", metric: 0.62, ev: null, at: T(0) },
    { v: "v1.1", stage: "archived", metric: 0.57, ev: "jsfalse", at: events[3].end },
    { v: "v1.2", stage: "archived", metric: 0.58, ev: "manual", at: events[2].end },
    { v: "v2", stage: "production", metric: 0.65, ev: "promoted", at: events[0].end },
  ];
  return { runs, rows, events, versions, alarmKS, alarmPSI };
}

async function main() {
  let thr = { ...DEFAULT_THR };
  let pool = null;

  if (!DRY) {
    ({ pool } = await import("../src/db/pool.js"));
    const cfg = await pool.query("SELECT detector_name, threshold FROM detector_configs");
    for (const r of cfg.rows) thr[r.detector_name] = r.threshold;
    for (const d of DET) {
      if (!(d.name in thr) || !cfg.rows.some((r) => r.detector_name === d.name)) {
        console.error(`detector_configs has no row for ${d.name}. Run schema_v2.sql first.`);
        process.exit(1);
      }
    }
  }

  const { runs, rows, events, versions, alarmKS, alarmPSI } = build(thr);

  console.log(`Timeline: ${N} runs, one every 30 min, ${DAYS} days`);
  console.log(`Drift starts at run ${DI}, promotion at run ${PI}`);
  console.log(`Rows: ${runs.length} detection_runs, ${rows.length} drift_scores, ${events.length} retrain_events, ${versions.length} model_versions`);
  for (const d of DET) {
    const alarms = rows.filter((r) => r.det === d.name && r.feat === null && r.hit).length;
    const first = rows.find((r) => r.det === d.name && r.feat === null && r.run >= DI && r.hit);
    console.log(`  ${d.name.padEnd(18)} alarms=${String(alarms).padStart(3)}  first alarm +${first ? (first.run - DI) * 30 : "?"} min after drift`);
  }
  console.log(`KS first alarm at run ${alarmKS}, PSI at run ${alarmPSI}`);

  if (DRY) {
    console.log("Dry run only. Nothing was written.");
    return;
  }

  try {
    if (RESET) {
      await pool.query("TRUNCATE drift_scores, detection_runs, retrain_events, model_versions RESTART IDENTITY CASCADE");
      console.log("Monitoring tables emptied.");
    } else {
      const { rows: c } = await pool.query("SELECT (SELECT count(*) FROM detection_runs)::int AS runs, (SELECT count(*) FROM retrain_events)::int AS events");
      if (c[0].runs > 0 || c[0].events > 0) {
        console.error(`The monitoring tables already hold data (${c[0].runs} runs, ${c[0].events} events). Use --reset to replace it.`);
        process.exit(1);
      }
    }

    await pool.query(
      `INSERT INTO detection_runs (run_id, window_start, window_end, reference_size, current_size, created_at)
       SELECT * FROM unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[], $4::int[], $5::int[], $6::timestamptz[])`,
      [runs.map((r) => r.id), runs.map((r) => r.start), runs.map((r) => r.end), runs.map((r) => r.refSize), runs.map((r) => r.curSize), runs.map((r) => r.end)]
    );

    const CHUNK = 2000;
    for (let s = 0; s < rows.length; s += CHUNK) {
      const part = rows.slice(s, s + CHUNK);
      await pool.query(
        `INSERT INTO drift_scores (run_id, detector_name, feature_name, score, drift_detected, compute_ms)
         SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::float8[], $5::boolean[], $6::float8[])`,
        [part.map((x) => runs[x.run].id), part.map((x) => x.det), part.map((x) => x.feat), part.map((x) => x.score), part.map((x) => x.hit), part.map((x) => x.ms)]
      );
    }

    const needed = events.filter((e) => e.scoreRun !== null).map((e) => runs[e.scoreRun].id);
    const { rows: ids } = await pool.query(
      "SELECT run_id, detector_name, score_id FROM drift_scores WHERE feature_name IS NULL AND run_id = ANY($1::uuid[])",
      [needed]
    );
    const eventIds = {};
    for (const e of events) {
      let scoreId = null;
      if (e.scoreRun !== null) {
        const hit = ids.find((x) => x.run_id === runs[e.scoreRun].id && x.detector_name === e.scoreDet);
        scoreId = hit ? hit.score_id : null;
      }
      const { rows: ins } = await pool.query(
        `INSERT INTO retrain_events (triggered_by_score_id, trigger_type, status, outcome, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING event_id`,
        [scoreId, e.trigger, e.status, e.outcome, e.start, e.end]
      );
      eventIds[e.key] = ins[0].event_id;
    }
    for (const v of versions) {
      await pool.query(
        `INSERT INTO model_versions (model_version, retrain_event_id, stage, validation_metric, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [v.v, v.ev ? eventIds[v.ev] : null, v.stage, v.metric, v.at]
      );
    }
    console.log("Done. Seed data written.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});