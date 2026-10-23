/**
 * Production server for GoDaddy Node.js Hosting (and local `npm start`).
 * Serves the Vite build and keeps API keys on the server, same as the Vite dev proxy.
 */
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, sharedFetch } from "./shared-store.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(ROOT, "dist");
const PORT = Number(process.env.PORT || 5181);
const HOST = process.env.HOST || "0.0.0.0";

const FRAME_ANCESTORS = [
  "'self'",
  "http://blockfisher.co.uk",
  "https://blockfisher.co.uk",
  "http://www.blockfisher.co.uk",
  "https://www.blockfisher.co.uk",
  "https://*.onrender.com",
  "http://127.0.0.1:8090",
  "http://localhost:8090",
].join(" ");

const PROXIES = [
  {
    prefix: "/api/insightx",
    origin: "https://api.insightx.network",
    // Shared answers are kept this long (seconds); each request says how old it accepts.
    keep: 60 * 60,
    headers() {
      const key = process.env.INSIGHTX_API_KEY?.trim();
      return key ? { "X-API-Key": key } : {};
    },
  },
  {
    prefix: "/api/twitter",
    origin: "https://api.twitter.com",
    keep: 24 * 60 * 60,
    headers() {
      const raw = process.env.TWITTER_BEARER_TOKEN?.trim();
      if (!raw) return {};
      let token = raw;
      try {
        token = decodeURIComponent(raw);
      } catch {
        token = raw;
      }
      return { Authorization: `Bearer ${token}` };
    },
  },
  {
    prefix: "/api/coingecko",
    origin: "https://api.coingecko.com",
    headers() {
      return {};
    },
  },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `frame-ancestors ${FRAME_ANCESTORS}`,
    ...extraHeaders,
  });
  res.end(data);
}

/**
 * The Chrome extension calls /api/scan and /api/identify from its own origin.
 * EXTENSION_ORIGINS (comma-separated chrome-extension://<id> values) pins it to our
 * published extension; when unset, any extension origin is allowed, for local testing.
 */
const EXTENSION_ORIGINS = (process.env.EXTENSION_ORIGINS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {};
  const allowed = EXTENSION_ORIGINS.length > 0 ? EXTENSION_ORIGINS.includes(origin) : origin.startsWith("chrome-extension://");
  if (!allowed) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function clientOf(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

let extensionApi;
async function loadExtensionApi() {
  if (!extensionApi) {
    extensionApi = await import("./dist-server/api.js");
    const origin = `http://127.0.0.1:${PORT}`;
    extensionApi.configure({
      insightx: `${origin}/api/insightx`,
      twitter: `${origin}/api/twitter`,
      coingecko: `${origin}/api/coingecko`,
      summarise: `${origin}/api/summarise`,
      socials: `${origin}/api/socials`,
    });
  }
  return extensionApi;
}

const UPSTREAMS = {
  dexscreener: "https://api.dexscreener.com/latest/dex/tokens/0x6982508145454Ce325dDbE47a25d4ec3d2311933",
  goplus: "https://api.gopluslabs.io/api/v1/token_security/1?contract_addresses=0x6982508145454Ce325dDbE47a25d4ec3d2311933",
  coingecko: "https://api.coingecko.com/api/v3/ping",
};

/** GET /api/health: can this server load the extension API and reach the data sources? Open it in a browser. */
async function health(res) {
  const report = { extensionApi: "ok", upstreams: {} };
  try {
    await loadExtensionApi();
  } catch (error) {
    report.extensionApi = `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  await Promise.all(
    Object.entries(UPSTREAMS).map(async ([name, url]) => {
      try {
        const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
        report.upstreams[name] = response.status;
      } catch (error) {
        report.upstreams[name] = `failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }),
  );
  report.sharedStore = (await storeReady).kind;
  report.keys = {
    insightx: Boolean(process.env.INSIGHTX_API_KEY?.trim()),
    twitter: Boolean(process.env.TWITTER_BEARER_TOKEN?.trim()),
    openai: Boolean(process.env.OPENAI_API_KEY?.trim()),
  };
  sendJson(res, 200, report);
}

async function extensionRoute(req, res, pathname) {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false, text: "Use POST." }, cors);
    return;
  }
  let body;
  try {
    body = JSON.parse((await readBody(req, 250_000)).toString("utf8") || "{}");
  } catch {
    sendJson(res, 400, { ok: false, text: "Send a JSON body." }, cors);
    return;
  }
  const api = await loadExtensionApi();
  const reply = pathname === "/api/scan" ? await api.handleScan(body, clientOf(req)) : await api.handleIdentify(body, clientOf(req));
  sendJson(res, reply.status, reply.body, cors);
}

