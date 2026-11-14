const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n) => String(n).padStart(2, "0");

export const fmtClock = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fmtDay = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getDate())} ${MONTHS[d.getMonth()]}`;
};
export const fmtDayClock = (ms) => `${fmtDay(ms)} ${fmtClock(ms)}`;

export function relativeTime(iso) {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return "\u2013";
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} m ${pad(seconds % 60)} s`;
  return `${Math.floor(seconds / 3600)} h ${pad(Math.floor((seconds % 3600) / 60))} m`;
}

// Axis ticks that suit the span: hourly for short ranges, daily for long ones.
export function makeTicks(min, max) {
  const span = max - min;
  const out = [];
  if (span <= 3 * HOUR) {
    const stepM = span <= 90 * 60000 ? 10 : 30;
    const d = new Date(min);
    d.setSeconds(0, 0);
    while (d.getTime() < min || d.getMinutes() % stepM !== 0) d.setMinutes(d.getMinutes() + 1);
    for (; d.getTime() <= max; d.setMinutes(d.getMinutes() + stepM)) out.push(d.getTime());
  } else if (span <= 2 * DAY) {
    const stepH = span <= 8 * HOUR ? 1 : 4;
    const d = new Date(min);
    d.setMinutes(0, 0, 0);
    while (d.getTime() < min || d.getHours() % stepH !== 0) d.setHours(d.getHours() + 1);
    for (; d.getTime() <= max; d.setHours(d.getHours() + stepH)) out.push(d.getTime());
  } else {
    const stepDays = span > 14 * DAY ? 5 : 1;
    const d = new Date(min);
    d.setHours(24, 0, 0, 0);
    for (; d.getTime() <= max; d.setDate(d.getDate() + stepDays)) out.push(d.getTime());
  }
  return out;
}

export const tickFormatter = (min, max) => (max - min <= 2 * DAY ? fmtClock : fmtDay);
