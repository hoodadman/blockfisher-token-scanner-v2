import { describe, expect, it } from 'vitest';
import { MIN_FOLLOWERS, mentionWeight, scaledWeights, scoreCommunity } from './score';

describe('scoreCommunity', () => {
  it('scores a busy official page more for replies than for likes', () => {
    const quietLikes = scoreCommunity({
      official: { handle: 'token', followers: 10_000, tweets: [{ likes: 80, replies: 0, reposts: 0 }] },
    });
    const talkative = scoreCommunity({
      official: { handle: 'token', followers: 10_000, tweets: [{ likes: 8, replies: 40, reposts: 0 }] },
    });
    expect(talkative.score ?? 0).toBeGreaterThan(quietLikes.score ?? 0);
    expect(talkative.official?.averageReplies).toBe(40);
  });

  it('ignores accounts with fewer than 10 followers', () => {
    const empty = scoreCommunity({
      official: { handle: 'token', followers: 8, tweets: [] },
      mentions: [{ followers: MIN_FOLLOWERS - 1, likes: 50, replies: 20, reposts: 10 }],
    });
    expect(empty.mentions).toEqual({ counted: 0, ignoredBots: 1, weightedReach: 0 });
    expect(empty.score).toBe(0);
  });

  it('gives larger accounts more weight than small ones', () => {
    const small = mentionWeight({ followers: 20, likes: 0, replies: 0, reposts: 0 });
    const large = mentionWeight({ followers: 20_000, likes: 0, replies: 0, reposts: 0 });
    expect(large).toBeGreaterThan(small * 2);
  });

  it('caps mentions-only results when there is no official page', () => {
    const mentions = Array.from({ length: 20 }, () => ({ followers: 50_000, likes: 30, replies: 10, reposts: 5 }));
    const report = scoreCommunity({ mentions });
    expect(report.official).toBeUndefined();
    expect(report.score).toBeLessThanOrEqual(40);
    expect(report.mentions.counted).toBe(20);
  });

  it('returns no score when nothing was found', () => {
    expect(scoreCommunity({})).toMatchObject({ score: null, band: null, mentions: { counted: 0, ignoredBots: 0 } });
  });
});

describe('mention sample', () => {
  it('scales a recent sample up to what the 50 most recent would have weighed', () => {
    expect(scaledWeights([2, 4], 15, 300)).toEqual([2 * 50 / 15, 4 * 50 / 15]);
    expect(scaledWeights([2, 4], 15, 30)).toEqual([4, 8]);
    // Fewer mentions than the sample, or no count: as read.
    expect(scaledWeights([2, 4], 15, 9)).toEqual([2, 4]);
    expect(scaledWeights([2, 4], 15, undefined)).toEqual([2, 4]);
  });

  it('scores a sample with the count about the same as all 50 posts', () => {
    const mention = (i: number) => ({ followers: 500 + i * 300, likes: i % 7, replies: i % 3, reposts: i % 2 });
    const all = Array.from({ length: 50 }, (_, i) => mention(i));
    const shuffled = [...all].sort((a, b) => ((a.followers * 7919) % 50) - ((b.followers * 7919) % 50));
    const full = scoreCommunity({ mentions: all.slice(0, 10) }).score!;
    const sampled = scoreCommunity({ mentions: shuffled.slice(0, 3), mentionTotal: 10 }).score!;
    expect(Math.abs(full - sampled)).toBeLessThanOrEqual(3);
    expect(scoreCommunity({ mentions: shuffled.slice(0, 15), mentionTotal: 400 }).mentions).toMatchObject({ counted: 15, total: 400 });
  });
});

