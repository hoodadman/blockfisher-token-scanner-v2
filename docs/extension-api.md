# Extension API

The Blockfisher Chrome extension calls two JSON endpoints on this server. Both are served by `server.mjs` in production (from the build in `dist-server/`), so `npm run build` must run before `npm start`.

## POST /api/identify

Turns what the extension found on a page into tokens it can scan. Send up to 5 candidates.

```json
{ "candidates": [
  { "address": "0x6982508145454Ce325dDbE47a25d4ec3d2311933", "network": "eth" },
  { "address": "<pair address from a DexScreener URL>", "chainId": "ethereum" },
  { "coingeckoId": "pepe" }
] }
```

`network` is one of `eth`, `base`, `bsc`, `sol`. `chainId` is DexScreener's chain id, for chains we may not support yet. The reply lists one entry per token found:

```json
{ "ok": true, "tokens": [
  { "input": "pepe", "status": "token", "address": "0x6982…", "network": "eth", "chainName": "Ethereum", "name": "Pepe", "symbol": "PEPE" }
] }
```

`status` is `token`, `unsupported-chain`, `not-a-contract` (a native coin such as Bitcoin) or `not-found` (often a wallet address). Anything other than `token` carries a plain-language `message`.

## POST /api/scan

```json
{ "address": "0x6982508145454Ce325dDbE47a25d4ec3d2311933", "network": "eth" }
```

`network` is optional. The extension also sends `pairs` (DexScreener's `token-pairs/v1` answer for that chain) and `coingecko` (the coin's `tickers`), fetched in the user's browser: DexScreener and CoinGecko answer 429 to Render's shared addresses. The server keeps only the fields it reads, uses pairs only when `network` is set, and caches such results per client. Without them it fetches the data itself. The reply has `text` (the same summary the OpenClaw agent reads from the dev server) and `report`, the full score: overall, security report and groups, community, foundation, brief, the sources that failed, and `checked`: when the shared parts (`community`, `holders`) were fetched, in ms. When a confirmed flag stops holders selling (a honeypot, trading switched off, or a sell or transfer tax of 90% or more), `report.security.fatal` holds `{ id, title, summary }` and both `report.security.score` and `report.overall` are 0; otherwise it is `null`. Saved results from before this change have no `fatal` field.

Send `"plan": "free" | "pro" | "ultra"` to choose the scanner version (see Plans below). Without it the scan runs as Pro, so the extension works as before. The report then also has `plan`, `communitySource` and `communityFrom` (see Plans), `secondOpinion` (Ultra only) and `notes`, plain sentences for the card about where the result came from.

Send `"refresh": true` for a re-check: the scan skips every shared answer and fetches them again (and saves the new ones for others).

## Shared answers

The paid answers are shared between everyone who scans the same token, website and extension alike. The server's `/api/twitter` and `/api/insightx` proxies (which, like `/api/coingecko` and `/api/summarise`, only answer the server itself over 127.0.0.1; anyone else gets 404) keep each successful answer (X for 24 hours, InsightX for 1 hour). Each request sends `x-share-seconds`, how old an answer it accepts, and gets back `x-saved-at`, when the answer it got was fetched (`x-shared: 1` when it came from the store). `src/api/share.ts` decides the ages:

| Part | Shared for | Token under a week old | Token under a day old |
| --- | --- | --- | --- |
| Community (X) | 24 hours | 12 hours | 12 hours |
| Holders (InsightX) | 1 hour | 1 hour | 10 minutes |
| Security (GoPlus) | never: runs on every scan | | |

The score itself is worked out again on every scan from those answers and fresh market data, so nothing a browser sends is ever shown to anyone else. Each answer is kept for its own time and then deleted by the store; there is no daily reset.

## Plans

The three scanner versions are defined in one file, `src/plans/plans.ts`; nothing else checks a plan by name.

| | Free | Pro | Ultra |
| --- | --- | --- | --- |
| Security (GoPlus) | Fresh every scan | Fresh every scan | Fresh every scan, plus Honeypot.is (EVM) or RugCheck (Solana) as a second opinion |
| Holders (InsightX) | Shared 1 hour (10 min new tokens) | Same | At most 10 minutes old |
| Foundation | Live market data | Same | Same |
| Community (X) | Saved Ultra or Pro result up to 24 hours old (12 hours new tokens), like Pro | Saved Ultra or Pro result up to 24 hours old (12 hours new tokens) | Saved Ultra up to 6 hours old, or a recent Pro read on to Ultra depth |
| X read per fresh check | 10 mentions, 15 own posts, 5 bio accounts | Same | 30 mentions, 30 own posts, 10 bio accounts |
| Worst-case X cost of a fresh check | $0.29, within a $10 a day cap for all Free users | $0.29 | $0.72 |
| Re-check | No | 5 per 10 min | 10 per 10 min |
| Fresh Community + Foundation checks a month | 4, at Pro depth | 30, at Pro depth | 30, at Ultra depth |
| Once those are used up | Newest saved result of any age (Ultra first), or no Community if nothing is saved | Same | Same |
| Scans an hour | 60 | 60 | 60 |

