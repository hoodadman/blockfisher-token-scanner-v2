import { MIN_FOLLOWERS, scoreCommunity, type CommunityReport, type MentionInput } from '../community';
import type { NamedBacker } from '../foundation';
import { PLANS, type XDepth } from '../plans/plans';
import type { ChatCounts } from './chats';
import { apiHosts } from './hosts';
import { SHARE_HEADER, savedAt } from './share';

/**
 * X charges per post ($0.005) and per account ($0.010) returned, so read only what moves
 * the score: a recent sample of mentions plus X's count of all of them ($0.005 a call),
 * the account's latest posts, and a few accounts named in its bio. How many of each is
 * the plan's X depth (plans.ts).
 */

/** Two rounds of calls run one after the other, so keep each short. */
const TIMEOUT_MS = 10_000;

interface TwitterUser {
  id: string;
  name?: string;
  username?: string;
  description?: string;
  url?: string;
  public_metrics?: { followers_count?: number };
  entities?: {
    url?: { urls?: Array<{ expanded_url?: string; display_url?: string }> };
    description?: {
      urls?: Array<{ expanded_url?: string; display_url?: string }>;
      mentions?: Array<{ username?: string }>;
    };
  };
}

interface TwitterTweet {
  id?: string;
  author_id?: string;
  public_metrics?: {
    like_count?: number;
    reply_count?: number;
    retweet_count?: number;
    quote_count?: number;
  };
}

interface TwitterPage<T> {
  data?: T[];
  includes?: { users?: TwitterUser[]; tweets?: TwitterTweet[] };
}

export interface TwitterProfile {
  id: string;
  handle: string;
  name?: string;
  followers: number;
  bio?: string;
  urls: string[];
  mentions: string[];
}

export interface TwitterBundle {
  /** When the oldest of these answers was fetched (they may be shared; see share.ts). */
  checkedAt?: number;
  profile?: TwitterProfile;
  tweets: Array<{ likes: number; replies: number; reposts: number }>;
  mentionedPeople: NamedBacker[];
  mentions: MentionInput[];
  /** All mentions in the last 7 days, from X's count; undefined when the count failed. */
  mentionTotal?: number;
  /** How much of X this bundle read, so a deeper scan can read on from where it stopped. */
  read?: XDepth;
  /** The oldest post id read of each kind; a deeper scan asks X for posts before it. */
  oldest?: { mention?: string; post?: string };
  /** A basic check (Free): followers, the latest post and the mention count only. */
  basic?: boolean;
  /** The X search the mentions came from, so a deeper scan reads on with the same one. */
  query?: string;
}

/** Posts come newest first, so the last one is the oldest. */
const lastId = (tweets: readonly TwitterTweet[]) => tweets.at(-1)?.id;

