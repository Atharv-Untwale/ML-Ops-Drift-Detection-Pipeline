# MLOps Drift Detection Pipeline

An automated pipeline that serves a machine learning model, logs every prediction, detects data drift with several families of algorithms, and (in later stages) triggers retraining when drift is confirmed. The research goal is an empirical comparison of drift detectors on synthetic drift with known ground truth, not a claim that one detector is best.

**Domain:** telecom customer churn, using the IBM Telco Customer Churn dataset.
**Project deadline:** 25 November 2026.

## Status

| Layer | Owner | Status |
|---|---|---|
| Serving API (Node.js) and prediction logging | Backend | Working |
| TimescaleDB storage | Backend | Working |
| Dashboard read endpoints | Backend | Working |
| Traffic and drift simulator | Backend | Working |
| ML service (model, `/predict`) | ML teammate | Not integrated yet (a mock stands in) |
| Drift detection algorithms | ML teammate | Planned |
| Retraining workflow, model registry | ML teammate | Planned |
| Monitoring dashboard (Next.js) | TBD | Planned |
| Drift scores, retrain events and labels tables | Backend | Planned |

## Architecture

```
Client / simulator
       |
       v
Node.js API (Express, port 4000)
  POST /predict ----> ML service (Python, port 8000)   [mock at /mock-ml for now]
       |
       v
PostgreSQL + TimescaleDB (port 5432)
  predictions hypertable
       ^
       |
GET /api/...  <---- Dashboard (planned), drift detectors (planned)
```

Every request that reaches `POST /predict` is stored, including requests that fail because the ML service is down. Failed requests are stored with empty prediction fields, so drift detectors should ignore rows where `prediction IS NULL`.

## Repository layout

```
mlops-drift-pipeline/
├── backend-node/            Node.js API
│   ├── src/
│   │   ├── index.js         Express app and route mounting
│   │   ├── config.js        Environment variables
│   │   ├── db/
│   │   │   ├── pool.js      Shared Postgres connection pool
│   │   │   └── schema.sql   predictions table and hypertable
│   │   └── routes/
│   │       ├── predict.js   POST /predict
│   │       ├── stats.js     GET /api/... read endpoints
│   │       └── mockMl.js    Temporary stand-in for the ML service
│   ├── scripts/
│   │   ├── simulate-traffic.js   Traffic and drift simulator
│   │   └── runs/                 Ground-truth logs from simulator runs
│   ├── package.json
│   └── .env.example
├── ml-service/              Python ML service (ML teammate)
├── data/
│   └── Telco-Customer-Churn.csv
├── docker-compose.yml       TimescaleDB container
└── README.md
```

## Prerequisites

- Docker Desktop, running
- Node.js 20 or later (developed on Node.js 22)
- Git

The commands below are for Windows PowerShell, run from the repository root unless stated otherwise.

## Setup

### 1. Start the database

```powershell
docker compose up -d
docker ps
```

`docker ps` should list `mlops_timescaledb` with status `Up`. Data is kept in the `timescale_data` Docker volume, so it survives restarts.

### 2. Create the table (first time only)

```powershell
Get-Content backend-node\src\db\schema.sql | docker exec -i mlops_timescaledb psql -U mlops_user -d mlops_db
```

You should see `CREATE TABLE` and a `create_hypertable` result row.

### 3. Configure the backend

```powershell
cd backend-node
Copy-Item .env.example .env
npm install
```

Edit `backend-node/.env`. Until the real ML service is ready, point it at the built-in mock:

```env
PORT=4000
DATABASE_URL=postgresql://mlops_user:mlops_pass@localhost:5432/mlops_db
ML_SERVICE_URL=http://localhost:4000/mock-ml
```

When the ML service is live, change `ML_SERVICE_URL` to `http://localhost:8000` and restart the API. No code changes are needed. `.env` is git-ignored; never commit it.

### 4. Start the API

```powershell
npm run dev
```

Wait for both of these lines:

```
✅ Connected to PostgreSQL at: ...
🚀 Server running on http://localhost:4000
```

Check it:

```powershell
Invoke-RestMethod http://localhost:4000/health
```

`node --watch` restarts the server when code changes, but not when `.env` changes. After editing `.env`, stop the server with Ctrl+C and run `npm run dev` again.

## ML service contract

The API calls the ML service like this. The ML teammate implements it; the mock in `mockMl.js` follows the same shape.

Request: `POST {ML_SERVICE_URL}/predict`

```json
{ "features": { "tenure": 12, "MonthlyCharges": 70.5, "Contract": "Month-to-month" } }
```

Response:

```json
{ "prediction": 1, "probability": 0.82, "model_version": "v1" }
```

## API reference

### `GET /health`

Returns `{ "status": "ok" }`.

### `POST /predict`

Body: `{ "features": { ... } }` where `features` is a JSON object.

Success (200):

```json
{
  "request_id": "516d9a78-e8c9-4ef0-93e6-128a444ae124",
  "prediction": 0,
  "probability": 0.0774,
  "model_version": "mock-v0",
  "created_at": "2026-10-12T06:17:39.665Z"
}
```

Errors:

| Status | Meaning |
|---|---|
| 400 | `features` is missing or not an object |
| 502 | The ML service returned an error |
| 503 | The ML service was unreachable or timed out |
| 500 | The prediction worked but logging to the database failed |

For 502 and 503 the request is still logged, with empty `prediction`, `probability` and `model_version`.

### `GET /api/predictions/recent?limit=20`

Latest logged predictions, newest first. `limit` is 1 to 200.

