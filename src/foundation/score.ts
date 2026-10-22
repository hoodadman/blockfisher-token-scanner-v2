import type { FoundationBand, FoundationFact, FoundationReport, NamedBacker } from './types';

const HOUR = 3_600_000;
const PRESALE_MIN = 10_000_000;
const KNOWN_PERSON = 10_000;

export const MAJOR_EXCHANGES: ReadonlyArray<{ id: string; label: string; match: RegExp }> = [
  { id: 'binance', label: 'Binance', match: /\bbinance\b/i },
  { id: 'coinbase', label: 'Coinbase', match: /\bcoinbase\b|\bgdax\b/i },
];

export const OTHER_EXCHANGES: ReadonlyArray<{ id: string; label: string; match: RegExp }> = [
  { id: 'kraken', label: 'Kraken', match: /\bkraken\b/i },
  { id: 'okx', label: 'OKX', match: /\bokx\b|\bokex\b/i },
  { id: 'bybit', label: 'Bybit', match: /\bbybit\b/i },
  { id: 'upbit', label: 'Upbit', match: /\bupbit\b/i },
  { id: 'kucoin', label: 'KuCoin', match: /\bkucoin\b/i },
  { id: 'bitfinex', label: 'Bitfinex', match: /\bbitfinex\b/i },
  { id: 'gemini', label: 'Gemini', match: /\bgemini\b/i },
  { id: 'crypto.com', label: 'Crypto.com', match: /crypto\.com/i },
];

export const INVESTORS: ReadonlyArray<{ id: string; label: string; match: RegExp }> = [
  { id: 'binance-labs', label: 'Binance Labs', match: /binance\s*labs/i },
  { id: 'coinbase-ventures', label: 'Coinbase Ventures', match: /coinbase\s*ventures/i },
  { id: 'a16z', label: 'a16z', match: /\ba16z\b|andreessen/i },
  { id: 'paradigm', label: 'Paradigm', match: /\bparadigm\b/i },
  { id: 'sequoia', label: 'Sequoia', match: /\bsequoia\b/i },
  { id: 'pantera', label: 'Pantera', match: /\bpantera\b/i },
  { id: 'jump', label: 'Jump Crypto', match: /\bjump\s*(crypto|trading)?\b/i },
  { id: 'circle', label: 'Circle', match: /\bcircle\b/i },
  { id: 'animoca', label: 'Animoca', match: /\banimoca\b/i },
  { id: 'polychain', label: 'Polychain', match: /\bpolychain\b/i },
  { id: 'dragonfly', label: 'Dragonfly', match: /\bdragonfly\b/i },
  { id: 'multicoin', label: 'Multicoin', match: /\bmulticoin\b/i },
  { id: 'hashed', label: 'Hashed', match: /\bhashed\b/i },
  { id: 'wintermute', label: 'Wintermute', match: /\bwintermute\b/i },
];

const DOCS = /whitepaper|litepaper|gitbook|\/docs(?:\/|$)|docs\.|notion\.site|github\.com/i;
const DOCS_WORD = /white\s*paper|lite\s*paper|documentation/i;
const RAISE = /(?:presale|pre-sale|raised|raise|funding)\D{0,24}\$?\s*(\d+(?:\.\d+)?)\s*(k|m|b|million|billion)\b|\b\$\s*(\d+(?:\.\d+)?)\s*(k|m|b|million|billion)\b(?:\s+(?:presale|pre-sale|raised|raise))?/i;

export interface FoundationInput {
  launchedAt?: number;
  now?: number;
  websites?: readonly string[];
  bio?: string;
  urls?: readonly string[];
  mentionedPeople?: readonly NamedBacker[];
  exchangeHints?: readonly string[];
}

function clamp(value: number, max = 100) {
  return Math.max(0, Math.min(max, value));
}

function labelsFrom(list: ReadonlyArray<{ label: string; match: RegExp }>, text: string): string[] {
  return list.filter((item) => item.match.test(text)).map((item) => item.label);
}

