import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  IntelItem,
  KnownChainId,
  MarketRegime,
  RadarBrief,
  RadarReport,
  RadarStageId,
  TokenSnapshot,
} from '../../shared/types.js';
import { writeRadarBrief } from '../src/ai/brief.js';
import { CHAIN_CONFIGS } from '../src/chains/configs.js';
import type { ChainAdapter, TokenEnrichment } from '../src/chains/types.js';
import { loadConfig } from '../src/config.js';
import { openDb, type Db } from '../src/db/db.js';
import { gatherIntel } from '../src/research/intel/index.js';
import { MAX_QUERY_CHARS, RadarService, SMART_MONEY_REASON } from '../src/research/radar.js';
import { dsSearch, parseDsPairs } from '../src/sources/dexscreener.js';
import { parseGtTokenInfo } from '../src/sources/geckoterminal.js';
import { emptySnapshot } from '../src/sources/merge.js';

vi.mock('../src/sources/dexscreener.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/sources/dexscreener.js')>()),
  dsSearch: vi.fn(),
}));
vi.mock('../src/research/intel/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/research/intel/index.js')>()),
  gatherIntel: vi.fn(),
}));
vi.mock('../src/ai/brief.js', () => ({ writeRadarBrief: vi.fn() }));

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

const T0 = Date.UTC(2026, 9, 1, 21, 10);
const PEPE_ETH = '0x6982508145454Ce325dDbE47a25d4ec3d2311933';
const EVM_TOKEN = '0x1111111111111111111111111111111111111111';
const STAGE_IDS: RadarStageId[] = ['resolve', 'onchain', 'holders', 'quant', 'web', 'ai'];

/** Real DexScreener search response for "PEPE" (30 tokens on 9 chains). */
const SEARCH = parseDsPairs(fixture('ds_search_pepe.json'), null, T0);
/** Real GeckoTerminal token info (holders, top-10 share, security flags). */
const ENRICHMENT = parseGtTokenInfo(fixture('gt_token_info_bonk.json')) as TokenEnrichment;

const REGIME: MarketRegime = { label: 'neutral', breadthPct: 51, medianH1ChangePct: 0.4, sampleSize: 80, computedAt: T0 };
const BRIEF: RadarBrief = {
  summary: 'Summary.',
  bullets: ['a', 'b', 'c'],
  outlook: { bullish: 'b', neutral: 'n', risk: 'r' },
  engine: 'rules',
  model: null,
};
const INTEL: IntelItem = {
  id: 'gdelt:1',
  title: 'Pepe (PEPE) rallies',
  url: 'https://coindesk.com/pepe',
  sourceName: 'coindesk.com',
  sourceType: 'specialized',
  provider: 'gdelt',
  publishedAt: T0 - 600_000,
  freshness: 'LIVE',
  snippet: null,
  matchedOn: 'symbol',
};

function stubAdapter(id: KnownChainId, over: Partial<ChainAdapter> = {}): ChainAdapter {
  const config = CHAIN_CONFIGS[id];
  return {
    config,
    discover: vi.fn(async () => []),
    refresh: vi.fn(async () => []),
    enrich: vi.fn(async () => null),
    lookup: vi.fn(async () => null),
    isAddress: (q) => config.addressPattern.test(q.trim()),
    normalizeAddress: (a) => (config.caseInsensitiveAddress ? a.trim().toLowerCase() : a.trim()),
    ...over,
  };
}

function snapshot(chain: KnownChainId, address: string, over: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    ...emptySnapshot(chain, address, T0),
    symbol: 'TEST',
    name: 'Test Token',
    priceUsd: 0.01,
    marketCapUsd: 1_000_000,
    fdvUsd: 1_000_000,
    liquidityUsd: 100_000,
    volumeUsd: { m5: 1_000, h1: 20_000, h24: 300_000 },
    priceChangePct: { m5: 1, h1: 5, h24: 20 },
    txns: { m5: { buys: 10, sells: 5, buyers: null, sellers: null }, h1: { buys: 120, sells: 80, buyers: null, sellers: null } },
    createdAt: T0 - 5 * 3_600_000,
    sources: ['dexscreener'],
    ...over,
  };
}

