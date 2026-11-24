import { useEffect, useState } from "react";

/** Wall-clock seconds, re-rendering the caller every `everyMs`. For countdowns only. */
export function useNow(everyMs = 1000): number {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}
