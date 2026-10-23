import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatSummary, scoreCommunity } from '../community/score';
import { handleSocials } from '../server/api';
import { chatLinksFromDexScreener, parseTelegramPage } from './chats';

afterEach(() => vi.unstubAllGlobals());

describe('chat links', () => {
  it('finds the Telegram name and Discord invite among DexScreener socials', () => {
    const pairs = [{ chainId: 'solana', info: { socials: [
      { type: 'twitter', url: 'https://x.com/pepe' },
      { type: 'telegram', url: 'https://t.me/pepe_portal' },
      { type: 'discord', url: 'https://discord.gg/pepe-army' },
    ] } }];
    expect(chatLinksFromDexScreener(pairs)).toEqual({ telegram: 'pepe_portal', discord: 'pepe-army' });
    expect(chatLinksFromDexScreener([{ chainId: 'eth', info: { socials: [
      { url: 'https://t.me/+AbCdEf123' },
      { url: 'https://discord.com/invite/abc' },
    ] } }])).toEqual({ discord: 'abc' });
  });
});

describe('parseTelegramPage', () => {
  it('reads groups and channels', () => {
    expect(parseTelegramPage('<div class="tgme_page_extra">12 345 members, 678 online</div>')).toEqual({ kind: 'group', members: 12_345, online: 678 });
    expect(parseTelegramPage('<div class="tgme_page_extra">1 204 567 subscribers</div>')).toEqual({ kind: 'channel', members: 1_204_567 });
    expect(parseTelegramPage('<html>no preview</html>')).toBeUndefined();
  });
});

describe('chat points', () => {
  it('counts people online more than members, and nothing for a big group nobody is in', () => {
    const real = chatSummary({ members: 10_000, online: 400 })!;
    const bought = chatSummary({ members: 50_000, online: 40 })!;
    expect(real.quiet).toBe(false);
    expect(bought.quiet).toBe(true);
    expect(real.points).toBeGreaterThan(bought.points);
    expect(real.points).toBeLessThanOrEqual(13);
  });

  it('adds at most 15 points, and gives a score to tokens that only have chats', () => {
    const official = { handle: 'pepe', followers: 50_000, tweets: [{ likes: 100, replies: 20, reposts: 10 }] };
    const without = scoreCommunity({ official }).score!;
    const big = { members: 100_000, online: 9_000 };
    expect(scoreCommunity({ official, telegram: big, discord: big }).score! - without).toBeLessThanOrEqual(15);
    expect(scoreCommunity({ telegram: { members: 3_000, online: 200 } })).toMatchObject({ score: expect.any(Number), band: 'quiet' });
  });
});

describe('handleSocials', () => {
  it('fetches both counts once and answers repeats from its cache', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.startsWith('https://t.me/')
        ? new Response('<div class="tgme_page_extra">2 000 members, 150 online</div>')
        : Response.json({ approximate_member_count: 900, approximate_presence_count: 120 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const query = new URLSearchParams({ telegram: 'cachetest_group', discord: 'cache-test' });
    const first = await handleSocials(query, 'ip');
    expect(first.body).toEqual({
      telegram: { name: 'cachetest_group', kind: 'group', members: 2_000, online: 150 },
      discord: { code: 'cache-test', members: 900, online: 120 },
    });
    await handleSocials(query, 'ip');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await handleSocials(new URLSearchParams({ telegram: 'x/../../etc' }), 'ip')).body).toEqual({});
  });
});
