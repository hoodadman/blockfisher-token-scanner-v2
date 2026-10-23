export interface ApiHosts {
  insightx: string;
  twitter: string;
  coingecko: string;
  summarise: string;
  /** Telegram and Discord member counts, fetched by our server (see chats.ts). */
  socials: string;
}

const defaults: ApiHosts = {
  insightx: '/api/insightx',
  twitter: '/api/twitter',
  coingecko: '/api/coingecko',
  summarise: '/api/summarise',
  socials: '/api/socials',
};

let current: ApiHosts = defaults;

/** Browser calls use the Vite proxy. A hive scan points these at the running app. */
export function apiHosts(): ApiHosts {
  return current;
}

/** The production server points every call at itself once, at startup. */
export function setApiHosts(hosts: ApiHosts): void {
  current = hosts;
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