interface Harness {
  service: RadarService;
  db: Db;
  adapters: Record<KnownChainId, ChainAdapter>;
  clock: { now: number };
}

function harness(over: Partial<Record<KnownChainId, Partial<ChainAdapter>>> = {}): Harness {
  const adapters = {
    solana: stubAdapter('solana', over.solana),
    ethereum: stubAdapter('ethereum', over.ethereum),
    base: stubAdapter('base', over.base),
    bsc: stubAdapter('bsc', over.bsc),
  };
  const db = openDb(':memory:');
  const clock = { now: T0 };
  const service = new RadarService({
    adapters: Object.values(adapters),
    db,
    config: loadConfig({ NEWS_LANG: 'en' }),
    regime: () => REGIME,
    now: () => clock.now,
  });
  return { service, db, adapters, clock };
}

/** Every notification until the final one. */
function collect(service: RadarService, id: string): Promise<RadarReport[]> {
  return new Promise((resolve) => {
    const seen: RadarReport[] = [];
    const off = service.subscribe(id, (r) => {
      seen.push(r);
      if (r.status !== 'running') {
        off();
        resolve(seen);
      }
    });
  });
}

beforeEach(() => {
  vi.mocked(dsSearch).mockReset().mockResolvedValue(SEARCH);
  vi.mocked(gatherIntel)
    .mockReset()
    .mockResolvedValue({
      items: [INTEL],
      providers: [
        { provider: 'gdelt', ok: true, count: 1, error: null },
        { provider: 'hn', ok: false, count: 0, error: 'HTTP 503' },
      ],
    });
  vi.mocked(writeRadarBrief).mockReset().mockResolvedValue(BRIEF);
});

