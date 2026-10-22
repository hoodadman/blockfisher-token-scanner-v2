import { describe, expect, it } from 'vitest';
import { findDocsUrl, parseRaiseUsd, scoreFoundation } from './score';

const NOW = Date.UTC(2026, 9, 3);
const DAY = 86_400_000;

describe('scoreFoundation', () => {
  it('scores an old, documented, listed project highly', () => {
    const report = scoreFoundation({
      now: NOW,
      launchedAt: NOW - 400 * DAY,
      bio: 'Official token. Docs and partners below. @VitalikButerin',
      urls: ['https://example.com/whitepaper.pdf'],
      mentionedPeople: [{ handle: 'VitalikButerin', followers: 5_000_000 }],
      exchangeHints: ['gdax'],
    });
    expect(report.score).toBe(90);
    expect(report.band).toBe('solid');
    expect(report.docsUrl).toBe('https://example.com/whitepaper.pdf');
    expect(report.exchanges).toContain('Coinbase');
    expect(report.facts.map((fact) => fact.status)).toEqual(['good', 'good', 'good', 'good']);
  });

  it('treats a brand-new anonymous token with no docs as thin', () => {
    const report = scoreFoundation({
      now: NOW,
      launchedAt: NOW - 3 * 60 * 60 * 1000,
      bio: 'The next moon.',
    });
    expect(report.score).toBe(3);
    expect(report.band).toBe('thin');
    expect(report.facts.find((fact) => fact.id === 'age')?.status).toBe('bad');
    expect(report.facts.find((fact) => fact.id === 'backing')?.status).toBe('unknown');
    expect(report.facts.find((fact) => fact.id === 'docs')?.status).toBe('unknown');
    expect(report.facts.find((fact) => fact.id === 'funding')?.status).toBe('unknown');
  });

  it('gives partial credit for a little-known @mention and a docs claim without a link', () => {
    const report = scoreFoundation({
      now: NOW,
      launchedAt: NOW - 40 * DAY,
      bio: 'Read our white paper. Built by @newbie',
      mentionedPeople: [{ handle: 'newbie', followers: 200 }],
    });
    expect(report.score).toBe(16 + 5 + 5);
    expect(report.facts.find((fact) => fact.id === 'backing')?.status).toBe('mid');
    expect(report.facts.find((fact) => fact.id === 'docs')?.status).toBe('mid');
  });

  it('ignores exchange names the token writes about itself', () => {
    const report = scoreFoundation({
      bio: 'Listed on Binance and Coinbase soon!',
      websites: ['https://www.coinbase.com/price/pepe'],
    });
    expect(report.exchanges).toEqual([]);
    expect(report.score).toBe(0);
  });

  it('weights Binance or Coinbase listings very highly', () => {
    const listed = scoreFoundation({ exchangeHints: ['binance'] });
    expect(listed.score).toBe(40);
    expect(listed.exchanges).toContain('Binance');
    expect(listed.facts.find((fact) => fact.id === 'funding')?.status).toBe('good');
  });

  it('counts a large presale or a well-known investor as funding', () => {
    const report = scoreFoundation({ bio: 'Presale raised $12 million with a16z' });
    expect(report.presaleUsd).toBe(12_000_000);
    expect(report.investors).toContain('a16z');
    expect(report.score).toBe(40);
  });

  it('returns no score when nothing is known', () => {
    expect(scoreFoundation({}).score).toBeNull();
    expect(scoreFoundation({}).band).toBeNull();
  });
});

describe('findDocsUrl', () => {
  it('prefers a URL that looks like a white paper or docs page', () => {
    expect(findDocsUrl(['https://pepe.vip', 'https://docs.pepe.vip/intro'])).toBe('https://docs.pepe.vip/intro');
    expect(findDocsUrl(['https://pepe.vip'], 'See the whitepaper')).toBe('https://pepe.vip');
    expect(findDocsUrl(['https://pepe.vip'], 'just a meme')).toBeUndefined();
  });
});

describe('parseRaiseUsd', () => {
  it('reads a raise of $10m or more from plain text', () => {
    expect(parseRaiseUsd('Presale raised $12 million')).toBe(12_000_000);
    expect(parseRaiseUsd('raised $2m')).toBe(2_000_000);
    expect(parseRaiseUsd('just a meme')).toBeUndefined();
  });
});
