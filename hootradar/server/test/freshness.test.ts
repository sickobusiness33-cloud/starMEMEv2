import { describe, expect, it } from 'vitest';
import { classifyFreshness, parsePublishedDate } from '../src/research/freshness.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 1, 21, 10, 0);

describe('classifyFreshness', () => {
  it.each([
    [null, 'UNKNOWN'],
    [NOW, 'LIVE'],
    [NOW - 60 * MIN, 'LIVE'],
    [NOW - 60 * MIN - 1, 'RECENT'],
    [NOW - 24 * HOUR, 'RECENT'],
    [NOW - 24 * HOUR - 1, 'OLD'],
    [NOW + 10 * MIN, 'LIVE'],
    [NOW + 10 * MIN + 1, 'UNKNOWN'],
    [Number.NaN, 'UNKNOWN'],
  ] as const)('%s → %s', (publishedAt, expected) => {
    expect(classifyFreshness(publishedAt, NOW)).toBe(expected);
  });
});

describe('parsePublishedDate', () => {
  it.each([
    // ISO 8601
    ['2026-10-01T14:30:00Z', Date.UTC(2026, 9, 1, 14, 30)],
    ['2026-10-01T14:30:00.250Z', Date.UTC(2026, 9, 1, 14, 30, 0, 250)],
    ['2026-10-01T16:30:00+02:00', Date.UTC(2026, 9, 1, 14, 30)],
    ['2026-10-01T09:30:00-0500', Date.UTC(2026, 9, 1, 14, 30)],
    ['2026-10-01T14:30:00', Date.UTC(2026, 9, 1, 14, 30)], // no zone → UTC
    ['2026-10-01 14:30', Date.UTC(2026, 9, 1, 14, 30)],
    ['2026-10-01', Date.UTC(2026, 9, 1)],
    // RFC 2822
    ['Wed, 01 Oct 2026 14:30:00 GMT', Date.UTC(2026, 9, 1, 14, 30)],
    ['Wed, 1 Oct 2026 16:30:00 +0200', Date.UTC(2026, 9, 1, 14, 30)],
    ['01 Oct 2026 14:30 UTC', Date.UTC(2026, 9, 1, 14, 30)],
    // GDELT seendate and compact forms
    ['20261001T143000Z', Date.UTC(2026, 9, 1, 14, 30)],
    ['20261001143000', Date.UTC(2026, 9, 1, 14, 30)],
    ['20261001', Date.UTC(2026, 9, 1)],
    // epoch
    ['1790709704', 1790709704000],
    ['1790709704.5', 1790709704500],
    ['1790709704123', 1790709704123],
    // relative
    ['3 hours ago', NOW - 3 * HOUR],
    ['an hour ago', NOW - HOUR],
    ['1 minute ago', NOW - MIN],
    ['45 mins ago', NOW - 45 * MIN],
    ['5m ago', NOW - 5 * MIN],
    ['2 days ago', NOW - 48 * HOUR],
    ['just now', NOW],
    // month names
    ['Oct 1, 2026', Date.UTC(2026, 9, 1)],
    ['October 1, 2026', Date.UTC(2026, 9, 1)],
    ['Sept. 30, 2026', Date.UTC(2026, 8, 30)],
    ['October 1st 2026', Date.UTC(2026, 9, 1)],
    ['1 October 2026', Date.UTC(2026, 9, 1)],
    ['  Oct   1,  2026 ', Date.UTC(2026, 9, 1)],
  ])('%s', (raw, expected) => {
    expect(parsePublishedDate(raw, NOW)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    '',
    '   ',
    'yesterday',
    'a few minutes ago',
    'sometime last week',
    '2026-13-01',
    '2026-02-30T10:00:00Z',
    '20261341T250000Z',
    'Smarch 1, 2026',
    'Marching 1, 2026',
    '0',
    '12345',
    '01/10/2026', // day/month order is ambiguous
    'Wed, 01 Oct 2026 14:30:00', // RFC 2822 without a zone
    '10 parsecs ago',
  ])('%j → null', (raw) => {
    expect(parsePublishedDate(raw, NOW)).toBeNull();
  });

  it('feeds classifyFreshness end to end', () => {
    expect(classifyFreshness(parsePublishedDate('20 minutes ago', NOW), NOW)).toBe('LIVE');
    expect(classifyFreshness(parsePublishedDate('20261001T143000Z', NOW), NOW)).toBe('RECENT');
    expect(classifyFreshness(parsePublishedDate('Sep 1, 2026', NOW), NOW)).toBe('OLD');
    expect(classifyFreshness(parsePublishedDate('garbage', NOW), NOW)).toBe('UNKNOWN');
  });
});
