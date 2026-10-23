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

`network` is optional. The extension also sends `pairs` (DexScreener's `token-pairs/v1` answer for that chain) and `coingecko` (the coin's `tickers`), fetched in the user's browser: DexScreener and CoinGecko answer 429 to Render's shared addresses. The server keeps only the fields it reads, uses pairs only when `network` is set, and caches such results per client. Without them it fetches the data itself. The reply has `text` (the same summary the OpenClaw agent reads from the dev server) and `report`, the full score: overall, security report and groups, community, foundation, brief and the sources that failed.

## Limits

- Results are cached for 10 minutes per token, so popular tokens cost one scan however many people look.
- Each client (by IP) gets 30 fresh scans and 120 identify calls per 10 minutes. Cached answers don't count. Over the limit the reply is 429.

## Settings

| Variable | What it does |
| --- | --- |
| `EXTENSION_ORIGINS` | Comma-separated `chrome-extension://<id>` origins allowed to call these endpoints. Set it to the published extension's id. When unset, any extension may call them (handy while testing an unpacked build). |
| `INSIGHTX_API_KEY`, `TWITTER_BEARER_TOKEN`, `OPENAI_API_KEY` | Same keys the website already uses. The extension never sees them. |

## Hosting on Render

Create a new Web Service from this repo. Build command `npm install && npm run build`, start command `npm start`. Add the environment variables above.
