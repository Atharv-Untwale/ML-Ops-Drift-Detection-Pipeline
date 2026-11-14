# Drift Monitor dashboard

React (Vite) dashboard for the drift detection pipeline. It reads everything from the Node.js backend.

## Run

```powershell
cd dashboard
copy .env.example .env
npm install
npm run dev
```

Open http://localhost:5173. The backend must be running on http://localhost:4000 (change `VITE_API_URL` in `.env` if it is elsewhere).

For demo data, seed the monitoring tables once from `backend-node`:

```powershell
node scripts/seed-monitoring.js --reset
```

## Views

| Route | Status | Reads from |
|---|---|---|
| `/` Drift | Built | `/api/drift/overview`, `/api/drift/scores`, `/api/drift/features`, `/api/retrain/events` |
| `/performance` | Planned | `/api/performance`, `/api/labels/coverage` |
| `/retraining` | Planned | `/api/retrain/events` |
| `/models` | Planned | `/api/models/versions` |

The time range buttons (1h, 24h, 7d, 30d) apply to every view. Data refreshes every 10 seconds.

## Structure

```
src/
  api.js            all calls to the backend
  hooks/useApi.js   loading, error and refresh handling
  components/       Layout, PageHeader, DriftChart, small UI pieces
  pages/            one file per view
  lib/              detector names and colours, date formatting
  styles.css        design tokens and layout
```