export function parseRaiseUsd(text: string): number | undefined {
  const match = text.match(RAISE);
  if (!match) return undefined;
  const amount = Number(match[1] ?? match[3]);
  const unit = (match[2] ?? match[4] ?? '').toLowerCase();
  if (!Number.isFinite(amount)) return undefined;
  const scale = unit.startsWith('b') ? 1_000_000_000 : unit.startsWith('m') ? 1_000_000 : 1_000;
  return amount * scale;
}

export function findDocsUrl(urls: readonly string[], bio = ''): string | undefined {
  const hit = urls.find((url) => DOCS.test(url));
  if (hit) return hit;
  return DOCS_WORD.test(bio) ? urls[0] : undefined;
}

function agePoints(hours: number | undefined): { points: number; fact: FoundationFact } {
  if (hours === undefined) {
    return {
      points: 0,
      fact: {
        id: 'age',
        label: 'How old it is',
        status: 'unknown',
        summary: 'We don’t know when this token started trading.',
        details: 'Older tokens have a longer public history. Brand-new ones are harder to judge, because there has been less time for problems to show up.',
      },
    };
  }
  const days = hours / 24;
  const points = hours < 24 ? 3 : hours < 7 * 24 ? 6 : hours < 30 * 24 ? 11 : hours < 180 * 24 ? 16 : hours < 365 * 24 ? 20 : 25;
  const status = points >= 20 ? 'good' : points >= 11 ? 'mid' : 'bad';
  const when = days < 2 ? 'less than 2 days' : days < 14 ? `${Math.floor(days)} days` : `${Math.floor(days / 30)} months`;
  return {
    points,
    fact: {
      id: 'age',
      label: 'How old it is',
      status,
      summary: `It has been trading for ${when}.`,
      details: 'A longer trading history doesn’t make a token safe, but it does mean more people have had time to spot problems. Very new tokens are easier to fake.',
    },
  };
}

function backingPoints(people: readonly NamedBacker[]): { points: number; fact: FoundationFact } {
  const known = people.filter((person) => person.followers >= KNOWN_PERSON);
  const named = people.filter((person) => person.followers < KNOWN_PERSON);
  let points = 0;
  if (known.length) points += Math.min(15, 10 + (known.length - 1) * 3);
  else if (named.length) points += 5;

  let status: FoundationFact['status'] = 'unknown';
  let summary = 'We didn’t find a named person on the official page.';
  if (known.length) {
    status = 'good';
    summary = `The official page points to @${known[0].handle}.`;
  } else if (named.length) {
    status = 'mid';
    summary = `The official page names @${named[0].handle}, but that account is not well known.`;
  }

  return {
    points,
    fact: {
      id: 'backing',
      label: 'Who backs it',
      status,
      summary,
      details: 'We read the official Twitter bio for @mentions of real people. A named, established person is a better sign than an anonymous page. It is still not a guarantee.',
    },
  };
}

function docsPoints(docsUrl: string | undefined, bio: string): { points: number; fact: FoundationFact } {
  if (docsUrl) {
    return {
      points: 15,
      fact: {
        id: 'docs',
        label: 'Documentation',
        status: 'good',
        summary: 'We found a public write-up, such as a white paper or docs page.',
        details: 'A public document that explains how the token works is a basic sign of a real project. Anyone can publish a document, so this is not a safety check on its own.',
      },
    };
  }
  if (DOCS_WORD.test(bio)) {
    return {
      points: 5,
      fact: {
        id: 'docs',
        label: 'Documentation',
        status: 'mid',
        summary: 'The bio mentions a white paper or docs, but we couldn’t open a clear link.',
        details: 'The page talks about documentation, but we didn’t find a working link.',
      },
    };
  }
  return {
    points: 0,
    fact: {
      id: 'docs',
      label: 'Documentation',
      status: 'unknown',
      summary: 'We didn’t find a white paper or docs page.',
      details: 'Many serious projects publish a short public document explaining the token. Missing docs is common, and not always a warning by itself.',
    },
  };
}

