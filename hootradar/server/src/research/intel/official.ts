/*
 * The project's own channels (website, X, Telegram, Discord) as reported by
 * the market-data providers. Self-published by the team, so never dated.
 */
import type { IntelItem, TokenLink } from '../../../../shared/types.js';
import { stableId, type IntelQuery } from './match.js';

const TITLES: Partial<Record<TokenLink['type'], string>> = {
  website: 'Project website',
  twitter: 'Project X (Twitter) account',
  telegram: 'Project Telegram',
  discord: 'Project Discord',
};

export async function search(t: IntelQuery): Promise<IntelItem[]> {
  return officialItems(t.links);
}

export function officialItems(links: TokenLink[]): IntelItem[] {
  const seen = new Set<string>();
  const out: IntelItem[] = [];
  for (const link of links) {
    const title = TITLES[link.type];
    const host = hostOf(link.url);
    if (!title || !host || seen.has(link.url)) continue;
    seen.add(link.url);
    const handle = link.type === 'twitter' ? xHandle(link.url) : null;
    out.push({
      id: stableId('official', link.url),
      title: handle ? `${title} @${handle}` : title,
      url: link.url,
      sourceName: host,
      sourceType: 'official',
      provider: 'dexscreener',
      publishedAt: null,
      freshness: 'UNKNOWN',
      snippet: null,
      matchedOn: 'project',
    });
  }
  return out;
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
}

/** "https://x.com/bonk_inu" → "bonk_inu"; null for non-profile URLs (intents, status links). */
function xHandle(url: string): string | null {
  const m = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/.exec(url);
  const handle = m?.[1] ?? null;
  return handle && !['home', 'intent', 'i', 'search', 'share'].includes(handle.toLowerCase()) ? handle : null;
}