### `GET /api/stats/volume?bucket_seconds=60&minutes=1440`

Request counts grouped into time buckets. Each bucket has `total`, `failed` (empty prediction) and `positive` (prediction equal to 1). Defaults are shown; `bucket_seconds` is 1 to 86400.

### `GET /api/stats/features?from=<ISO>&to=<ISO>`

Summary statistics of the features inside one time window: mean, standard deviation, min and max for `tenure`, `MonthlyCharges` and `TotalCharges`, and value counts for `Contract`, `InternetService` and `PaymentMethod`. Both `from` and `to` are optional ISO timestamps (for example `2026-10-12T06:00:00Z`). Failed requests are excluded. Compare two windows to see drift by eye; the drift detectors automate the same comparison.

## Database schema

The `predictions` table is a TimescaleDB hypertable partitioned on `created_at`.

| Column | Type | Notes |
|---|---|---|
| `id` | serial | Part of the primary key with `created_at` |
| `request_id` | uuid | Generated per request, returned to the caller |
| `features` | jsonb | The full feature object, so the schema can change without migrations |
| `prediction` | integer | Null if the ML service failed |
| `probability` | double precision | Null if the ML service failed |
| `model_version` | text | Null if the ML service failed |
| `created_at` | timestamptz | Partitioning column |

## Dataset

The pipeline uses the IBM Telco Customer Churn CSV (about 7,000 customers, 21 columns). If `data/Telco-Customer-Churn.csv` is missing, download it:

```powershell
New-Item -ItemType Directory -Force data
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/IBM/telco-customer-churn-on-icp4d/master/data/Telco-Customer-Churn.csv" -OutFile data\Telco-Customer-Churn.csv
```

The simulator checks the columns and stops with a clear message if the file is wrong. Use this 21-column file, not the 33-column IBM variant on Kaggle.

Features sent to the model are the 19 columns other than `customerID` and `Churn` (`Churn` is the label). A few new customers have a blank `TotalCharges`; the simulator skips those rows, and the ML side should treat them the same way.

## Traffic and drift simulator

The simulator samples real customers from the CSV and sends them to `POST /predict`. In drift scenarios it modifies part of the stream.

```powershell
cd backend-node
node scripts/simulate-traffic.js --count 400 --scenario price_hike --pattern sudden --seed 42
```

| Option | Values | Default |
|---|---|---|
| `--count` | Number of requests | 400 |
| `--scenario` | `baseline`, `price_hike`, `contract_shift`, `new_customers` | `baseline` |
| `--pattern` | `sudden`, `gradual`, `recurring` | `sudden` |
| `--seed` | Any integer, for reproducible runs | 42 |
| `--delay` | Milliseconds between requests | 20 |
| `--url` | API URL | `http://localhost:4000/predict` |

Scenarios:

- `baseline`: no drift.
- `price_hike`: `MonthlyCharges` and `TotalCharges` rise by 35% (covariate drift).
- `contract_shift`: about 70% of drifted customers move to month-to-month contracts.
- `new_customers`: drifted traffic comes mostly from customers with 12 months of tenure or less.

Patterns control when drift happens: `sudden` switches at the halfway point, `gradual` ramps up between 40% and 70% of the run, and `recurring` drifts in two separate periods.

The simulator checks that the API is reachable before it starts. Each run writes a ground-truth log to `backend-node/scripts/runs/`, with one row per request: its position, send time, whether it was drifted, the request id, and the customer's real churn label. Detection latency is measured against the first drifted row in this file.

All scenarios change input features only. The mock model returns random predictions, so concept drift needs the real model and delayed labels.

To start a clean experiment, empty the table first:

```powershell
docker exec -i mlops_timescaledb psql -U mlops_user -d mlops_db -c "TRUNCATE predictions;"
```

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `docker : The term 'docker' is not recognized` | Docker Desktop is not installed or not on PATH. Install it and restart. |
| `ECONNREFUSED` on port 5432 when starting the API | The database container is not running. Run `docker compose up -d`. |
| `Unable to connect to the remote server` when calling the API | The API is not running. Start it with `npm run dev`. |
| `DATABASE_URL is not set` | `backend-node/.env` is missing. Copy it from `.env.example`. |
| `Cannot GET /api/...` | The server is running old code; check that `src/index.js` mounts `statsRouter` at `/api`. |
| `/predict` returns 503 | `ML_SERVICE_URL` points at a service that is not running. Use the mock URL above. |
| Simulator says `API not reachable` | Start the API and check `docker ps` before running it. |
| Feature stats show `null` | Rows in the table came from an older feature format. Truncate the table and rerun the simulator. |
| `<` is rejected when loading SQL | PowerShell does not support input redirection. Use the `Get-Content ... \|` form shown in Setup. |

## Team

| Name | Roll No. | Area |
|---|---|---|
| `Atharv Untwale` | `EN23CS301222` | Backend (Node.js), database |
| `Aryansh Kshetri` | `EN23CS301207` | ML service, drift detection, retraining |

Guide: `Prof. Shrikant Telang`. Medicaps University, Department of Computer Science and Engineering.

## Roadmap

1. Integrate the real ML service in place of the mock.
2. Add tables for drift scores, retrain events and delayed labels, plus the endpoints that expose them.
3. Drift detectors: KS test, PSI, Jensen-Shannon, Wasserstein, domain classifier, ADWIN and DDM.
4. Retraining workflow with validation, shadow deployment and promotion, and MLflow versioning.
5. Monitoring dashboard in Next.js.
6. Benchmark runs and the comparative analysis report.