class TwitterError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Twitter HTTP ${status}`);
    this.status = status;
  }
}

/** How old a shared answer each call accepts, and the oldest answer it got back. */
interface Share {
  seconds?: number;
  oldest?: number;
}

async function getJson<T>(path: string, signal?: AbortSignal, share: Share = {}): Promise<T> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const response = await fetch(`${apiHosts().twitter}${path}`, {
    headers: { accept: 'application/json', ...(share.seconds === undefined ? {} : { [SHARE_HEADER]: String(share.seconds) }) },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) throw new TwitterError(response.status);
  const at = savedAt(response);
  if (at !== undefined) share.oldest = Math.min(share.oldest ?? at, at);
  return (await response.json()) as T;
}

function tweetStats(tweet: TwitterTweet) {
  const metrics = tweet.public_metrics;
  return {
    likes: metrics?.like_count ?? 0,
    replies: metrics?.reply_count ?? 0,
    reposts: (metrics?.retweet_count ?? 0) + (metrics?.quote_count ?? 0),
  };
}

function urlsFrom(user: TwitterUser): string[] {
  const raw = [
    user.url,
    ...(user.entities?.url?.urls ?? []).map((item) => item.expanded_url ?? item.display_url),
    ...(user.entities?.description?.urls ?? []).map((item) => item.expanded_url ?? item.display_url),
  ];
  return [...new Set(raw.filter((url): url is string => Boolean(url && /^https?:/i.test(url))))];
}

function mentionsFrom(user: TwitterUser): string[] {
  const fromEntities = (user.entities?.description?.mentions ?? []).map((item) => item.username).filter(Boolean) as string[];
  const fromAt = [...(user.description ?? '').matchAll(/@([A-Za-z0-9_]{1,15})/g)].map((match) => match[1]);
  return [...new Set([...fromEntities, ...fromAt].map((name) => name.toLowerCase()))];
}

/** What the X search is built from: the token's names, its contract address and its DEX link. */
export interface XLookupInput {
  handle?: string;
  name?: string;
  symbol?: string;
  /** The contract address: posts that paste it, or link to any page with it in the URL. */
  address?: string;
  /** The DexScreener link of the token's main pool: posts that link to it. */
  dexPair?: string;
}

/** X's recent search takes queries up to 512 characters. */
const MAX_QUERY = 512;
const ADDRESS = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

/**
 * Posts about the token: its ticker, cashtag or name, or its contract address (pasted, or
 * in any link such as dexscreener.com/solana/<address> or pump.fun/coin/<address>), or a
 * link to its main DexScreener pool. The address and link tie mentions to this token, not
 * to a copycat with the same ticker. The project's own posts and reposts are left out.
 */
export function searchQuery(input: XLookupInput): string | undefined {
  const parts: string[] = [];
  const ticker = input.symbol?.replace(/[^A-Za-z0-9]/g, '');
  if (ticker) parts.push(`$${ticker}`, `#${ticker}`);
  const address = input.address && ADDRESS.test(input.address) ? input.address : undefined;
  if (address) parts.push(address, `url:${address}`);
  const phrase = input.name?.trim();
  if (phrase && phrase.length <= 40) parts.push(`"${phrase.replaceAll('"', '')}"`);
  const pair = input.dexPair?.replace(/^https?:\/\//, '');
  if (pair && /^dexscreener\.com\/[a-z0-9-]+\/[A-Za-z0-9]+$/.test(pair)) parts.push(`url:"${pair}"`);
  if (parts.length === 0) return undefined;
  const exclude = input.handle ? ` -from:${input.handle}` : '';
  // Drop the least specific extras (the pool link, then the name) if X's limit is near.
  let query = `(${parts.join(' OR ')}) -is:retweet${exclude}`;
  while (query.length > MAX_QUERY && parts.length > 1) {
    parts.pop();
    query = `(${parts.join(' OR ')}) -is:retweet${exclude}`;
  }
  return query;
}

const PROFILE_FIELDS = 'user.fields=public_metrics,name,username,description,url,entities';

function profileFrom(user: TwitterUser, handle: string): TwitterProfile {
  return {
    id: user.id,
    handle: user.username ?? handle,
    name: user.name,
    followers: user.public_metrics?.followers_count ?? 0,
    bio: user.description,
    urls: urlsFrom(user),
    mentions: mentionsFrom(user).filter((name) => name !== (user.username ?? handle).toLowerCase()),
  };
}

async function fetchProfile(handle: string, signal?: AbortSignal, share?: Share): Promise<TwitterProfile | undefined> {
  const user = await getJson<{ data?: TwitterUser }>(`/2/users/by/username/${encodeURIComponent(handle)}?${PROFILE_FIELDS}`, signal, share);
  return user.data?.id ? profileFrom(user.data, handle) : undefined;
}

async function fetchTweets(userId: string, count: number, signal?: AbortSignal, share?: Share, untilId?: string) {
  try {
    const page = await getJson<TwitterPage<TwitterTweet>>(
      // X answers 5 to 100 posts a page.
      `/2/users/${userId}/tweets?max_results=${Math.max(5, count)}&exclude=retweets,replies&tweet.fields=public_metrics${untilId ? `&until_id=${untilId}` : ''}`,
      signal,
      share,
    );
    const data = (page.data ?? []).slice(0, count);
    return { tweets: data.map(tweetStats), oldest: lastId(data) };
  } catch (error) {
    if (error instanceof TwitterError) return { tweets: [], oldest: undefined };
    throw error;
  }
}

async function lookupPeople(usernames: readonly string[], limit: number, signal?: AbortSignal, share?: Share, skip = 0): Promise<NamedBacker[]> {
  const unique = [...new Set(usernames)].slice(skip, limit);
  if (unique.length === 0) return [];
  try {
    const body = await getJson<{ data?: TwitterUser[] }>(
      `/2/users/by?usernames=${encodeURIComponent(unique.join(','))}&user.fields=public_metrics,username`,
      signal,
      share,
    );
    return (body.data ?? []).map((user) => ({
      handle: user.username ?? '',
      followers: user.public_metrics?.followers_count ?? 0,
    })).filter((person) => person.handle);
  } catch (error) {
    if (error instanceof TwitterError) return [];
    throw error;
  }
}

