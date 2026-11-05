/**
 * What each of the three scores means, in plain words for someone new to crypto.
 * The Chrome extension shows the same wording (src/ui/card.ts there), so keep them in step.
 */
export const PILLAR_HELP = {
  security:
    'Is the token itself safe to buy and sell? We check its code for traps: whether you could be stopped from selling, hidden fees when you buy or sell, whether its makers can still change the rules or print more tokens, and whether a few wallets own most of it. Checked fresh on every scan.',
  community:
    'Are real people interested in it? We look at the token’s own X (Twitter) page: how many followers it has, how often it posts and how many people reply, plus how many real accounts are talking about it. Posts from bots are ignored.',
  foundation:
    'Is there a real project behind it? We check how long the token has been trading, whether it has a website and public docs, which big exchanges list it, and any well-known backers it names.',
} as const;

export type PillarId = keyof typeof PILLAR_HELP;
