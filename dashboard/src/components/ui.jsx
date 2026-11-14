export function Card({ children, className = "", style }) {
  return (
    <section className={`card ${className}`} style={style}>
      {children}
    </section>
  );
}

export function Kpi({ label, value, unit, note }) {
  return (
    <div className="card kpi">
      <div className="lab">{label}</div>
      <div className="v">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      <div className="n">{note}</div>
    </div>
  );
}

export function Chip({ color, children }) {
  return (
    <span className="chip" style={{ color, borderColor: color }}>
      {children}
    </span>
  );
}

export function Notice({ error, onRetry, children }) {
  return (
    <div className={`notice ${error ? "err" : ""}`}>
      <span>{error ?? children}</span>
      {onRetry && <button onClick={onRetry}>Retry</button>}
    </div>
  );
}
