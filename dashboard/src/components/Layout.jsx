import { createContext, useContext, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";

const RangeContext = createContext({ minutes: 10080, setMinutes: () => {} });
export const useRange = () => useContext(RangeContext);
export const RANGES = [
  ["1h", 60],
  ["24h", 1440],
  ["7d", 10080],
  ["30d", 43200],
];

const stroke = { fill: "none", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round" };
const ICONS = {
  drift: (
    <>
      <path d="M3 17 L8 11 L12 14 L17 6 L21 9" {...stroke} />
      <circle cx="17" cy="6" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  performance: <path d="M4 20 V12 M10 20 V6 M16 20 V14 M22 20 V9" {...stroke} />,
  retraining: (
    <>
      <path d="M20 12 A8 8 0 1 1 15 4.6" {...stroke} />
      <path d="M20 4 V9 H15" {...stroke} />
    </>
  ),
  models: (
    <>
      <rect x="3" y="5" width="8" height="14" {...stroke} />
      <rect x="13" y="5" width="8" height="14" {...stroke} />
    </>
  ),
};
const NAV = [
  ["/", "Drift", "drift"],
  ["/performance", "Performance", "performance"],
  ["/retraining", "Retraining", "retraining"],
  ["/models", "Models", "models"],
];

export default function Layout() {
  const [minutes, setMinutes] = useState(10080);
  return (
    <RangeContext.Provider value={{ minutes, setMinutes }}>
      <div className="shell">
        <nav className="rail">
          <div className="logo">
            <svg width="34" height="34" viewBox="0 0 34 34">
              <circle cx="17" cy="17" r="15" fill="none" stroke="#15171c" strokeWidth="1.3" />
              <circle cx="17" cy="17" r="9.5" fill="none" stroke="#15171c" strokeWidth="1.3" />
              <circle cx="17" cy="17" r="3.2" fill="#d94f2b" />
            </svg>
          </div>
          {NAV.map(([to, label, icon]) => (
            <NavLink key={to} to={to} end={to === "/"}>
              <svg width="24" height="24" viewBox="0 0 24 24">{ICONS[icon]}</svg>
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>
        <main className="main">
          <Outlet />
        </main>
      </div>
    </RangeContext.Provider>
  );
}
