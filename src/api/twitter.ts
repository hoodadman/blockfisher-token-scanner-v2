import { MIN_FOLLOWERS, scoreCommunity, type CommunityReport, type MentionInput } from '../community';
import type { NamedBacker } from '../foundation';
import type { ChatCounts } from './chats';
import { apiHosts } from './hosts';
import { SHARE_HEADER, savedAt } from './share';

/**
 * X charges per post ($0.005) and per account ($0.010) returned, so read only what moves
 * the score: a recent sample of mentions plus X's count of all of them ($0.005 a call),
 * the account's last 15 posts, and at most 5 accounts named in its bio.
 */
const MENTION_SAMPLE = 10;
const OWN_POSTS = 15;
const BIO_PEOPLE = 5;

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
  includes?: { users?: TwitterUser[] };
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
}

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

function searchQuery(symbol?: string, name?: string, handle?: string) {
  const parts: string[] = [];
  const ticker = symbol?.replace(/[^A-Za-z0-9]/g, '');
  if (ticker) parts.push(`$${ticker}`, `#${ticker}`);
  const phrase = name?.trim();
  if (phrase && phrase.length <= 40) parts.push(`"${phrase.replaceAll('"', '')}"`);
  if (parts.length === 0) return undefined;
  const exclude = handle ? ` -from:${handle}` : '';
  return `(${parts.join(' OR ')}) -is:retweet${exclude}`;
}

async function fetchProfile(handle: string, signal?: AbortSignal, share?: Share): Promise<TwitterProfile | undefined> {
  const user = await getJson<{ data?: TwitterUser }>(
    `/2/users/by/username/${encodeURIComponent(handle)}?user.fields=public_metrics,name,username,description,url,entities`,
    signal,
    share,
  );
  if (!user.data?.id) return undefined;
  return {
    id: user.data.id,
    handle: user.data.username ?? handle,
    name: user.data.name,
    followers: user.data.public_metrics?.followers_count ?? 0,
    bio: user.data.description,
    urls: urlsFrom(user.data),
    mentions: mentionsFrom(user.data).filter((name) => name !== (user.data?.username ?? handle).toLowerCase()),
  };
}

async function fetchTweets(userId: string, signal?: AbortSignal, share?: Share) {
  try {
    const page = await getJson<TwitterPage<TwitterTweet>>(
      `/2/users/${userId}/tweets?max_results=${OWN_POSTS}&exclude=retweets,replies&tweet.fields=public_metrics`,
      signal,
      share,
    );
    return (page.data ?? []).map(tweetStats);
  } catch (error) {
    if (error instanceof TwitterError) return [];
    throw error;
  }
}

async function lookupPeople(usernames: readonly string[], signal?: AbortSignal, share?: Share): Promise<NamedBacker[]> {
  const unique = [...new Set(usernames)].slice(0, BIO_PEOPLE);
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

async function fetchMentions(query: string, signal?: AbortSignal, share?: Share): Promise<MentionInput[]> {
  const path =
    `/2/tweets/search/recent?query=${encodeURIComponent(query)}` +
    `&max_results=${MENTION_SAMPLE}&tweet.fields=public_metrics,author_id&expansions=author_id&user.fields=public_metrics`;
  const page = await getJson<TwitterPage<TwitterTweet>>(path, signal, share);
  const authors = new Map((page.includes?.users ?? []).map((user) => [user.id, user]));
  return (page.data ?? []).map((tweet) => {
    const author = tweet.author_id ? authors.get(tweet.author_id) : undefined;
    return {
      followers: author?.public_metrics?.followers_count ?? 0,
      ...tweetStats(tweet),
    };
  });
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
  input: { handle?: string; name?: string; symbol?: string },
  signal?: AbortSignal,
  shareSeconds?: number,
): Promise<TwitterBundle> {
  const share: Share = { seconds: shareSeconds };
  const query = searchQuery(input.symbol, input.name, input.handle);
  const [profileResult, mentionResult, totalResult] = await Promise.allSettled([
    input.handle ? fetchProfile(input.handle, signal, share) : Promise.resolve(undefined),
    query ? fetchMentions(query, signal, share) : Promise.resolve([]),
    query ? fetchMentionTotal(query, signal, share) : Promise.resolve(undefined),
  ]);
  if (profileResult.status === 'rejected' && mentionResult.status === 'rejected') {
    throw profileResult.reason;
  }
  const profile = profileResult.status === 'fulfilled' ? profileResult.value : undefined;
  const [tweets, mentionedPeople] = await Promise.all([
    profile ? fetchTweets(profile.id, signal, share) : Promise.resolve([]),
    profile?.mentions.length ? lookupPeople(profile.mentions, signal, share) : Promise.resolve([]),
  ]);
  return {
    checkedAt: share.oldest,
    profile,
    tweets,
    mentionedPeople,
    mentions: mentionResult.status === 'fulfilled' ? mentionResult.value : [],
    mentionTotal: totalResult.status === 'fulfilled' ? totalResult.value : undefined,
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
  });
}

export { MIN_FOLLOWERS, TwitterError };
