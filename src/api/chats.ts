import type { DexScreenerPair } from '../adapters';
import { apiHosts } from './hosts';

/**
 * Telegram and Discord member counts: free, and many tokens live there more than on X.
 * Members are cheap to fake (bought bots), so the score leans on how many are online.
 */
export interface ChatCount {
  members?: number;
  /** People online now. Telegram shows it for groups, not channels; Discord always. */
  online?: number;
}

export interface ChatCounts {
  telegram?: ChatCount & { name: string; kind: 'group' | 'channel' };
  discord?: ChatCount & { code: string };
}

export interface ChatLinks {
  telegram?: string;
  discord?: string;
}

export const TELEGRAM_NAME = /^[A-Za-z][A-Za-z0-9_]{3,31}$/;
export const DISCORD_CODE = /^[A-Za-z0-9-]{2,32}$/;

function telegramName(url: URL): string | undefined {
  if (!/^(www\.)?(t\.me|telegram\.me)$/i.test(url.hostname)) return undefined;
  const [first, second] = url.pathname.split('/').filter(Boolean);
  // t.me/s/<name> is the web preview of a channel; t.me/+<code> invite links have no public page.
  const name = first === 's' ? second : first;
  return name && TELEGRAM_NAME.test(name) ? name : undefined;
}

function discordCode(url: URL): string | undefined {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  const code = host === 'discord.gg' ? parts[0] : /^discord(app)?\.com$/.test(host) && parts[0] === 'invite' ? parts[1] : undefined;
  return code && DISCORD_CODE.test(code) ? code : undefined;
}

/** The first Telegram and Discord links among DexScreener's socials. */
export function chatLinksFromDexScreener(pairs: readonly DexScreenerPair[]): ChatLinks {
  const links: ChatLinks = {};
  for (const pair of pairs) {
    for (const social of pair.info?.socials ?? []) {
      let url: URL;
      try {
        url = new URL(social.url ?? '');
      } catch {
        continue;
      }
      links.telegram ??= telegramName(url);
      links.discord ??= discordCode(url);
    }
  }
  return links;
}

const number = (text: string) => Number(text.replace(/[\s,. ]/g, ''));

/**
 * Reads the counts from a public t.me/<name> page: "12 345 members, 678 online" for a
 * group, "12 345 subscribers" for a channel.
 */
export function parseTelegramPage(html: string): (ChatCount & { kind: 'group' | 'channel' }) | undefined {
  const extra = html.match(/class="tgme_page_extra"[^>]*>([^<]+)</)?.[1] ?? '';
  const members = extra.match(/([\d][\d\s,. ]*)\s+members?/i);
  const subscribers = extra.match(/([\d][\d\s,. ]*)\s+subscribers?/i);
  const online = extra.match(/([\d][\d\s,. ]*)\s+online/i);
  if (members) return { kind: 'group', members: number(members[1]), online: online ? number(online[1]) : 0 };
  if (subscribers) return { kind: 'channel', members: number(subscribers[1]) };
  return undefined;
}

/** Asks our server for both counts (it fetches t.me and Discord, which browsers can't). */
export async function fetchChatCounts(links: ChatLinks, signal?: AbortSignal): Promise<ChatCounts> {
  if (!links.telegram && !links.discord) return {};
  const query = new URLSearchParams();
  if (links.telegram) query.set('telegram', links.telegram);
  if (links.discord) query.set('discord', links.discord);
  const timeout = AbortSignal.timeout(8_000);
  const response = await fetch(`${apiHosts().socials}?${query}`, {
    headers: { accept: 'application/json' },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok) return {};
  return (await response.json()) as ChatCounts;
}