describe('RadarService — symbol search', () => {
  it('runs the six stages in order and builds the full report', async () => {
    const ethLookup = vi.fn(async (address: string) => {
      const fromSearch = SEARCH.find((s) => s.address === address && s.chain === 'ethereum');
      return fromSearch ? { ...fromSearch, chain: 'ethereum', sources: ['geckoterminal', 'dexscreener'] } : null;
    });
    const { service, db, adapters } = harness({
      ethereum: { lookup: ethLookup, enrich: vi.fn(async () => ENRICHMENT) },
    });

    const started = service.start('  $PEPE ');
    expect(started.status).toBe('running');
    expect(started.query).toBe('PEPE');
    expect(started.stages.map((s) => [s.id, s.label, s.status])).toEqual([
      ['resolve', 'Resolve', 'pending'],
      ['onchain', 'On-chain', 'pending'],
      ['holders', 'Holders', 'pending'],
      ['quant', 'Quant', 'pending'],
      ['web', 'Web intel', 'pending'],
      ['ai', 'AI brief', 'pending'],
    ]);

    const updates = await collect(service, started.id);
    const final = updates[updates.length - 1]!;

    // stages start strictly in order, each after the previous one ended
    const runningOrder = updates.flatMap((u, i) => {
      const prev = updates[i - 1];
      return u.stages.filter((s) => s.status === 'running' && prev?.stages.find((p) => p.id === s.id)?.status !== 'running').map((s) => s.id);
    });
    expect(runningOrder).toEqual(STAGE_IDS);
    expect(final.stages.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done']);
    expect(final.status).toBe('done');
    expect(final.error).toBeNull();

    // resolution: the busiest exact match on a supported chain, 6 more as candidates; the ticker is
    // also searched as "$PEPE", and both result sets are merged without duplicates
    expect(dsSearch).toHaveBeenCalledWith('PEPE');
    expect(dsSearch).toHaveBeenCalledWith('$PEPE');
    expect(final.token).toMatchObject({ chain: 'ethereum', address: PEPE_ETH, symbol: 'PEPE', name: 'Pepe' });
    expect(final.candidates).toHaveLength(6);
    expect(final.candidates.map((c) => c.chain)).toEqual(['solana', 'solana', 'solana', 'solana', 'solana', 'base']);
    expect(new Set(final.candidates.map((c) => c.address)).size).toBe(6);
    // real fixture: A1DB… reports $3.9M of liquidity on $86 of daily volume and must not outrank
    // 7nfd… ($3.66M liquidity, $255K volume)
    expect(final.candidates[0]).toMatchObject({ address: '7nfd3f4sxQcMgxEbvNFu3UJstmLXcWUywAsts5xuiFF3' });
    expect(final.candidates.map((c) => c.address)).not.toContain('A1DBHWmtuYZMpLNXE9xr4B7crD8FAxwHSDnqnk8NwAKS');
    expect(final.stages[0]?.message).toBe('$PEPE on Ethereum via DexScreener search; 6 other matches');

    // on-chain + holders merged into one snapshot; metrics, detection and quant computed from it
    expect(ethLookup).toHaveBeenCalledWith(PEPE_ETH);
    expect(adapters.ethereum.enrich).toHaveBeenCalledWith(PEPE_ETH);
    expect(final.snapshot).toMatchObject({ chain: 'ethereum', holders: ENRICHMENT.holders, top10HolderPct: ENRICHMENT.top10HolderPct });
    expect(final.snapshot?.sources).toEqual(['geckoterminal', 'dexscreener']);
    expect(final.metrics?.ageMinutes).toBeGreaterThan(0);
    expect(final.detection?.score).toEqual(expect.any(Number));
    expect(final.quant?.disclaimer).toMatch(/not a forecast/);
    expect(final.stages[2]?.message).toMatch(/^1,024,516 holders · top 10 hold 38\.3%$/);

    // web + ai
    expect(final.intel).toEqual([INTEL]);
    expect(final.stages[4]?.message).toBe('1 mention · gdelt 1 · hn failed');
    expect(vi.mocked(gatherIntel).mock.calls[0]?.[0]).toMatchObject({ symbol: 'PEPE', name: 'Pepe', address: PEPE_ETH, chain: 'ethereum' });
    expect(writeRadarBrief).toHaveBeenCalledWith(
      expect.objectContaining({ lang: 'en', intel: [INTEL], snapshot: final.snapshot, quant: final.quant }),
    );
    expect(final.brief).toEqual(BRIEF);
    expect(final.unavailable).toEqual([{ field: 'smartMoney', reason: SMART_MONEY_REASON }]);

    // persisted (final state) and recorded as an observation for future history
    expect(db.getRadar(started.id)).toEqual(final);
    expect(db.history('ethereum', PEPE_ETH, 0)).toHaveLength(1);
    expect(service.get(started.id)).toEqual(final);
  });

  it('notifies subscribers synchronously with independent copies', async () => {
    const { service } = harness();
    const { id } = service.start('PEPE');
    const updates = await collect(service, id);
    expect(updates.length).toBeGreaterThan(STAGE_IDS.length * 2);
    expect(new Set(updates).size).toBe(updates.length);
    updates[0]!.query = 'mutated';
    expect(service.get(id)?.query).toBe('PEPE');
    // timestamps never go backwards
    const times = updates.map((u) => u.updatedAt);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it('keeps going when a subscriber throws', async () => {
    const { service } = harness();
    const { id } = service.start('PEPE');
    service.subscribe(id, () => {
      throw new Error('broken client');
    });
    const updates = await collect(service, id);
    expect(updates[updates.length - 1]?.status).toBe('done');
  });

  it('respects the chain filter', async () => {
    const { service } = harness();
    const { id } = service.start('PEPE', 'base');
    const final = (await collect(service, id)).pop()!;
    // every one of them has the symbol PEPE, so 24 h volume decides ($7.8K, $204, $30)
    expect(final.token).toMatchObject({ chain: 'base', name: 'BasedPepe', address: '0x52b492a33E447Cdb854c7FC19F1e57E8BfA1777D' });
    expect(final.candidates.map((c) => [c.chain, c.name])).toEqual([
      ['base', 'Pepe'],
      ['base', 'Pepe Army'],
    ]);
  });

  it('matches a symbol that carries its own "$" (dogwifhat is "$WIF" on-chain) as exact', async () => {
    const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
    const KNOCKOFF = '21AErpiB8uSb94oQKRcwuHqyHF93njAxBSbdUrpupump';
    vi.mocked(dsSearch).mockResolvedValue([
      snapshot('solana', KNOCKOFF, { symbol: 'Wif', name: 'Dog wif hat', liquidityUsd: 38_000, volumeUsd: { h24: 0.54 } }),
      snapshot('solana', WIF, { symbol: '$WIF', name: 'dogwifhat', liquidityUsd: 6_800_000, volumeUsd: { h24: 748_000 } }),
      // fake "liquidity": a worthless token quoted against a few dollars
      snapshot('solana', '2TDfKNETWL4Lf28oTErEHAwhqDrE5yd8uhEfEtbgM63m', {
        symbol: '$WIF',
        name: 'dogwifhat',
        liquidityUsd: 59_510_874,
        volumeUsd: { h24: 0.62 },
      }),
      snapshot('solana', 'WiFi1111111111111111111111111111', { symbol: 'WIFI', name: 'Wifi', liquidityUsd: 20_000_000 }),
    ]);
    const { service } = harness();
    const { id } = service.start('$WIF');
    const final = (await collect(service, id)).pop()!;
    expect(final.token).toMatchObject({ address: WIF, symbol: '$WIF' });
    expect(final.stages[0]?.message).toBe('$WIF on Solana via DexScreener search; 3 other matches');
    expect(final.candidates.map((c) => c.address)).toEqual([
      '2TDfKNETWL4Lf28oTErEHAwhqDrE5yd8uhEfEtbgM63m',
      KNOCKOFF,
      'WiFi1111111111111111111111111111',
    ]);
  });

  it('falls back to search data when the full lookup fails', async () => {
    const { service } = harness({ ethereum: { lookup: vi.fn(async () => Promise.reject(new Error('GT down'))) } });
    const { id } = service.start('pepe');
    const final = (await collect(service, id)).pop()!;
    expect(final.status).toBe('done');
    expect(final.stages[1]).toMatchObject({ status: 'done', message: expect.stringContaining('full lookup failed (GT down)') });
    expect(final.snapshot?.liquidityUsd).toBe(32113393.11);
  });
});

describe('RadarService — address lookup', () => {
  it('looks the address up on every matching chain in parallel; the most liquid wins', async () => {
    const { service, adapters } = harness({
      ethereum: { lookup: vi.fn(async (a: string) => snapshot('ethereum', a, { liquidityUsd: 1_000_000 })) },
      base: { lookup: vi.fn(async (a: string) => snapshot('base', a, { liquidityUsd: 5_000_000 })) },
      bsc: { lookup: vi.fn(async () => null) },
    });
    const { id } = service.start(EVM_TOKEN);
    const final = (await collect(service, id)).pop()!;
    expect(final.token).toMatchObject({ chain: 'base', liquidityUsd: 5_000_000 });
    expect(final.candidates.map((c) => c.chain)).toEqual(['ethereum']);
    expect(adapters.solana.lookup).not.toHaveBeenCalled();
    expect(adapters.bsc.lookup).toHaveBeenCalledWith(EVM_TOKEN);
    expect(dsSearch).not.toHaveBeenCalled();
    expect(final.stages[0]?.message).toBe('$TEST on Base via address lookup; 1 other match');
    // an address-resolved token already has its full snapshot: no second lookup
    expect(adapters.base.lookup).toHaveBeenCalledTimes(1);
  });

  it('only queries the requested chain', async () => {
    const { service, adapters } = harness({
      ethereum: { lookup: vi.fn(async (a: string) => snapshot('ethereum', a)) },
    });
    const { id } = service.start(EVM_TOKEN, 'ethereum');
    const final = (await collect(service, id)).pop()!;
    expect(final.token?.chain).toBe('ethereum');
    expect(adapters.base.lookup).not.toHaveBeenCalled();
    expect(adapters.bsc.lookup).not.toHaveBeenCalled();
  });

  it('reports a provider failure as an error, not as "not found"', async () => {
    const down = { lookup: vi.fn(async () => Promise.reject(new Error('HTTP 503'))) };
    const { service } = harness({ ethereum: down, base: down, bsc: down });
    const { id } = service.start(EVM_TOKEN);
    const final = (await collect(service, id)).pop()!;
    expect(final.status).toBe('error');
    expect(final.error).toBe('Lookup failed (Ethereum: HTTP 503; Base: HTTP 503; BNB Chain: HTTP 503)');
  });
});

describe('RadarService — not found', () => {
  it('marks the report not_found and skips the remaining stages', async () => {
    vi.mocked(dsSearch).mockResolvedValue(SEARCH.filter((s) => s.chain === 'tron'));
    const { service, db } = harness();
    const { id } = service.start('PePe');
    const updates = await collect(service, id);
    const final = updates[updates.length - 1]!;
    expect(final.status).toBe('not_found');
    expect(final.error).toBe('No token matching "PePe" on Solana, Ethereum, Base, BNB Chain');
    expect(final.stages.map((s) => s.status)).toEqual(['error', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(final.token).toBeNull();
    expect(final.unavailable).toEqual([{ field: 'smartMoney', reason: SMART_MONEY_REASON }]);
    expect(gatherIntel).not.toHaveBeenCalled();
    expect(db.getRadar(id)?.status).toBe('not_found');
  });

  it('is not_found when every chain answered without the address', async () => {
    const { service } = harness();
    const { id } = service.start(EVM_TOKEN);
    const final = (await collect(service, id)).pop()!;
    expect(final.status).toBe('not_found');
    expect(final.error).toBe(`No token with address ${EVM_TOKEN} on Ethereum, Base, BNB Chain`);
  });

  it('is an error when the search provider fails', async () => {
    vi.mocked(dsSearch).mockRejectedValue(new Error('HTTP 429 from api.dexscreener.com/latest/dex/search'));
    const { service } = harness();
    const { id } = service.start('PEPE');
    const final = (await collect(service, id)).pop()!;
    expect(final.status).toBe('error');
    expect(final.error).toBe('HTTP 429 from api.dexscreener.com/latest/dex/search');
  });

  it('rejects an empty query and unsupported chains', async () => {
    const { service } = harness();
    const empty = service.start(' $ ');
    expect((await collect(service, empty.id)).pop()).toMatchObject({ status: 'not_found', error: 'Empty query' });
    const other = service.start('PEPE', 'tron');
    expect((await collect(service, other.id)).pop()).toMatchObject({ status: 'not_found', error: 'Chain "tron" is not supported' });
  });
});

describe('RadarService — unavailable data', () => {
  it('lists every core field it could not provide, with the reason, and keeps going', async () => {
    const bare = snapshot('base', EVM_TOKEN, {
      liquidityUsd: null,
      marketCapUsd: null,
      fdvUsd: 250_000,
      txns: {},
      volumeUsd: {},
      createdAt: null,
    });
    const { service } = harness({
      base: {
        lookup: vi.fn(async () => bare),
        enrich: vi.fn(async () => Promise.reject(new Error('HTTP 429 from api.geckoterminal.com'))),
      },
    });
    const { id } = service.start(EVM_TOKEN, 'base');
    const final = (await collect(service, id)).pop()!;

    expect(final.status).toBe('done');
    expect(final.stages.map((s) => s.status)).toEqual(['done', 'done', 'error', 'done', 'done', 'done']);
    expect(final.stages[2]?.message).toBe('HTTP 429 from api.geckoterminal.com');
    expect(final.unavailable).toEqual([
      { field: 'smartMoney', reason: SMART_MONEY_REASON },
      { field: 'holders', reason: 'The holder data provider failed: HTTP 429 from api.geckoterminal.com' },
      { field: 'liquidity', reason: expect.stringMatching(/^No liquidity reported/) },
      { field: 'marketCap', reason: expect.stringMatching(/only the fully diluted valuation/) },
      { field: 'txns', reason: expect.stringMatching(/^Transaction counts not reported/) },
      { field: 'ageMinutes', reason: 'Creation time not reported by the providers.' },
    ]);
    expect(final.metrics?.ageMinutes).toBeNull();
    expect(final.brief).toEqual(BRIEF);
  });

  it('explains a token the holder provider has not indexed yet', async () => {
    const { service } = harness({
      base: { lookup: vi.fn(async (a: string) => snapshot('base', a)), enrich: vi.fn(async () => null) },
    });
    const { id } = service.start(EVM_TOKEN, 'base');
    const final = (await collect(service, id)).pop()!;
    expect(final.stages[2]).toMatchObject({ status: 'done', message: 'Token not indexed by the holder data provider yet' });
    expect(final.unavailable.map((u) => u.field)).toEqual(['smartMoney', 'holders']);
    expect(final.unavailable[1]?.reason).toBe('The token is not indexed by the holder data provider yet.');
  });

  it('marks the web stage as error when every intel provider failed', async () => {
    vi.mocked(gatherIntel).mockResolvedValue({
      items: [],
      providers: [
        { provider: 'gdelt', ok: false, count: 0, error: 'x' },
        { provider: 'hn', ok: false, count: 0, error: 'y' },
      ],
    });
    const { service } = harness({ base: { lookup: vi.fn(async (a: string) => snapshot('base', a)) } });
    const { id } = service.start(EVM_TOKEN, 'base');
    const final = (await collect(service, id)).pop()!;
    expect(final.status).toBe('done');
    expect(final.stages[4]).toMatchObject({ status: 'error', message: 'Every intel provider failed (gdelt failed · hn failed)' });
    expect(final.stages[5]?.status).toBe('done');
  });
});

describe('RadarService — lifecycle', () => {
  it('joins a repeated submit within 20 s instead of starting again', async () => {
    const { service, clock } = harness();
    const first = service.start('PEPE');
    expect(service.start('$pepe ').id).toBe(first.id);
    expect(service.start('PEPE', 'solana').id).not.toBe(first.id);
    await collect(service, first.id);
    clock.now += 19_000;
    expect(service.start('PEPE').id).toBe(first.id);
    clock.now += 2_000;
    expect(service.start('PEPE').id).not.toBe(first.id);
  });

  it('caps the query at 120 characters', () => {
    const { service } = harness();
    expect(service.start(`$${'a'.repeat(200)}`).query).toHaveLength(MAX_QUERY_CHARS);
  });

  it('reads older reports from the database and closes ones a restart interrupted', async () => {
    const { service, db } = harness();
    const { id } = service.start('PEPE');
    const final = (await collect(service, id)).pop()!;

    const fresh = new RadarService({ adapters: [], db, config: loadConfig({}), regime: () => REGIME, now: () => T0 });
    expect(fresh.get(id)).toEqual(final);
    expect(fresh.get('missing')).toBeNull();
    expect(fresh.subscribe(id, () => {})).toBeTypeOf('function');

    const orphan: RadarReport = { ...final, id: 'orphan', status: 'running', stages: final.stages.map((s) => ({ ...s, status: 'pending' })) };
    db.saveRadar(orphan);
    expect(fresh.get('orphan')).toMatchObject({
      status: 'error',
      error: 'Investigation interrupted (server restarted)',
      stages: STAGE_IDS.map((sid) => expect.objectContaining({ id: sid, status: 'skipped' })),
    });
  });
});