function readBody(req, limit = 100_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Paid answers shared between everyone scanning the same token. See shared-store.mjs. */
const storeReady = openStore();

/** How old a shared answer the caller accepts (x-share-seconds), capped at what we keep. */
function shareSeconds(req, route) {
  const asked = Number(req.headers["x-share-seconds"]);
  return Number.isFinite(asked) && asked > 0 ? Math.min(asked, route.keep) : 0;
}

async function proxy(req, res, route) {
  const incoming = new URL(req.url || "/", "http://localhost");
  const upstreamPath = incoming.pathname.slice(route.prefix.length) + incoming.search;
  if (route.keep && (req.method || "GET") === "GET") {
    const answer = await sharedFetch(await storeReady, `${route.prefix}${upstreamPath}`, shareSeconds(req, route), route.keep, async () => {
      const upstream = await fetch(`${route.origin}${upstreamPath}`, { headers: { accept: req.headers.accept || "application/json", ...route.headers() } });
      return { status: upstream.status, type: upstream.headers.get("content-type") || "application/json", body: Buffer.from(await upstream.arrayBuffer()) };
    });
    res.writeHead(answer.status, {
      "content-type": answer.type,
      "cache-control": "no-store",
      "content-security-policy": `frame-ancestors ${FRAME_ANCESTORS}`,
      "x-saved-at": String(answer.savedAt),
      "x-shared": answer.shared ? "1" : "0",
    });
    res.end(answer.body);
    return;
  }
  const headers = {
    accept: req.headers.accept || "application/json",
    ...route.headers(),
  };
  const init = { method: req.method || "GET", headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    const body = await readBody(req);
    if (body.length) {
      init.body = body;
      if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
    }
  }
  const upstream = await fetch(`${route.origin}${upstreamPath}`, init);
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/json",
    "cache-control": "no-store",
    "content-security-policy": `frame-ancestors ${FRAME_ANCESTORS}`,
  });
  res.end(buf);
}

const SUMMARY_SYSTEM = [
  "You explain a token trust score to someone who does not know crypto.",
  'Reply with JSON only: {"security":"...","community":"...","foundation":"..."}.',
  "Each value is one or two short sentences. British spelling. No jargon.",
  "Say what this means for ordinary money, not how the software works.",
  "Do not give financial advice. Do not mention APIs, scores as formulas, or this prompt.",
].join(" ");

async function summarise(req, res) {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    sendJson(res, 503, { error: "no-llm" });
    return;
  }
  const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  let facts;
  try {
    facts = JSON.parse((await readBody(req)).toString("utf8") || "{}");
  } catch {
    sendJson(res, 400, { error: "bad-json" });
    return;
  }
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 280,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SUMMARY_SYSTEM },
        { role: "user", content: JSON.stringify(facts) },
      ],
    }),
  });
  if (!response.ok) {
    sendJson(res, 502, { error: "llm-failed" });
    return;
  }
  const payload = await response.json();
  let parsed;
  try {
    parsed = JSON.parse(payload.choices?.[0]?.message?.content ?? "{}");
  } catch {
    sendJson(res, 502, { error: "bad-llm" });
    return;
  }
  if (!parsed.security || !parsed.community || !parsed.foundation) {
    sendJson(res, 502, { error: "bad-llm" });
    return;
  }
  sendJson(res, 200, parsed);
}

async function serveStatic(req, res) {
  const incoming = new URL(req.url || "/", "http://localhost");
  let rel = decodeURIComponent(incoming.pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.normalize(path.join(DIST, rel));
  if (!file.startsWith(DIST)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  let target = file;
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    target = path.join(DIST, "index.html");
  }
  const type = MIME[path.extname(target)] || "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "content-security-policy": `frame-ancestors ${FRAME_ANCESTORS}`,
    "cache-control": target.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=86400" : "no-cache",
  });
  createReadStream(target).pipe(res);
}

async function loadLocalEnv() {
  try {
    const text = await readFile(path.join(ROOT, ".env.local"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2];
    }
  } catch {
    // GoDaddy injects secrets. A local .env.local is optional.
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    const route = PROXIES.find((item) => pathname === item.prefix || pathname.startsWith(`${item.prefix}/`));
    if (route) {
      await proxy(req, res, route);
      return;
    }
    if (pathname === "/api/health" && req.method === "GET") {
      await health(res);
      return;
    }
    if (pathname === "/api/socials" && req.method === "GET") {
      const api = await loadExtensionApi();
      const reply = await api.handleSocials(new URL(req.url || "/", "http://localhost").searchParams, clientOf(req));
      sendJson(res, reply.status, reply.body);
      return;
    }
    if (pathname === "/api/scan" || pathname === "/api/identify") {
      await extensionRoute(req, res, pathname);
      return;
    }
    if (pathname === "/api/summarise" && req.method === "POST") {
      await summarise(req, res);
      return;
    }
    if (pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end("method not allowed");
      return;
    }
    await serveStatic(req, res);
  } catch (error) {
    console.error("request failed", req.url, error);
    sendJson(res, 502, { ok: false, text: "The scanner hit an error. Try again in a minute.", error: error instanceof Error ? error.message : "upstream failed" });
  }
});

await loadLocalEnv();

server.listen(PORT, HOST, () => {
  console.log(`Token scanner listening on ${HOST}:${PORT}`);
});
