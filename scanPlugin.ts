import type { Plugin, ViteDevServer } from 'vite';
import type { ApiHosts } from './src/api/hosts';
import type { ScanResult } from './src/api/scan';

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
      if (body.length > 250_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function send(res: NodeRes, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function originOf(server: ViteDevServer): string | null {
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') return null;
  let host = address.address;
  if (host === '0.0.0.0' || host === '::' || host === '::1') host = '127.0.0.1';
  return `http://${host}:${address.port}`;
}

let tail: Promise<unknown> = Promise.resolve();

function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
  const next = tail.then(run, run);
  tail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export function scanPlugin(): Plugin {
  const handle = async (server: ViteDevServer, req: NodeReq, res: NodeRes, next: () => void) => {
    if (req.method !== 'POST' || req.url?.split('?')[0] !== '/api/scan') {
      next();
      return;
    }
    const origin = originOf(server);
    if (!origin) {
      send(res, 503, { ok: false, text: 'The scanner is still starting. Try again in a moment.' });
      return;
    }
    let address = '';
    let parsed: { address?: unknown; plan?: unknown } = {};
    try {
      parsed = JSON.parse(await readBody(req)) as { address?: unknown; plan?: unknown };
      address = typeof parsed.address === 'string' ? parsed.address : '';
    } catch {
      send(res, 400, { ok: false, text: 'Send a JSON body with an address.' });
      return;
    }
    if (!address.trim()) {
      send(res, 400, { ok: false, text: 'Send a contract address to scan.' });
      return;
    }

    const hosts: ApiHosts = {
      insightx: `${origin}/api/insightx`,
      twitter: `${origin}/api/twitter`,
      coingecko: `${origin}/api/coingecko`,
      summarise: `${origin}/api/summarise`,
      socials: `${origin}/api/socials`,
    };
    // The website sends a plan and wants the full report, as server.mjs gives it in production.
    if (parsed.plan !== undefined) {
      try {
        const api = (await server.ssrLoadModule('/src/server/api.ts')) as {
          configure(hosts: ApiHosts): void;
          handleScan(body: unknown, client: string): Promise<{ status: number; body: unknown }>;
        };
        api.configure(hosts);
        const reply = await api.handleScan(parsed, 'dev');
        send(res, reply.status, reply.body);
      } catch {
        send(res, 500, { ok: false, text: 'The scan failed before it could score this token.' });
      }
      return;
    }
    try {
      const loaded = (await server.ssrLoadModule('/src/api/scan.ts')) as { runScan(input: string, hosts: ApiHosts): Promise<ScanResult> };
      const result = await oneAtATime(() => loaded.runScan(address, hosts));
      send(res, result.ok ? 200 : 422, result);
    } catch {
      send(res, 500, { ok: false, text: 'The scan failed before it could score this token.' });
    }
  };

  return {
    name: 'trust-score-scan',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void handle(server, req as NodeReq, res as unknown as NodeRes, next);
      });
    },
  };
}