function fundingPoints(input: {
  text: string;
  exchangeHints: readonly string[];
}): { points: number; fact: FoundationFact; exchanges: string[]; investors: string[]; presaleUsd?: number } {
  const hintText = input.exchangeHints.join('\n');
  // Listings come only from CoinGecko's exchange data. Anyone can write "Binance" in a bio.
  const majors = labelsFrom(MAJOR_EXCHANGES, hintText);
  const others = labelsFrom(OTHER_EXCHANGES, hintText);
  const investors = labelsFrom(INVESTORS, input.text);
  const presaleUsd = parseRaiseUsd(input.text);

  let points = 0;
  if (majors.includes('Binance')) points += 40;
  if (majors.includes('Coinbase')) points += 40;
  if (others.length) points += Math.min(20, 12 + (others.length - 1) * 6);
  if (presaleUsd !== undefined && presaleUsd >= PRESALE_MIN) points += 25;
  if (investors.length) points += Math.min(20, 15 + (investors.length - 1) * 5);
  points = clamp(points, 45);

  const exchanges = [...majors, ...others];
  let status: FoundationFact['status'] = 'unknown';
  let summary = 'We didn’t find a large raise, a well-known investor, or a listing on a major exchange.';
  if (majors.length) {
    status = 'good';
    summary = `It is listed on ${majors.join(' and ')}.`;
  } else if (presaleUsd !== undefined && presaleUsd >= PRESALE_MIN) {
    status = 'good';
    summary = `It raised about $${Math.round(presaleUsd / 1_000_000)}m before launch.`;
  } else if (investors.length) {
    status = 'good';
    summary = `Known backers include ${investors[0]}.`;
  } else if (others.length) {
    status = 'mid';
    summary = `It is listed on ${others[0]}, which is a known exchange but not one of the largest.`;
  } else if (presaleUsd !== undefined) {
    status = 'mid';
    summary = `We found a raise figure, but it is below $10m.`;
  }

  return {
    points,
    exchanges,
    investors,
    presaleUsd,
    fact: {
      id: 'funding',
      label: 'Funding',
      status,
      summary,
      details:
        'A listing on Binance or Coinbase counts the most. A presale above $10m, or a well-known investor such as Binance Labs, also helps. This is still not a promise that the token is safe.',
    },
  };
}

export function scoreFoundation(input: FoundationInput): FoundationReport {
  const now = input.now ?? Date.now();
  const hours = input.launchedAt === undefined ? undefined : (now - input.launchedAt) / HOUR;
  const text = [input.bio, ...(input.urls ?? []), ...(input.websites ?? [])].filter(Boolean).join('\n');
  const urls = [...(input.urls ?? []), ...(input.websites ?? [])];
  const docsUrl = findDocsUrl(urls, input.bio ?? '');
  const people = input.mentionedPeople ?? [];

  const age = agePoints(hours);
  const backing = backingPoints(people);
  const docs = docsPoints(docsUrl, input.bio ?? '');
  const funding = fundingPoints({ text, exchangeHints: input.exchangeHints ?? [] });
  const facts = [age.fact, backing.fact, docs.fact, funding.fact];
  const known = age.points + backing.points + docs.points + funding.points;
  const hasAny =
    hours !== undefined ||
    Boolean(input.bio) ||
    urls.length > 0 ||
    people.length > 0 ||
    (input.exchangeHints?.length ?? 0) > 0;
  const score = hasAny ? Math.round(clamp(known)) : null;
  const band: FoundationBand | null =
    score === null ? null : score >= 70 ? 'solid' : score >= 40 ? 'forming' : 'thin';

  return {
    score,
    band,
    facts,
    backers: people,
    brands: [...funding.exchanges, ...funding.investors],
    docsUrl,
    exchanges: funding.exchanges,
    investors: funding.investors,
    presaleUsd: funding.presaleUsd,
  };
}
