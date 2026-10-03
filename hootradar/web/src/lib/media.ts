import { useCallback, useSyncExternalStore } from 'react';

/** Narrow layout breakpoint (bottom tab bar, compact controls). Keep in sync with the CSS `max-width: 719.98px` queries. */
export const PHONE_QUERY = '(max-width: 719.98px)';
/** LIVE's two-column layout (feed + sticky rail). Keep in sync with the CSS `min-width: 1100px` queries. */
export const WIDE_QUERY = '(min-width: 1100px)';

/** Live `matchMedia` result; re-renders only when the query flips. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (fn: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', fn);
      return () => mql.removeEventListener('change', fn);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
