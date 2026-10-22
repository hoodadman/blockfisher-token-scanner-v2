import type { Plugin } from 'vite';

// Same rules as the /api/rpc route in server.mjs. Node URLs can carry a provider key, so they stay here.
const DEFAULT_NODES: Record<string, string> = {
  eth: 'https://ethereum-rpc.publicnode.com',
  base: 'https://base-rpc.publicnode.com',
  bsc: 'https://bsc-rpc.publicnode.com',
  sol: 'https://api.mainnet-beta.solana.com',
};

const NODE_ENV: Record<string, string> = {
  eth: 'ETH_RPC_URL',
  base: 'BASE_RPC_URL',
  bsc: 'BSC_RPC_URL',
  sol: 'SOLANA_RPC_URL',
};

/** Read-only calls the scanner makes. Anything else is refused so the route can't be used as a free node. */
const ALLOWED_METHODS = new Set(['eth_getCode', 'eth_call', 'eth_getStorageAt', 'getAccountInfo']);
const MAX_BODY = 4_000;

interface NodeReq {
  method?: string;
  url?: string;
  on(event: 'data', fn: (chunk: string | Uint8Array) => void): void;
  on(event: 'end', fn: () => void): void;
  on(event: 'error', fn: (error: Error) => void): void;
}

interface NodeRes {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body: string): void;
}

function readBody(req: NodeReq): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function send(res: NodeRes, status: number, body: string) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(body);
}

export function rpcPlugin(env: Record<string, string>): Plugin {
  const middleware = async (req: NodeReq, res: NodeRes, next: () => void) => {
    const match = req.url?.split('?')[0].match(/^\/api\/rpc\/([a-z]+)$/);
    if (req.method !== 'POST' || !match) {
      next();
      return;
    }
    const chain = match[1];
    if (!Object.hasOwn(DEFAULT_NODES, chain)) {
      send(res, 404, JSON.stringify({ error: 'unknown chain' }));
      return;
    }
    const node = env[NODE_ENV[chain]]?.trim() || DEFAULT_NODES[chain];
    try {
      const body = await readBody(req);
      const call = JSON.parse(body) as { method?: string };
      if (body.length > MAX_BODY || Array.isArray(call) || !ALLOWED_METHODS.has(call.method ?? '')) {
        send(res, 400, JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      const upstream = await fetch(node, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body,
      });
      send(res, upstream.status, await upstream.text());
    } catch {
      send(res, 502, JSON.stringify({ error: 'node failed' }));
    }
  };

  return {
    name: 'trust-score-rpc',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void middleware(req as NodeReq, res as unknown as NodeRes, next);
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        void middleware(req as NodeReq, res as unknown as NodeRes, next);
      });
    },
  };
}
