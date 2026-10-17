import { useEffect, useState } from 'react';

export const SEARCH_DELAY_MS = 1000;

export function scheduleSearchUpdate(update: () => void, delay = SEARCH_DELAY_MS) {
  const timer = setTimeout(update, delay);
  return () => clearTimeout(timer);
}

/** Keep typing local; only a settled query can trigger filtering or a request. */
export function useDebouncedValue<T>(value: T, delay = SEARCH_DELAY_MS): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => scheduleSearchUpdate(() => setSettled(value), delay), [value, delay]);
  return settled;
}
