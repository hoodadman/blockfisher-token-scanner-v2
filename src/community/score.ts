import type { ActivityBand, ChatSummary, CommunityReport, MentionSummary, OfficialPage } from './types';

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

export interface ChatInput {
  members?: number;
  /** Undefined when the platform doesn't say (Telegram channels). */
  online?: number;
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
  telegram?: ChatInput;
  discord?: ChatInput;
  /**
   * A basic check (Free): one post and a mention count, no sample of who is talking. Scored
   * cautiously: mentions earn at most half, and the whole score at most BASIC_MAX.
   */
  basic?: boolean;
}

/** A basic check can't tell a real crowd from a bought one, so it never scores as active. */
export const BASIC_MAX = 65;

/** Mention points from X's count alone, without knowing who posted: up to half the full 30. */
export function countPoints(total: number) {
  return clamp(Math.log10(1 + total) * 6, 15);
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

/** Below this share of members online, a big group looks bought. Real groups run 1-10%. */
export const MIN_ONLINE_SHARE = 0.005;
const CHATS_MAX = 15;

/**
 * Telegram and Discord. People online now count most: members are cheap to buy, people
 * online are not. A big member count with almost nobody online earns nothing for size.
 */
export function chatSummary(chat: ChatInput | undefined): ChatSummary | undefined {
  if (!chat || chat.members === undefined) return undefined;
  const members = chat.members;
  const quiet = chat.online !== undefined && members >= 2_000 && chat.online / members < MIN_ONLINE_SHARE;
  const fromOnline = chat.online === undefined ? 0 : clamp(Math.log10(1 + chat.online) * 4, 8);
  const fromSize = quiet ? 0 : clamp(Math.log10(1 + members) * (chat.online === undefined ? 1.5 : 1), 5);
  return { members, online: chat.online, quiet, points: fromOnline + fromSize };
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
  const fromMentions =
    input.basic && sample.length === 0
      ? countPoints(input.mentionTotal ?? 0)
      : mentionPoints(scaledWeights(sample.map(mentionWeight).filter((weight) => weight > 0), sample.length, input.mentionTotal));

  const telegram = chatSummary(input.telegram);
  const discord = chatSummary(input.discord);
  const fromChats = Math.min(CHATS_MAX, (telegram?.points ?? 0) + (discord?.points ?? 0));

  // Without an official page, mentions and chats can only show a weak signal.
  const raw = official ? fromPage + fromMentions + fromChats : Math.min(40, fromMentions + fromChats);
  const hasAnything =
    Boolean(official) || mentions.counted > 0 || Boolean(telegram) || Boolean(discord) || Boolean(input.basic && input.mentionTotal);
  const score = hasAnything ? Math.round(clamp(raw, input.basic ? BASIC_MAX : 100)) : null;
  const band = score === null ? null : (ACTIVITY_BANDS.find(({ min }) => score >= min)?.band ?? 'quiet');

  return { score, band, official, mentions, ...(telegram && { telegram }), ...(discord && { discord }), ...(input.basic && { basic: true }) };
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
