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

`network` is optional. The extension also sends `pairs` (DexScreener's `token-pairs/v1` answer for that chain) and `coingecko` (the coin's `tickers`), fetched in the user's browser: DexScreener and CoinGecko answer 429 to Render's shared addresses. The server keeps only the fields it reads, uses pairs only when `network` is set, and caches such results per client. Without them it fetches the data itself. The reply has `text` (the same summary the OpenClaw agent reads from the dev server) and `report`, the full score: overall, security report and groups, community, foundation, brief, the sources that failed, and `checked`: when the shared parts (`community`, `holders`) were fetched, in ms.

Send `"plan": "free" | "pro" | "ultra"` to choose the scanner version (see Plans below). Without it the scan runs as Pro, so the extension works as before. The report then also has `plan`, `communitySource` (`fetched`, `library` or `skipped`), `secondOpinion` (Ultra only) and `notes`, plain sentences for the card about where the result came from.

Send `"refresh": true` for a re-check: the scan skips every shared answer and fetches them again (and saves the new ones for others).

## Shared answers

The paid answers are shared between everyone who scans the same token, website and extension alike. The server's `/api/twitter` and `/api/insightx` proxies keep each successful answer (X for 24 hours, InsightX for 1 hour). Each request sends `x-share-seconds`, how old an answer it accepts, and gets back `x-saved-at`, when the answer it got was fetched (`x-shared: 1` when it came from the store). `src/api/share.ts` decides the ages:

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
| Community (X) | Latest saved result from the library, any age | Shared 24 hours (12 hours new tokens) | At most 6 hours old |
| X read per fresh check | 10 mentions, 15 own posts, 5 bio accounts | Same | 30 mentions, 30 own posts, 10 bio accounts |
| Worst-case X cost of a fresh check | $0.29 | $0.29 | $0.72 |
| Re-check | No | 5 per 10 min | 10 per 10 min |
| Daily limit | 5 tokens a day with no saved result; after that Community is skipped | None | 20 deep scans, then Pro depth |

Second-opinion findings can only make a result worse: each signal keeps the worse of the two readings.

**The library** keeps the latest X answers for every token anyone has scanned, for good. Free scans read Community from it; every Pro and Ultra scan writes back, so paying users keep it fresh for everyone. Only the server writes it, from answers it fetched itself. It lives in Postgres when `DATABASE_URL` is set (table `scan_library`, created on start), else in the shared store's Redis with no expiry, else in memory. `/api/health` shows which (`library`).

**Billing doesn't exist yet**: this is the mock Scanner Pro, and each request says its own plan. Limits are per client IP until there are accounts. Set `PAID_PLANS=off` to run every scan as Free.

The website shows a plan picker above the search box, saved in the browser, and now scans through `/api/scan` like the extension: the browser finds the token on DexScreener and sends the pairs.

## GET /api/socials

`?telegram=<name>&discord=<invite code>`, both optional. Answers `{ telegram?: { name, kind, members, online? }, discord?: { code, members, online } }` from the public t.me page and Discord's invite API, both free. Counts are cached for 6 hours. Scans call it for the Telegram and Discord links DexScreener lists, and the community score adds up to 15 points from them, counting people online more than members.

## Limits

- Whole results are also cached for 10 minutes per token, so popular tokens cost one scan however many people look.
- Each client (by IP) gets 30 fresh scans and 120 identify calls per 10 minutes, and 5 re-checks of those. Cached answers don't count. Over the limit the reply is 429.

## Settings

| Variable | What it does |
| --- | --- |
| `EXTENSION_ORIGINS` | Comma-separated `chrome-extension://<id>` origins allowed to call these endpoints. Set it to the published extension's id. When unset, any extension may call them (handy while testing an unpacked build). |
| `INSIGHTX_API_KEY`, `TWITTER_BEARER_TOKEN`, `OPENAI_API_KEY` | Same keys the website already uses. The extension never sees them. |
| `DATABASE_URL` | Postgres for the scan library (Render Postgres "Internal Database URL"). Optional; see Plans. |
| `PAID_PLANS` | `off` runs every scan as Free. Unset: each request picks its plan (the mock Scanner Pro). |
| `REDIS_URL` | Where shared answers are kept: the Internal URL of a Render Key Value instance (`redis://red-…:6379`). Unset or unreachable, the server keeps them in memory instead, which works the same but empties on every restart or deploy. `/api/health` shows which (`sharedStore`). |

## Hosting on Render

Create a new Web Service from this repo. Build command `npm install && npm run build`, start command `npm start`. Add the environment variables above.

For shared answers that survive restarts, create a Key Value instance in the same Render region (New → Key Value), copy its Internal URL into this service's `REDIS_URL`, and redeploy. Its maxmemory policy should be `allkeys-lru`, so when it is full it drops the least-used answers rather than refusing new ones.
