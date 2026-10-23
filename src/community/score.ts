import type { ActivityBand, CommunityReport, MentionSummary, OfficialPage } from './types';

export const MIN_FOLLOWERS = 10;

export const ACTIVITY_BANDS: ReadonlyArray<{ band: ActivityBand; min: number }> = [
  { band: 'active', min: 70 },
  { band: 'warming', min: 40 },
  { band: 'quiet', min: 0 },
];

export interface MentionInput {
  followers: number;
  likes: number;
  replies: number;
  reposts: number;
}

export interface CommunityInput {
  official?: {
    handle: string;
    name?: string;
    followers: number;
    tweets: ReadonlyArray<{ likes: number; replies: number; reposts: number }>;
  };
  mentions?: readonly MentionInput[];
  /** All mentions in the last 7 days (X's count), when only a sample was read. */
  mentionTotal?: number;
}

function clamp(value: number, max: number) {
  return Math.max(0, Math.min(max, value));
}

function average(values: readonly number[]) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** More followers help, but extra millions add little. */
export function followerPoints(followers: number, max = 30) {
  if (followers < MIN_FOLLOWERS) return 0;
  return clamp((Math.log10(followers) - 1) * 10, max);
}

/** Replies are worth more than likes: they are people talking on the page. */
export function replyPoints(averageReplies: number) {
  return clamp(Math.log10(1 + averageReplies) * 12, 20);
}

export function likePoints(averageLikes: number) {
  return clamp(Math.log10(1 + averageLikes) * 6, 12);
}

export function repostPoints(averageReposts: number) {
  return clamp(Math.log10(1 + averageReposts) * 5, 8);
}

/**
 * Larger accounts count for more. A 10-follower account is ignored.
 * Weight is log10(followers) times a little extra for that post’s engagement.
 */
export function mentionWeight(mention: MentionInput) {
  if (mention.followers < MIN_FOLLOWERS) return 0;
  const size = Math.log10(mention.followers);
  const buzz = 1 + mention.replies / 5 + mention.likes / 20 + mention.reposts / 10;
  return size * buzz;
}

/**
 * Mention points were tuned on the 50 most recent mentions. We now read a smaller recent
 * sample and X's count of all mentions, so scale the sample up to what 50 (or fewer, when
 * there were fewer) would have weighed. Busy tokens hit the 30-point cap either way.
 */
export const MENTION_SCALE_TO = 50;

export function scaledWeights(weights: readonly number[], sampled: number, total: number | undefined): number[] {
  if (total === undefined || sampled === 0) return [...weights];
  const factor = Math.max(1, Math.min(total, MENTION_SCALE_TO) / sampled);
  return weights.map((weight) => weight * factor);
}

export function mentionPoints(weights: readonly number[]) {
  const total = weights.reduce((sum, value) => sum + value, 0);
  return clamp(Math.log10(1 + total) * 14, 30);
}

export function scoreCommunity(input: CommunityInput): CommunityReport {
  const official = summariseOfficial(input.official);
  const mentions = summariseMentions(input.mentions ?? [], input.mentionTotal);

  const fromPage = official
    ? followerPoints(official.followers) +
      replyPoints(official.averageReplies) +
      likePoints(official.averageLikes) +
      repostPoints(official.averageReposts)
    : 0;
  const sample = input.mentions ?? [];
  const fromMentions = mentionPoints(
    scaledWeights(sample.map(mentionWeight).filter((weight) => weight > 0), sample.length, input.mentionTotal),
  );

  // Without an official page, mentions can only show a weak signal.
  const raw = official ? fromPage + fromMentions : Math.min(40, fromMentions);
  const hasAnything = Boolean(official) || mentions.counted > 0;
  const score = hasAnything ? Math.round(clamp(raw, 100)) : null;
  const band = score === null ? null : (ACTIVITY_BANDS.find(({ min }) => score >= min)?.band ?? 'quiet');

  return { score, band, official, mentions };
}

function summariseOfficial(page: CommunityInput['official']): OfficialPage | undefined {
  if (!page) return undefined;
  const tweets = page.tweets;
  return {
    handle: page.handle,
    name: page.name,
    followers: page.followers,
    tweetsLookedAt: tweets.length,
    averageLikes: average(tweets.map((tweet) => tweet.likes)),
    averageReplies: average(tweets.map((tweet) => tweet.replies)),
    averageReposts: average(tweets.map((tweet) => tweet.reposts)),
  };
}

function summariseMentions(mentions: readonly MentionInput[], total?: number): MentionSummary {
  let counted = 0;
  let ignoredBots = 0;
  let weightedReach = 0;
  for (const mention of mentions) {
    const weight = mentionWeight(mention);
    if (weight === 0) ignoredBots += 1;
    else {
      counted += 1;
      weightedReach += weight;
    }
  }
  return total === undefined ? { counted, ignoredBots, weightedReach } : { counted, ignoredBots, weightedReach, total };
}