Second-opinion findings can only make a result worse: each signal keeps the worse of the two readings.

**Monthly fresh checks** (`freshPerMonth` in `src/plans/plans.ts`, counted by `src/plans/allowance.ts`). Only Community and the X part of Foundation are capped; Security runs fresh on every scan, on every plan, capped or not. A scan uses one of the month's checks only when it reads X afresh: a fresh check, or Ultra reading on from a saved Pro result. A result from the library or another user's shared answer, or the 10-minute result cache, uses none, and a check whose X call failed is given back. Months are UTC calendar months. Counts are per account; Free scans without an account count per client address, which a user can change, so the shared Free budget below stays as a backstop. The counts live in the library's store (Postgres or Redis), so a restart or deploy doesn't reset them. Once a member's checks are used up, scans show the newest saved result of any age (`report.capped: true`); with nothing saved, Community is left out (`communitySource: 'skipped'`). A Re-check needs a fresh check, so it answers 429 once they are used up. Every scan reply has `freshChecks: { used, limit, left, resetsAt }`, also copied into `report.freshChecks`. Once none are left, `report.capAlert` holds the alert that the website and the extension show at the top of the result: that the month's checks are used up, where Community and Foundation came from (and how old), that Security still ran fresh, and the reset date.

**The library** keeps the latest X answers for every token anyone has scanned, for good: one Pro-depth and one Ultra-depth result per token. Each plan works on its own but reads what others already paid for before spending anything (`choose` in `src/plans/library.ts`):

