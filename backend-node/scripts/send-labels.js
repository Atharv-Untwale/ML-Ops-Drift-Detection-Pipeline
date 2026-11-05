import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";

// Sends true churn labels (from a simulator ground-truth log) to POST /api/labels,
// the way delayed labels would arrive in production.
//
// Run from backend-node:
//   node scripts/send-labels.js --fraction 0.5 --mode oldest
//
// --fraction  share of the run to label, 0 to 1 (default 1)
// --mode      oldest = label the earliest requests first (default, like real late labels)
//             random = label a random sample
// --file      a log in scripts/runs (default: the newest one)
// --seed      for random mode (default 42)
// --batch     labels per request, max 1000 (default 500)

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
}

const FRACTION = Number(args.fraction ?? 1);
const MODE = args.mode ?? "oldest";
const SEED = Number(args.seed ?? 42);
const BATCH = Math.min(1000, Number(args.batch ?? 500));
const API_URL = args.url ?? "http://localhost:4000/api/labels";

if (!(FRACTION > 0 && FRACTION <= 1)) {
  console.error("--fraction must be above 0 and at most 1");
  process.exit(1);
}
if (!["oldest", "random"].includes(MODE)) {
  console.error("--mode must be oldest or random");
  process.exit(1);
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickFile() {
  const runsDir = path.resolve(__dirname, "runs");
  if (args.file) return path.resolve(runsDir, args.file);
  if (!fs.existsSync(runsDir)) return null;
  const files = fs.readdirSync(runsDir).filter((f) => f.endsWith(".csv")).sort();
  return files.length ? path.join(runsDir, files[files.length - 1]) : null;
}

async function main() {
  const healthUrl = new URL("/health", API_URL).toString();
  try {
    await axios.get(healthUrl, { timeout: 3000 });
  } catch {
    console.error(`API not reachable at ${healthUrl}. Start it with "npm run dev".`);
    process.exit(1);
  }

  const file = pickFile();
  if (!file || !fs.existsSync(file)) {
    console.error("No ground-truth log found. Run simulate-traffic.js first.");
    process.exit(1);
  }
  console.log(`Using ${path.basename(file)}`);

  const [headerLine, ...lines] = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  const header = headerLine.split(",");
  for (const col of ["i", "request_id", "status", "true_churn"]) {
    if (!header.includes(col)) {
      console.error(`Log is missing the "${col}" column`);
      process.exit(1);
    }
  }

  const rows = lines
    .map((l) => Object.fromEntries(header.map((h, k) => [h, l.split(",")[k]])))
    .filter((r) => r.status === "ok" && r.request_id);

  let labels = rows.map((r) => ({
    i: Number(r.i),
    request_id: r.request_id,
    actual_churn: r.true_churn === "Yes" ? 1 : 0,
  }));

  const n = Math.max(1, Math.round(labels.length * FRACTION));
  if (MODE === "random") {
    const rand = mulberry32(SEED);
    labels = labels
      .map((l) => ({ l, k: rand() }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.l);
  } else {
    labels.sort((a, b) => a.i - b.i);
  }
  const chosen = labels.slice(0, n).map(({ request_id, actual_churn }) => ({ request_id, actual_churn }));

  console.log(`${rows.length} successful requests in the log, labelling ${chosen.length} (${MODE})`);

  let received = 0;
  let stored = 0;
  let unmatched = 0;
  for (let s = 0; s < chosen.length; s += BATCH) {
    const batch = chosen.slice(s, s + BATCH);
    try {
      const res = await axios.post(API_URL, { labels: batch }, { timeout: 15000 });
      received += res.data.received;
      stored += res.data.stored;
      unmatched += res.data.unmatched_count;
    } catch (err) {
      console.error("Batch failed:", err.response?.status, err.response?.data ?? err.message);
      process.exit(1);
    }
    console.log(`${Math.min(s + BATCH, chosen.length)}/${chosen.length} sent`);
  }

  console.log(`Done. received=${received} stored=${stored} unmatched=${unmatched}`);
}

main();