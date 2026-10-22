/**
 * Production server for GoDaddy Node.js Hosting (and local `npm start`).
 * Serves the Vite build and keeps API keys on the server, same as the Vite dev proxy.
 */
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    headers() {
      const key = process.env.INSIGHTX_API_KEY?.trim();
      return key ? { "X-API-Key": key } : {};
    },
  },
  {
    prefix: "/api/twitter",
    origin: "https://api.twitter.com",
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

// Blockchain nodes for our own contract reads. Same rules as rpcPlugin.ts.
const RPC_NODES = {
  eth: ["ETH_RPC_URL", "https://ethereum-rpc.publicnode.com"],
  base: ["BASE_RPC_URL", "https://base-rpc.publicnode.com"],
  bsc: ["BSC_RPC_URL", "https://bsc-rpc.publicnode.com"],
  sol: ["SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"],
};

/** Read-only calls the scanner makes. Anything else is refused so the route can't be used as a free node. */
const RPC_METHODS = new Set(["eth_getCode", "eth_call", "eth_getStorageAt", "getAccountInfo"]);

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

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `frame-ancestors ${FRAME_ANCESTORS}`,
  });
  res.end(data);
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

async function proxy(req, res, route) {
  const incoming = new URL(req.url || "/", "http://localhost");
  const upstreamPath = incoming.pathname.slice(route.prefix.length) + incoming.search;
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

async function rpc(req, res, chain) {
  const entry = Object.hasOwn(RPC_NODES, chain) ? RPC_NODES[chain] : undefined;
  if (!entry) {
    sendJson(res, 404, { error: "unknown chain" });
    return;
  }
  const node = process.env[entry[0]]?.trim() || entry[1];
  const body = await readBody(req, 4_000);
  let call;
  try {
    call = JSON.parse(body.toString("utf8"));
  } catch {
    sendJson(res, 400, { error: "bad-json" });
    return;
  }
  if (Array.isArray(call) || !RPC_METHODS.has(call?.method)) {
    sendJson(res, 400, { error: "method not allowed" });
    return;
  }
  const upstream = await fetch(node, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body,
  });
  res.writeHead(upstream.status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `frame-ancestors ${FRAME_ANCESTORS}`,
  });
  res.end(Buffer.from(await upstream.arrayBuffer()));
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
    if (pathname === "/api/summarise" && req.method === "POST") {
      await summarise(req, res);
      return;
    }
    const rpcRoute = pathname.match(/^\/api\/rpc\/([a-z]+)$/);
    if (rpcRoute && req.method === "POST") {
      await rpc(req, res, rpcRoute[1]);
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
    sendJson(res, 502, { error: error instanceof Error ? error.message : "upstream failed" });
  }
});

await loadLocalEnv();

server.listen(PORT, HOST, () => {
  console.log(`Token scanner listening on ${HOST}:${PORT}`);
});