| Plan | Community comes from, in order |
| --- | --- |
| Free | Saved Ultra result within 24h (12h new tokens), saved Pro result within that, else a fresh check at Pro depth |
| Pro | Saved Ultra result within 24h (12h new tokens), saved Pro result within that, else a fresh check |
| Ultra | Saved Ultra result within 6h; else a saved Pro result within 6h, read on to Ultra depth (only the older mentions and posts and the extra bio accounts Pro didn't read, about $0.43 instead of $0.72); else a fresh Ultra check |
| Any plan, checks used up | Saved Ultra result (any age; unless the Pro one is over a week newer), saved Pro result, an older saved basic check, else no Community |

Earlier Free scans ran a basic check (followers, latest post, mention count) on tokens nobody had scanned. Those saved basic checks are still shown when nothing better is saved, but no new ones are made.

**The Free budget** (`src/plans/budget.ts`) caps what all Free users together spend on fresh checks: $10 a day by default (`FREE_COMMUNITY_BUDGET`), per UTC day. It covers Community only; Security runs on every scan. Each check holds its worst case ($0.29) before it runs and gives it back if X failed. The running total is kept in the library's store, so a restart doesn't reset it. `/api/health` shows today's spend (`freeCommunityBudget`). $10 a day is about 34 Free fresh checks.

A Re-check skips the library. Every check that paid for X writes back at its depth, so results trickle down from Ultra to Pro to Free. The report says which (`communitySource`: `fetched`, `library`, `expanded` or `skipped`; `communityFrom`: `pro` or `ultra`). Only the server writes the library, from answers it fetched itself. It lives in Postgres when `DATABASE_URL` is set (table `scan_library`, created on start), else in the shared store's Redis with no expiry, else in memory. `/api/health` shows which (`library`).

Prices: Free £0, Pro £9.99 a month, Ultra £24.99 a month. `PAID_PLANS` decides how a scan's plan is chosen:

- unset, `off` or anything else: every scan runs as Free.
- `open`: the mock Scanner Pro, for local testing. Each request says its own plan and gets it. Limits are per client IP.
- `billing`: each scan runs on the plan its account pays for (see Billing). No key, or a plan that has ended: Free. A request may ask for a lower plan than it pays for, never a higher one. Paid limits count per account. With neither `DATABASE_URL` nor `REDIS_URL`, accounts would only live in memory, so the server logs an error and runs as `off` instead.

The website shows the three plans above the search box. With paid plans open (`billing` and a Stripe key), picking Pro or Ultra opens the checkout; otherwise the picker is the preview, saved in the browser. It scans through `/api/scan` like the extension: the browser finds the token on DexScreener and sends the pairs.

## Billing

Payments go through Stripe Checkout as a monthly subscription; accounts are made by the first checkout (Free needs none). The code is in `src/billing/` and `src/server/billing.ts`.

**Packages.** Each scanner is its own monthly product at £9.99 (the token scanner at its plan's price). The discount grows with each extra scanner in one package: 10% on the second, 20% on the third, 30% on the fourth (2 scanners £18.98, 3 £26.97, 4 £33.96). The dearest scanner is charged in full. The checkout lists every scanner with a tick box and shows each one's price and discount ("£8.99, 10% discount") and the total. Scanners that haven't launched show "Coming later" and can't be ticked: flip `launched` in `src/billing/catalog.ts` when one goes live. The portfolio scanner is priced on its own and isn't in the package. Prices are sent with each checkout, so no products need setting up in Stripe.

**Access keys.** After paying, Stripe sends the buyer back to `/?session_id=…`, which swaps the checkout for an access key (`bf_…`) once. The browser keeps it and sends it as `Authorization: Bearer bf_…`. On another browser, "Already paid? Sign in" emails a one-time link (30 minutes). "Copy key for the extension" gives the key to paste into the extension's settings. Only hashes of keys are stored; each account keeps its 10 newest keys. "Manage billing" opens Stripe's customer portal (change card, invoices, cancel). An account that already pays is sent there rather than to a second checkout.

**Endpoints.** `GET /api/billing/config`, `POST /api/billing/checkout {scanners, tier, email}`, `POST /api/billing/claim {sessionId}`, `POST /api/billing/webhook` (Stripe only, signed), `GET /api/account`, `POST /api/account/signin {email}` (5 per IP per 15 minutes; same answer whether or not the email has an account), `POST /api/account/redeem {token}`, `POST /api/account/portal`, `POST /api/account/signout`.

**Setting it up.**

1. In Stripe (test mode first), copy the secret key into `STRIPE_SECRET_KEY`.
2. Add a webhook endpoint at `https://<this service>/api/billing/webhook` for `checkout.session.completed`, `customer.subscription.updated` and `customer.subscription.deleted`, and copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Turn on the customer portal in Stripe's settings (Billing → Customer portal).
4. Set `PUBLIC_URL` to this service's address, and `DATABASE_URL` so accounts survive restarts (`/api/health` shows `billing.accounts`; `memory` loses every account on restart).
5. For sign-in emails, set `RESEND_API_KEY` and `MAIL_FROM` (an address on a domain verified with Resend). Without them the link is only written to the server log.
6. Set `PAID_PLANS=billing`. `/api/health` shows `billing.checkout: true` once it is open.

Not built yet: changing a package after buying (cancel and buy again for now), VAT on invoices, and accounts for Free users (Free limits count per address until then).

## GET /api/socials

`?telegram=<name>&discord=<invite code>`, both optional. Answers `{ telegram?: { name, kind, members, online? }, discord?: { code, members, online } }` from the public t.me page and Discord's invite API, both free. Counts are cached for 6 hours. Scans call it for the Telegram and Discord links DexScreener lists, and the community score adds up to 15 points from them, counting people online more than members.

## Limits

- Whole results are also cached for 10 minutes per token, so popular tokens cost one scan however many people look.
- Each account (or, without one, each client address) gets 60 scans an hour on every plan, counting answers from the cache, plus the plan's re-checks per 10 minutes. Identify calls are 120 per 10 minutes. Over a limit the reply is 429. The hourly count is kept in memory, so it starts again after a restart; the monthly fresh checks (see Plans) are kept in the store.

## Settings

| Variable | What it does |
| --- | --- |
| `EXTENSION_ORIGINS` | Comma-separated `chrome-extension://<id>` origins allowed to call these endpoints. Set it to the published extension's id. When unset, any extension may call them (handy while testing an unpacked build). |
| `INSIGHTX_API_KEY`, `TWITTER_BEARER_TOKEN`, `OPENAI_API_KEY` | Same keys the website already uses. The extension never sees them. |
| `DATABASE_URL` | Postgres for the scan library and accounts (Render Postgres "Internal Database URL"; tables `scan_library` and `accounts_store`, created on start). Needed for billing; see Plans and Billing. Without it accounts fall back to `REDIS_URL`, which an `allkeys-lru` Key Value can evict, so use Postgres for real payments. |
| `FREE_COMMUNITY_BUDGET` | Dollars a day, shared by all Free users, for fresh community checks. Default 10. Security isn't capped. |
| `PAID_PLANS` | `billing` runs each scan on the plan its account pays for. `open`: each request picks its plan (the mock Scanner Pro, local testing only). Unset or anything else: every scan runs as Free. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe's secret key and the webhook's signing secret. See Billing. |
| `PUBLIC_URL` | This service's public address, for Stripe's return links and sign-in links. |
| `RESEND_API_KEY`, `MAIL_FROM` | Send sign-in links by email through Resend. Without them the link is only written to the server log (`/api/health` shows `billing.mail`). |
| `COINGECKO_API_KEY` | Optional CoinGecko Demo key, sent with the server's CoinGecko calls so Render's shared IP isn't turned away. |
| `REDIS_URL` | Where shared answers are kept: the Internal URL of a Render Key Value instance (`redis://red-…:6379`). Unset or unreachable, the server keeps them in memory instead, which works the same but empties on every restart or deploy. `/api/health` shows which (`sharedStore`). |

## Hosting on Render

Create a new Web Service from this repo. Build command `npm install && npm run build`, start command `npm start`. Add the environment variables above.

For shared answers that survive restarts, create a Key Value instance in the same Render region (New → Key Value), copy its Internal URL into this service's `REDIS_URL`, and redeploy. Its maxmemory policy should be `allkeys-lru`, so when it is full it drops the least-used answers rather than refusing new ones.
