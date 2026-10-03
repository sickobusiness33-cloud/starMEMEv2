import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseChains, parseTrustProxy } from '../src/config.js';

describe('loadConfig', () => {
  it('has safe defaults', () => {
    const c = loadConfig({});
    expect(c.chains).toEqual(['solana', 'ethereum', 'base', 'bsc']);
    expect(c.autopublish).toBe(true);
    expect(c.thresholds).toEqual({ WATCH: 22, ALERT: 42, BREAKING: 60 });
    expect(c.breaking).toEqual({ minLiquidityUsd: 25_000, minVolumeH1Usd: 75_000 });
    expect(c.radar).toEqual({ webResearch: true, aiCallsPerHour: 60 });
    expect(c.trustProxy).toBe(false);
    expect(c.warnings).toEqual([]);
  });

  it('never scans chains the operator did not name', () => {
    // live: CHAINS=sol scanned all four chains (unknown names were dropped, then "none" meant "all")
    expect(() => loadConfig({ CHAINS: 'sol' })).toThrow(ConfigError);
    expect(() => loadConfig({ CHAINS: 'solana,eth' })).toThrow(/unknown chain "eth"/);
    expect(loadConfig({ CHAINS: ' Solana , base ' }).chains).toEqual(['solana', 'base']);
    expect(loadConfig({ CHAINS: '' }).chains).toEqual(['solana', 'ethereum', 'base', 'bsc']);
    expect(parseChains('base,base')).toEqual(['base']);
  });

  it('rejects a boolean it does not understand instead of reading it as false', () => {
    // live: AUTOPUBLISH=enabled silently disabled publishing
    expect(() => loadConfig({ AUTOPUBLISH: 'enabled' })).toThrow(/AUTOPUBLISH: expected true or false/);
    expect(loadConfig({ AUTOPUBLISH: 'off' }).autopublish).toBe(false);
    expect(loadConfig({ AUTOPUBLISH: 'YES' }).autopublish).toBe(true);
    expect(loadConfig({ AUTOPUBLISH: '' }).autopublish).toBe(true);
    expect(loadConfig({ RADAR_WEB_RESEARCH: 'false' }).radar.webResearch).toBe(false);
  });

  it('requires ordered thresholds and whole, non-negative counts', () => {
    expect(() => loadConfig({ THRESHOLD_WATCH: '80', THRESHOLD_ALERT: '10' })).toThrow(/WATCH < ALERT <= BREAKING/);
    expect(() => loadConfig({ THRESHOLD_ALERT: '70', THRESHOLD_BREAKING: '60' })).toThrow(/WATCH < ALERT <= BREAKING/);
    expect(loadConfig({ THRESHOLD_ALERT: '60', THRESHOLD_BREAKING: '60' }).thresholds.ALERT).toBe(60);
    expect(() => loadConfig({ MAX_ARTICLES_PER_HOUR: '-1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ARTICLE_COOLDOWN_MIN: '2.5' })).toThrow(ConfigError);
    expect(() => loadConfig({ MIN_LIQUIDITY_USD: '-5' })).toThrow(ConfigError);
    expect(() => loadConfig({ PORT: '99999' })).toThrow(ConfigError);
    expect(() => loadConfig({ AI_TIMEOUT_MS: 'abc' })).toThrow(ConfigError);
    expect(loadConfig({ MAX_ARTICLES_PER_HOUR: '0' }).maxArticlesPerHour).toBe(0);
  });

  it('reads the BREAKING size policy', () => {
    const c = loadConfig({ BREAKING_MIN_LIQUIDITY_USD: '40000', BREAKING_MIN_VOLUME_H1_USD: '150000' });
    expect(c.breaking).toEqual({ minLiquidityUsd: 40_000, minVolumeH1Usd: 150_000 });
  });
});

describe('TRUST_PROXY', () => {
  it('never trusts every hop', () => {
    expect(parseTrustProxy('')).toEqual({ value: false, warning: null });
    expect(parseTrustProxy('false').value).toBe(false);
    expect(parseTrustProxy('10.0.0.0/8, 172.16.0.0/12')).toEqual({ value: '10.0.0.0/8, 172.16.0.0/12', warning: null });

    // a number is a hop count: hop 0 is the socket peer
    const two = parseTrustProxy('2').value as (addr: string, hop: number) => boolean;
    expect([two('x', 0), two('x', 1), two('x', 2)]).toEqual([true, true, false]);
    expect(parseTrustProxy('0').value).toBe(false);

    // "true" used to trust every hop (spoofable X-Forwarded-For): now one hop, with a warning
    const legacy = parseTrustProxy('true');
    expect(typeof legacy.value).toBe('function');
    expect((legacy.value as (a: string, h: number) => boolean)('x', 1)).toBe(false);
    expect(legacy.warning).toMatch(/no longer trusts every hop/);
    expect(loadConfig({ TRUST_PROXY: 'yes' }).warnings).toHaveLength(1);
  });
});
