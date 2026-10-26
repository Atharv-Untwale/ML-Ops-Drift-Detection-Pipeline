import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";

// Run from backend-node:
//   node scripts/simulate-traffic.js --count 400 --scenario price_hike --pattern sudden --seed 42
// scenario: baseline | price_hike | contract_shift | new_customers
// pattern:  sudden | gradual | recurring

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
}

const COUNT = Number(args.count ?? 400);
const SCENARIO = args.scenario ?? "baseline";
const PATTERN = args.pattern ?? "sudden";
const SEED = Number(args.seed ?? 42);
const DELAY_MS = Number(args.delay ?? 20);
const API_URL = args.url ?? "http://localhost:4000/predict";
const DATA_PATH =
  args.data ?? path.resolve(__dirname, "../../data/Telco-Customer-Churn.csv");

const SCENARIOS = ["baseline", "price_hike", "contract_shift", "new_customers"];
const PATTERNS = ["sudden", "gradual", "recurring"];
if (!SCENARIOS.includes(SCENARIO) || !PATTERNS.includes(PATTERN)) {
  console.error(`scenario must be one of: ${SCENARIOS.join(", ")}`);
  console.error(`pattern must be one of: ${PATTERNS.join(", ")}`);
  process.exit(1);
}

const FEATURE_COLS = [
  "gender", "SeniorCitizen", "Partner", "Dependents", "tenure", "PhoneService",
  "MultipleLines", "InternetService", "OnlineSecurity", "OnlineBackup",
  "DeviceProtection", "TechSupport", "StreamingTV", "StreamingMovies",
  "Contract", "PaperlessBilling", "PaymentMethod", "MonthlyCharges", "TotalCharges",
];
const NUMERIC_COLS = new Set(["SeniorCitizen", "tenure", "MonthlyCharges", "TotalCharges"]);

// Seeded random numbers so every experiment is reproducible
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

let customers = [];
let newPool = [];
let monthToMonth = "Month-to-month";

function loadCustomers() {
  if (!fs.existsSync(DATA_PATH)) {
    console.error(`Dataset not found at ${DATA_PATH}`);
    console.error("Download Telco-Customer-Churn.csv into the repo's data/ folder first.");
    process.exit(1);
  }
  const text = fs.readFileSync(DATA_PATH, "utf8").replace(/^\uFEFF/, "");
  const [header, ...rows] = parseCsv(text);
  const missing = [...FEATURE_COLS, "customerID", "Churn"].filter((c) => !header.includes(c));
  if (missing.length) {
    console.error("CSV is missing columns:", missing.join(", "));
    console.error("Make sure you downloaded the 21-column IBM Telco file.");
    process.exit(1);
  }

  const out = [];
  for (const r of rows) {
    const rec = Object.fromEntries(header.map((h, i) => [h, r[i]]));
    // A few brand-new customers have a blank TotalCharges; skip them.
    if (!rec.TotalCharges || rec.TotalCharges.trim() === "") continue;
    const features = {};
    for (const col of FEATURE_COLS) {
      features[col] = NUMERIC_COLS.has(col) ? Number(rec[col]) : rec[col];
    }
    out.push({ id: rec.customerID, churn: rec.Churn, features });
  }
  return out;
}

// How strongly drift is applied at position f (0..1) through the run
function intensityAt(f) {
  if (SCENARIO === "baseline") return 0;
  if (PATTERN === "sudden") return f >= 0.5 ? 1 : 0;
  if (PATTERN === "gradual") return Math.min(1, Math.max(0, (f - 0.4) / 0.3));
  return (f >= 0.3 && f < 0.5) || (f >= 0.7 && f < 0.9) ? 1 : 0; // recurring
}

const round2 = (x) => Math.round(x * 100) / 100;

function pickCustomer(drifted) {
  const useNew = drifted && SCENARIO === "new_customers" && rand() < 0.7;
  const pool = useNew ? newPool : customers;
  return pool[Math.floor(rand() * pool.length)];
}

function applyDrift(f) {
  const out = { ...f };
  if (SCENARIO === "price_hike") {
    out.MonthlyCharges = round2(f.MonthlyCharges * 1.35);
    out.TotalCharges = round2(f.TotalCharges * 1.35);
  } else if (SCENARIO === "contract_shift" && rand() < 0.7) {
    out.Contract = monthToMonth;
  }
  return out;
}

async function preflight() {
  const healthUrl = new URL("/health", API_URL).toString();
  try {
    await axios.get(healthUrl, { timeout: 3000 });
  } catch {
    console.error(`API not reachable at ${healthUrl}.`);
    console.error('Start it with "npm run dev" in backend-node, and check Docker with "docker ps".');
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await preflight();

  customers = loadCustomers();
  newPool = customers.filter((c) => c.features.tenure <= 12);
  monthToMonth =
    [...new Set(customers.map((c) => c.features.Contract))].find((v) => /month/i.test(v)) ??
    monthToMonth;

  console.log(`Loaded ${customers.length} customers (${newPool.length} with tenure <= 12)`);
  console.log(`Sending ${COUNT} requests: scenario=${SCENARIO} pattern=${PATTERN} seed=${SEED}`);

  const log = [["i", "sent_at", "intensity", "drifted", "request_id", "status", "customer_id", "true_churn"]];
  let ok = 0;
  let failed = 0;
  let firstDrift = null;

  for (let i = 0; i < COUNT; i++) {
    const intensity = intensityAt(i / COUNT);
    const drifted = intensity > 0 && rand() < intensity;
    const cust = pickCustomer(drifted);
    const features = drifted ? applyDrift(cust.features) : { ...cust.features };
    const sentAt = new Date().toISOString();

    if (drifted && !firstDrift) {
      firstDrift = { i, sentAt };
      console.log(`First drifted request: #${i} at ${sentAt}`);
    }

    let status = "ok";
    let requestId = "";
    try {
      const res = await axios.post(API_URL, { features }, { timeout: 5000 });
      requestId = res.data.request_id;
      ok++;
    } catch (err) {
      status = "fail";
      failed++;
      if (failed === 1) {
        console.log("First failure:", err.response?.status, err.response?.data ?? err.message);
      }
    }

    log.push([i, sentAt, intensity.toFixed(2), drifted ? 1 : 0, requestId, status, cust.id, cust.churn]);
    if ((i + 1) % 50 === 0) console.log(`${i + 1}/${COUNT} sent (ok=${ok}, failed=${failed})`);
    await sleep(DELAY_MS);
  }

  const runsDir = path.resolve(__dirname, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(runsDir, `${stamp}_${SCENARIO}_${PATTERN}_seed${SEED}.csv`);
  fs.writeFileSync(file, log.map((r) => r.join(",")).join("\n"));

  console.log(`Done. ok=${ok} failed=${failed}`);
  console.log(`Ground-truth log saved to ${file}`);
}

main();