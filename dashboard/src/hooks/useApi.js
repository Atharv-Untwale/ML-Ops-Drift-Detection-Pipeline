import { useEffect, useState, useCallback } from "react";

// Runs fn(signal) whenever deps change, and again every refreshMs if given.
// Keeps the previous data on screen while a refresh is running.
export function useApi(fn, deps, refreshMs) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    setState((s) => ({ ...s, loading: s.data === null, error: null }));
    fn(ctl.signal)
      .then((data) => setState({ data, error: null, loading: false }))
      .catch((err) => {
        if (err.name === "AbortError") return;
        setState((s) => ({ data: s.data, error: err.message, loading: false }));
      });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  useEffect(() => {
    if (!refreshMs) return undefined;
    const id = setInterval(() => setTick((t) => t + 1), refreshMs);
    return () => clearInterval(id);
  }, [refreshMs]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}
