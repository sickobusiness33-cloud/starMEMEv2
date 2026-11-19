import { describe, expect, it } from 'vitest';
import { fmtDate } from '../lib/format';
import { freshnessOf, parseProviders } from './IntelList';

describe('intel dates', () => {
  it('a day-precision item is never LIVE', () => {
    expect(freshnessOf({ freshness: 'LIVE', publishedPrecision: 'day' })).toBe('RECENT');
    expect(freshnessOf({ freshness: 'RECENT', publishedPrecision: 'day' })).toBe('RECENT');
    expect(freshnessOf({ freshness: 'LIVE', publishedPrecision: 'exact' })).toBe('LIVE');
    expect(freshnessOf({ freshness: 'LIVE' })).toBe('LIVE');
  });

  it('formats the UTC calendar day of a day-precision timestamp', () => {
    expect(fmtDate(Date.UTC(2026, 9, 1))).toBe('2026-10-01');
    expect(fmtDate(null)).toBe('—');
  });

  it('still parses the stage-message fallback for provider statuses', () => {
    expect(parseProviders('12 mentions · gdelt 3 · hn 0 · biz failed')).toEqual([
      { provider: 'gdelt', ok: true, count: 3, error: null },
      { provider: 'hn', ok: true, count: 0, error: null },
      { provider: 'biz', ok: false, count: null, error: null },
    ]);
  });
});
