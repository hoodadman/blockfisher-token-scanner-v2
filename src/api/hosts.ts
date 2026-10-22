export interface ApiHosts {
  insightx: string;
  twitter: string;
  coingecko: string;
  summarise: string;
  rpc: string;
}

const defaults: ApiHosts = {
  insightx: '/api/insightx',
  twitter: '/api/twitter',
  coingecko: '/api/coingecko',
  summarise: '/api/summarise',
  rpc: '/api/rpc',
};

let current: ApiHosts = defaults;

/** Browser calls use the Vite proxy. A hive scan points these at the running app. */
export function apiHosts(): ApiHosts {
  return current;
}

export async function withApiHosts<T>(hosts: ApiHosts, run: () => Promise<T>): Promise<T> {
  const previous = current;
  current = hosts;
  try {
    return await run();
  } finally {
    current = previous;
  }
}
