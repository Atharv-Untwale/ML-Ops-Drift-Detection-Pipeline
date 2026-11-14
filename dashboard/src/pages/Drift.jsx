import { useMemo } from "react";
import { LineChart, Line } from "recharts";
import { api } from "../api.js";
import { useApi } from "../hooks/useApi.js";
import { useRange } from "../components/Layout.jsx";
import PageHeader from "../components/PageHeader.jsx";
import DriftChart from "../components/DriftChart.jsx";
import { Card, Kpi, Chip, Notice } from "../components/ui.jsx";
import { colorOf, labelOf, orderOf, FAMILY_LABELS } from "../lib/detectors.js";
import { relativeTime, fmtDayClock, fmtDuration } from "../lib/format.js";

const REFRESH_MS = 10000;
const STATUS_COLORS = { promoted: "#2e8b80", rejected: "#b58a2a", skipped: "#80858d", failed: "#d94f2b", running: "#2c4a7a" };

function buildChart(scores, events) {
  const dets = scores?.detectors ?? {};
  const names = Object.keys(dets).sort((a, b) => orderOf(a) - orderOf(b));
  const byT = new Map();
  for (const name of names) {
    for (const p of dets[name].points) {
      const t = new Date(p.t).getTime();
      const row = byT.get(t) ?? { t, alarm: false };
      row[name] = p.ratio;
      if (p.alarm) row.alarm = true;
      byT.set(t, row);
    }
  }
  const rows = [...byT.values()].sort((a, b) => a.t - b.t);

  // Shade every stretch of runs where at least one detector was alarming.
  const spans = [];
  let open = null;
  for (const r of rows) {
    if (r.alarm) {
      if (open) open.x2 = r.t;
      else open = { x1: r.t, x2: r.t };
    } else if (open) {
      spans.push(open);
      open = null;
    }
  }
  if (open) spans.push(open);

  const peak = Math.max(2, ...rows.flatMap((r) => names.map((n) => r[n] ?? 0)));
  const markers = (events?.events ?? [])
    .filter((e) => e.status === "promoted" && e.finished_at)
    .map((e) => ({ t: new Date(e.finished_at).getTime(), label: `${e.model_version ?? "model"} promoted` }))
    .filter((m) => rows.length > 0 && m.t >= rows[0].t && m.t <= rows[rows.length - 1].t);

  return { names, rows, spans, markers, yMax: Math.ceil(peak + 0.3) };
}

function Spark({ rows, name }) {
  const step = Math.max(1, Math.floor(rows.length / 80));
  const data = rows.filter((_, i) => i % step === 0).map((r) => ({ v: r[name] ?? null }));
  return (
    <LineChart width={72} height={26} data={data}>
      <Line dataKey="v" stroke={colorOf(name)} strokeWidth={1.3} dot={false} isAnimationActive={false} connectNulls />
    </LineChart>
  );
}

