import { useSyncExternalStore } from 'react';

/**
 * Shared tickers. Every relative timestamp in the app reads one of these two
 * clocks instead of owning an interval: one 15 s ticker for "18 min ago", one
 * 1 s ticker (aligned to the wall-clock second) for the UTC clock and the
 * chain "last scan" counters. Each ticker only runs while something listens.
 */
interface Ticker {
  subscribe: (fn: () => void) => () => void;
  get: () => number;
}

function createTicker(periodMs: number, alignToPeriod: boolean): Ticker {
  let now = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const listeners = new Set<() => void>();

  const emit = () => {
    now = Date.now();
    for (const fn of listeners) fn();
  };

  const schedule = () => {
    const wait = alignToPeriod ? periodMs - (Date.now() % periodMs) : periodMs;
    timer = setTimeout(() => {
      emit();
      schedule();
    }, wait);
  };

  const onVisible = () => {
    if (document.visibilityState === 'visible') emit();
  };

  return {
    subscribe(fn) {
      listeners.add(fn);
      if (listeners.size === 1) {
        now = Date.now();
        schedule();
        document.addEventListener('visibilitychange', onVisible);
      }
      return () => {
        listeners.delete(fn);
        if (listeners.size === 0) {
          if (timer) clearTimeout(timer);
          timer = null;
          document.removeEventListener('visibilitychange', onVisible);
        }
      };
    },
    get: () => now,
  };
}

const slow = createTicker(15_000, false);
const clock = createTicker(1_000, true);

/** `now`, refreshed every 15 s. For "18 min ago" style labels. */
export function useNow(): number {
  return useSyncExternalStore(slow.subscribe, slow.get, slow.get);
}

/** `now`, refreshed on every wall-clock second. For the UTC clock and second counters. */
export function useClock(): number {
  return useSyncExternalStore(clock.subscribe, clock.get, clock.get);
}

const idle = () => () => {};

/**
 * The 1 s clock, subscribed only while `active` (e.g. a countdown that is usually off).
 * While inactive the value is stale: read it as "re-render now", and pair it with Date.now().
 */
export function useClockWhile(active: boolean): number {
  return useSyncExternalStore(active ? clock.subscribe : idle, clock.get, clock.get);
}
