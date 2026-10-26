import axios from "axios";

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  args[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
}

const COUNT = Number(args.count ?? 300);
const MODE = args.mode ?? "baseline";
const DELAY_MS = Number(args.delay ?? 20);
const API_URL = args.url ?? "http://localhost:4000/predict";

function randn() {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function pick(options) {
  let r = Math.random();
  for (const [value, weight] of options) {
    r -= weight;
    if (r <= 0) return value;
  }
  return options[options.length - 1][0];
}

function makeFeatures(drifted) {
  const tenure = Math.round(
    clamp(drifted ? 10 + 8 * randn() : 32 + 18 * randn(), 1, 72)
  );
  const monthly = clamp(drifted ? 95 + 15 * randn() : 65 + 20 * randn(), 18, 120);
  const contract = drifted
    ? pick([["month-to-month", 0.8], ["one-year", 0.15], ["two-year", 0.05]])
    : pick([["month-to-month", 0.45], ["one-year", 0.3], ["two-year", 0.25]]);
  const calls = Math.max(
    0,
    Math.round(drifted ? 4 + 2 * randn() : 1 + 1.2 * randn())
  );

  return {
    tenure,
    monthly_charges: Number(monthly.toFixed(2)),
    total_charges: Number((monthly * tenure).toFixed(2)),
    contract_type: contract,
    support_calls: calls,
  };
}

async function main() {
  console.log(`Sending ${COUNT} requests, mode=${MODE}`);
  let ok = 0;
  let failed = 0;

  for (let i = 0; i < COUNT; i++) {
    const drifted = MODE === "drift" || (MODE === "sudden" && i >= COUNT / 2);
    try {
      await axios.post(API_URL, { features: makeFeatures(drifted) }, { timeout: 5000 });
      ok++;
    } catch {
      failed++;
    }
    if ((i + 1) % 50 === 0) {
      console.log(`${i + 1}/${COUNT} sent (ok=${ok}, failed=${failed})`);
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }

  console.log(`Done. ok=${ok} failed=${failed}`);
}

main();