async function fetchMentions(
  query: string,
  count: number,
  signal?: AbortSignal,
  share?: Share,
  untilId?: string,
): Promise<{ mentions: MentionInput[]; oldest?: string }> {
  const path =
    // X answers 10 to 100 posts a page.
    `/2/tweets/search/recent?query=${encodeURIComponent(query)}` +
    `&max_results=${Math.max(10, count)}&tweet.fields=public_metrics,author_id&expansions=author_id&user.fields=public_metrics` +
    (untilId ? `&until_id=${untilId}` : '');
  const page = await getJson<TwitterPage<TwitterTweet>>(path, signal, share);
  const authors = new Map((page.includes?.users ?? []).map((user) => [user.id, user]));
  const data = (page.data ?? []).slice(0, count);
  const mentions = data.map((tweet) => {
    const author = tweet.author_id ? authors.get(tweet.author_id) : undefined;
    return {
      followers: author?.public_metrics?.followers_count ?? 0,
      ...tweetStats(tweet),
    };
  });
  return { mentions, oldest: lastId(data) };
}

/** How many posts mentioned the token in the last 7 days. One flat-priced call. */
async function fetchMentionTotal(query: string, signal?: AbortSignal, share?: Share): Promise<number | undefined> {
  try {
    const body = await getJson<{ meta?: { total_tweet_count?: number } }>(
      `/2/tweets/counts/recent?query=${encodeURIComponent(query)}&granularity=day`,
      signal,
      share,
    );
    return typeof body.meta?.total_tweet_count === 'number' ? body.meta.total_tweet_count : undefined;
  } catch (error) {
    if (error instanceof TwitterError) return undefined;
    throw error;
  }
}

export async function fetchTwitterBundle(
  input: XLookupInput,
  signal?: AbortSignal,
  shareSeconds?: number,
  depth: XDepth = PLANS.pro.x,
): Promise<TwitterBundle> {
  const share: Share = { seconds: shareSeconds };
  const query = searchQuery(input);
  const [profileResult, mentionResult, totalResult] = await Promise.allSettled([
    input.handle ? fetchProfile(input.handle, signal, share) : Promise.resolve(undefined),
    query ? fetchMentions(query, depth.mentions, signal, share) : Promise.resolve({ mentions: [], oldest: undefined }),
    query ? fetchMentionTotal(query, signal, share) : Promise.resolve(undefined),
  ]);
  if (profileResult.status === 'rejected' && mentionResult.status === 'rejected') {
    throw profileResult.reason;
  }
  const profile = profileResult.status === 'fulfilled' ? profileResult.value : undefined;
  const [posts, mentionedPeople] = await Promise.all([
    profile ? fetchTweets(profile.id, depth.ownPosts, signal, share) : Promise.resolve({ tweets: [], oldest: undefined }),
    profile?.mentions.length ? lookupPeople(profile.mentions, depth.bioPeople, signal, share) : Promise.resolve([]),
  ]);
  const sample = mentionResult.status === 'fulfilled' ? mentionResult.value : { mentions: [], oldest: undefined };
  return {
    checkedAt: share.oldest,
    profile,
    tweets: posts.tweets,
    mentionedPeople,
    mentions: sample.mentions,
    mentionTotal: totalResult.status === 'fulfilled' ? totalResult.value : undefined,
    read: depth,
    oldest: { mention: sample.oldest, post: posts.oldest },
    ...(query && { query }),
  };
}

/**
 * Reads on from a shallower bundle to `depth`: older mentions and posts than it saw, and
 * the bio accounts it didn't look up. The profile and mention count are reused, so a deep
 * scan after a recent standard one pays only for what is new. The result is the same
 * sample a deep scan would have read, give or take posts made in between.
 */
export async function expandTwitterBundle(
  base: TwitterBundle,
  input: XLookupInput,
  depth: XDepth,
  signal?: AbortSignal,
): Promise<TwitterBundle> {
  const read = base.read ?? PLANS.pro.x;
  const share: Share = {};
  // Read on with the search the saved mentions came from, so older pages line up.
  const query = base.query ?? searchQuery(input);
  // Fewer posts than asked for means X had no more; there is nothing older to read.
  const moreMentions = query && base.oldest?.mention && base.mentions.length >= read.mentions ? depth.mentions - read.mentions : 0;
  const morePosts = base.profile && base.oldest?.post && base.tweets.length >= read.ownPosts ? depth.ownPosts - read.ownPosts : 0;
  const morePeople = base.profile ? depth.bioPeople - read.bioPeople : 0;
  const [mentions, posts, people] = await Promise.all([
    moreMentions > 0 ? fetchMentions(query!, moreMentions, signal, share, base.oldest!.mention) : Promise.resolve({ mentions: [], oldest: undefined }),
    morePosts > 0 ? fetchTweets(base.profile!.id, morePosts, signal, share, base.oldest!.post) : Promise.resolve({ tweets: [], oldest: undefined }),
    morePeople > 0 && base.profile!.mentions.length > read.bioPeople
      ? lookupPeople(base.profile!.mentions, depth.bioPeople, signal, share, read.bioPeople)
      : Promise.resolve([]),
  ]);
  return {
    ...base,
    tweets: [...base.tweets, ...posts.tweets],
    mentions: [...base.mentions, ...mentions.mentions],
    mentionedPeople: [...base.mentionedPeople, ...people],
    read: depth,
    oldest: { mention: mentions.oldest ?? base.oldest?.mention, post: posts.oldest ?? base.oldest?.post },
  };
}

