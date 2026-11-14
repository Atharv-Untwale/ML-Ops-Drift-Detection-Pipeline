import { useRange, RANGES } from "./Layout.jsx";

export default function PageHeader({ title, sub, status }) {
  const { minutes, setMinutes } = useRange();
  return (
    <header className="head">
      <div>
        <h1>{title}</h1>
        <div className="sub">{sub}</div>
      </div>
      <div className="ctrl">
        <div className="seg">
          {RANGES.map(([label, value]) => (
            <button key={label} className={value === minutes ? "on" : ""} onClick={() => setMinutes(value)}>
              {label}
            </button>
          ))}
        </div>
        {status && (
          <div className="pill">
            <i style={{ background: status.color }} />
            {status.text}
          </div>
        )}
      </div>
    </header>
  );
}