export default function Drift() {
  const { minutes } = useRange();
  const overview = useApi((s) => api.driftOverview(minutes, s), [minutes], REFRESH_MS);
  const scores = useApi((s) => api.driftScores(minutes, s), [minutes], REFRESH_MS);
  const features = useApi((s) => api.driftFeatures(minutes, "ks_test", s), [minutes], REFRESH_MS);
  const events = useApi((s) => api.retrainEvents(minutes, s), [minutes], REFRESH_MS);

  const chart = useMemo(() => buildChart(scores.data, events.data), [scores.data, events.data]);

  const ov = overview.data;
  const detectors = ov?.detectors ?? [];
  const withData = ov?.detectors_with_data ?? 0;
  const peakDet = detectors.filter((d) => d.peak_ratio !== null).sort((a, b) => b.peak_ratio - a.peak_ratio)[0];
  const totalAlarms = detectors.reduce((sum, d) => sum + d.alarm_count, 0);

  const status = !ov
    ? null
    : withData === 0
    ? { color: "#80858d", text: "No data" }
    : ov.alarming_now > 0
    ? { color: "#d94f2b", text: "Drift detected" }
    : { color: "#2e8b80", text: "Healthy" };

  const firstError = overview.error ?? scores.error ?? features.error ?? events.error;
  const reloadAll = () => {
    overview.reload();
    scores.reload();
    features.reload();
    events.reload();
  };

  const feat = features.data;
  const featMax = feat ? Math.max(0.45, feat.threshold * 2, ...feat.features.map((f) => f.peak)) : 1;

  return (
    <>
      <PageHeader
        title="Drift"
        sub={`Telco churn · ${ov?.last_run_at ? `last run ${relativeTime(ov.last_run_at)}` : "waiting for data"}`}
        status={status}
      />

      {firstError && <Notice error={firstError} onRetry={reloadAll} />}
      {ov && withData === 0 && !firstError && (
        <Notice>
          No drift scores in this time range. For demo data run <code>node scripts/seed-monitoring.js --reset</code> in
          backend-node, or wait for the detectors to write results.
        </Notice>
      )}

      <div className="grid-kpi">
        <Kpi
          label="Detectors alarming now"
          value={ov ? ov.alarming_now : "\u2013"}
          unit={ov ? `/ ${withData}` : undefined}
          note={ov?.last_run_at ? `latest run ${relativeTime(ov.last_run_at)}` : "no runs yet"}
        />
        <Kpi
          label="Peak drift"
          value={peakDet ? `${peakDet.peak_ratio.toFixed(1)}\u00d7` : "\u2013"}
          note={peakDet ? `${labelOf(peakDet.detector_name)}, as a multiple of its threshold` : "no scores yet"}
        />
        <Kpi label="Alarm runs" value={ov ? totalAlarms : "\u2013"} note="detector runs over threshold, all detectors" />
        <Kpi
          label="Detectors enabled"
          value={ov ? detectors.filter((d) => d.enabled).length : "\u2013"}
          unit={ov ? `/ ${detectors.length}` : undefined}
          note={ov ? `${withData} have scores in this range` : ""}
        />
      </div>

      <div className="grid-main">
        <Card>
          <div className="card-head">
            <div className="lab">Drift score as a multiple of its threshold</div>
            <div className="legend">
              {chart.names.map((n) => (
                <span key={n}>
                  <b style={{ background: colorOf(n) }} />
                  {labelOf(n)}
                </span>
              ))}
            </div>
          </div>
          {scores.loading && !scores.data ? (
            <div className="empty">Loading scores…</div>
          ) : (
            <DriftChart rows={chart.rows} names={chart.names} spans={chart.spans} markers={chart.markers} yMax={chart.yMax} />
          )}
        </Card>

        <Card>
          <div className="lab" style={{ marginBottom: 2 }}>Detectors · peak / threshold</div>
          {detectors.map((d) => {
            const hasData = d.runs > 0;
            const state = !d.enabled
              ? { c: "#80858d", t: "Off" }
              : !hasData
              ? { c: "#80858d", t: "No data" }
              : d.latest_alarm
              ? { c: "#d94f2b", t: "Alarm" }
              : { c: "#2e8b80", t: "OK" };
            return (
              <div className="det-row" key={d.detector_name}>
                <div className="det-name">
                  <span className="bar" style={{ background: colorOf(d.detector_name) }} />
                  <div>
                    <div className="t">{labelOf(d.detector_name)}</div>
                    <div className="lab" style={{ marginTop: 4, fontSize: 9 }}>{FAMILY_LABELS[d.family] ?? d.family}</div>
                  </div>
                </div>
                {hasData && <Spark rows={chart.rows} name={d.detector_name} />}
                <div className="det-nums">
                  {hasData ? (
                    <>
                      {d.peak_score.toFixed(2)} <span style={{ color: "#5e636b" }}>/ {d.threshold}</span>
                    </>
                  ) : (
                    <span style={{ color: "#5e636b" }}>thr. {d.threshold}</span>
                  )}
                  <small>
                    <Chip color={state.c}>{state.t}</Chip>
                  </small>
                </div>
              </div>
            );
          })}
        </Card>
      </div>

      <div className="grid-main">
        <Card>
          <div className="lab" style={{ marginBottom: 10 }}>
            KS statistic by feature · peak in range{feat ? ` · tick = threshold ${feat.threshold}` : ""}
          </div>
          {feat && feat.features.length === 0 && <div className="empty">No per-feature scores in this range.</div>}
          {feat &&
            feat.features.map((f) => (
              <div className="feat-row" key={f.feature_name}>
                <div className="n">{f.feature_name}</div>
                <div className="track">
                  <div className="fill" style={{ width: `${(f.peak / featMax) * 100}%`, background: f.peak > feat.threshold ? "#d94f2b" : "#b9bcc0" }} />
                  <div className="tick" style={{ left: `${(feat.threshold / featMax) * 100}%` }} />
                </div>
                <div className="v">{f.peak.toFixed(2)}</div>
              </div>
            ))}
        </Card>

        <Card>
          <div className="lab" style={{ marginBottom: 4 }}>Retraining events</div>
          {events.data && events.data.events.length === 0 && <div className="empty" style={{ padding: "30px 0" }}>No events in this range.</div>}
          {events.data?.events.slice(0, 5).map((e) => (
            <div className="ev-row" key={e.event_id}>
              <div>
                <div>{e.trigger_type === "manual" ? "Manual" : labelOf(e.detector_name)}</div>
                <div className="m">
                  {fmtDayClock(new Date(e.started_at).getTime())} · {fmtDuration(e.duration_seconds)}
                </div>
              </div>
              <Chip color={STATUS_COLORS[e.status] ?? "#80858d"}>{e.status}</Chip>
            </div>
          ))}
        </Card>
      </div>
    </>
  );
}
