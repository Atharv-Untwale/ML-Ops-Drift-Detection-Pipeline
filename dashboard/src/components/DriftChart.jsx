import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ReferenceArea } from "recharts";
import { colorOf, labelOf } from "../lib/detectors.js";
import { makeTicks, tickFormatter, fmtDayClock } from "../lib/format.js";

const axisTick = { fontFamily: "Geist Mono, monospace", fontSize: 10, fill: "#5e636b" };

function ChartTooltip({ active, payload, label, names }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tt">
      <div className="h">{fmtDayClock(label)}</div>
      {names.map((n) => {
        const v = payload[0].payload[n];
        return (
          <div className="r" key={n}>
            <span style={{ color: colorOf(n) }}>{labelOf(n)}</span>
            <span>{v === undefined || v === null ? "\u2013" : `${v.toFixed(2)}\u00d7`}</span>
          </div>
        );
      })}
    </div>
  );
}

// rows: [{ t, <detector>: ratio }], spans: [{ x1, x2 }] where any detector alarms,
// markers: [{ t, label }] for promoted models.
export default function DriftChart({ rows, names, spans, markers, yMax }) {
  if (rows.length === 0) return <div className="empty">No drift scores in this time range.</div>;
  const min = rows[0].t;
  const max = rows[rows.length - 1].t;
  return (
    <ResponsiveContainer width="100%" height={340}>
      <LineChart data={rows} margin={{ top: 26, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid stroke="#dcd8ce" vertical={false} />
        <XAxis
          dataKey="t"
          type="number"
          domain={[min, max]}
          ticks={makeTicks(min, max)}
          tickFormatter={tickFormatter(min, max)}
          tick={axisTick}
          axisLine={{ stroke: "#15171c" }}
          tickLine={{ stroke: "#15171c" }}
        />
        <YAxis domain={[0, yMax]} tickFormatter={(v) => `${v}\u00d7`} tick={axisTick} axisLine={false} tickLine={false} width={44} />
        {spans.map((s, i) => (
          <ReferenceArea key={i} x1={s.x1} x2={s.x2} fill="#d94f2b" fillOpacity={0.07} stroke="none" />
        ))}
        <ReferenceLine
          y={1}
          stroke="#15171c"
          strokeDasharray="5 4"
          label={{ value: "THRESHOLD = 1\u00d7", position: "insideTopRight", fill: "#15171c", fontSize: 9, fontFamily: "Geist Mono, monospace" }}
        />
        {markers.map((m) => (
          <ReferenceLine
            key={m.t}
            x={m.t}
            stroke="#2e8b80"
            label={{
              value: m.label.toUpperCase(),
              position: (m.t - min) / (max - min) > 0.8 ? "insideTopRight" : "insideTopLeft",
              fill: "#2e8b80",
              fontSize: 9,
              fontFamily: "Geist Mono, monospace",
            }}
          />
        ))}
        <Tooltip content={<ChartTooltip names={names} />} />
        {names.map((n) => (
          <Line key={n} dataKey={n} stroke={colorOf(n)} strokeWidth={1.6} dot={false} isAnimationActive={false} connectNulls />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}
