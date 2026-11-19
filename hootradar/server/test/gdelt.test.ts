import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../src/net/http.js';
import { resetGdeltCooldown, search } from '../src/research/intel/gdelt.js';

// Only the network call is replaced; query building, parsing and the cooldown are real.
vi.mock('../src/net/http.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/net/http.js')>()),
  fetchText: vi.fn(),
}));
const { fetchText } = await import('../src/net/http.js');

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 1, 21, 10);
const BONK = {
  symbol: 'Bonk',
  name: 'Bonk',
  address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  chain: 'solana',
  links: [],
};
const EMPTY = JSON.stringify({ articles: [] });
const throttled = () => new HttpError(503, 'https://api.gdeltproject.org/api/v2/doc/doc', 'HTTP 503 from api.gdeltproject.org/api/v2/doc/doc');

describe('GDELT cooldown', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    resetGdeltCooldown();
    vi.mocked(fetchText).mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('leaves GDELT alone after a throttling answer, doubling the wait, and resets on success', async () => {
    vi.mocked(fetchText).mockRejectedValue(throttled());
    await expect(search(BONK)).rejects.toThrow('HTTP 503');
    expect(fetchText).toHaveBeenCalledTimes(1);

    // inside the first minute: no request, an explicit reason instead
    vi.setSystemTime(T0 + 30_000);
    await expect(search(BONK)).rejects.toThrow(/GDELT unavailable after "HTTP 503 .*", next attempt in 30s/);
    expect(fetchText).toHaveBeenCalledTimes(1);

    // second failure doubles the cooldown to 2 minutes
    vi.setSystemTime(T0 + MIN);
    await expect(search(BONK)).rejects.toThrow('HTTP 503');
    vi.setSystemTime(T0 + 2 * MIN + 59_000);
    await expect(search(BONK)).rejects.toThrow(/next attempt in 1s/);
    expect(fetchText).toHaveBeenCalledTimes(2);

    vi.mocked(fetchText).mockResolvedValue(EMPTY);
    vi.setSystemTime(T0 + 3 * MIN);
    await expect(search(BONK)).resolves.toEqual([]);
    vi.mocked(fetchText).mockRejectedValue(throttled());
    await expect(search(BONK)).rejects.toThrow('HTTP 503');
    vi.setSystemTime(T0 + 4 * MIN); // back to a 1-minute cooldown after the success
    await expect(search(BONK)).rejects.toThrow('HTTP 503');
    expect(fetchText).toHaveBeenCalledTimes(5);
  });

  it('does not cool down on errors that say nothing about load', async () => {
    vi.mocked(fetchText).mockRejectedValue(new HttpError(400, 'https://api.gdeltproject.org/', 'HTTP 400'));
    await expect(search(BONK)).rejects.toThrow('HTTP 400');
    await expect(search(BONK)).rejects.toThrow('HTTP 400');
    expect(fetchText).toHaveBeenCalledTimes(2);
  });
});