/**
 * What a basic check costs at most, in dollars. Usually the account with its latest post
 * ($0.015) and the mention count ($0.005): $0.02. If X won't send the latest post with
 * the account: the account ($0.010), 5 posts ($0.025) and the count, $0.04.
 */
export const BASIC_CHECK_MAX_COST = 0.04;

/**
 * Free's basic community check: the account's followers, the likes and replies on its
 * latest post, and how many posts mentioned the token in the last 7 days. About $0.02,
 * against $0.29 for a full check. Answers are shared like any other (`shareSeconds`), so
 * a recent full scan's profile and count cost nothing here. Returns what it cost at most.
 */
export async function fetchBasicBundle(
  input: XLookupInput,
  signal?: AbortSignal,
  shareSeconds?: number,
): Promise<{ bundle: TwitterBundle; cost: number }> {
  const share: Share = { seconds: shareSeconds };
  const query = searchQuery(input);
  let cost = 0;
  const profileWork = (async () => {
    if (!input.handle) return { profile: undefined, latest: [] as TwitterTweet[] };
    const path = `/2/users/by/username/${encodeURIComponent(input.handle)}?${PROFILE_FIELDS}`;
    try {
      // X can send the latest post with the account: one call, $0.015.
      const page = await getJson<{ data?: TwitterUser; includes?: { tweets?: TwitterTweet[] } }>(
        `${path},most_recent_tweet_id&expansions=most_recent_tweet_id&tweet.fields=public_metrics`,
        signal,
        share,
      );
      cost += 0.015;
      return { profile: page.data?.id ? profileFrom(page.data, input.handle) : undefined, latest: page.includes?.tweets ?? [] };
    } catch (error) {
      if (!(error instanceof TwitterError) || error.status !== 400) throw error;
      // Older or newer API versions may refuse that field: ask for the account, then its posts.
      const profile = await fetchProfile(input.handle, signal, share);
      cost += 0.01;
      if (!profile) return { profile, latest: [] };
      const page = await getJson<TwitterPage<TwitterTweet>>(
        `/2/users/${profile.id}/tweets?max_results=5&exclude=retweets,replies&tweet.fields=public_metrics`,
        signal,
        share,
      ).catch(() => ({ data: [] }) as TwitterPage<TwitterTweet>);
      cost += 0.025;
      return { profile, latest: (page.data ?? []).slice(0, 1) };
    }
  })();
  const [profileResult, totalResult] = await Promise.allSettled([
    profileWork,
    query ? fetchMentionTotal(query, signal, share).finally(() => (cost += 0.005)) : Promise.resolve(undefined),
  ]);
  if (profileResult.status === 'rejected' && (totalResult.status === 'rejected' || !query)) throw profileResult.reason;
  const found = profileResult.status === 'fulfilled' ? profileResult.value : { profile: undefined, latest: [] };
  return {
    bundle: {
      checkedAt: share.oldest,
      profile: found.profile,
      tweets: found.latest.slice(0, 1).map(tweetStats),
      mentionedPeople: [],
      mentions: [],
      mentionTotal: totalResult.status === 'fulfilled' ? totalResult.value : undefined,
      read: { mentions: 0, ownPosts: 1, bioPeople: 0 },
      basic: true,
      ...(query && { query }),
    },
    cost,
  };
}

export function communityFromBundle(bundle: TwitterBundle, chats: ChatCounts = {}): CommunityReport {
  return scoreCommunity({
    telegram: chats.telegram,
    discord: chats.discord,
    official: bundle.profile
      ? { handle: bundle.profile.handle, name: bundle.profile.name, followers: bundle.profile.followers, tweets: bundle.tweets }
      : undefined,
    mentions: bundle.mentions,
    mentionTotal: bundle.mentionTotal,
    basic: bundle.basic,
  });
}

export { MIN_FOLLOWERS, TwitterError };
