/**
 * Where shared answers from the paid APIs are kept, so everyone who scans the same token
 * shares one answer for a while (see src/api/share.ts for how long).
 *
 * REDIS_URL set (Render's Key Value "internal URL"): answers survive restarts and are shared
 * by every server instance. Unset, or Redis unreachable: a small in-memory store, which works
 * the same but empties when the server restarts.
 */

const MEMORY_LIMIT = 2_000;
const PREFIX = "share:";
const LIBRARY_PREFIX = "library:";

export function memoryStore(now = Date.now) {
  const entries = new Map();
  return {
    kind: "memory",
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expires <= now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    async set(key, value, seconds) {
      entries.delete(key);
      entries.set(key, { value, expires: now() + seconds * 1000 });
      while (entries.size > MEMORY_LIMIT) entries.delete(entries.keys().next().value);
    },
  };
}

async function redisStore(url) {
  const { createClient } = await import("redis");
  const client = createClient({ url, socket: { connectTimeout: 5_000, reconnectStrategy: (tries) => Math.min(tries * 500, 10_000) } });
  let lastError = "";
  client.on("error", (error) => {
    // A lost connection retries every few seconds; say so once, not every time.
    if (error.message !== lastError) console.error("shared store:", error.message);
    lastError = error.message;
  });
  client.on("ready", () => {
    lastError = "";
  });
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("no answer in 8 seconds")), 8_000)),
    ]);
  } catch (error) {
    client.destroy();
    throw error;
  }
  return {
    kind: "redis",
    async get(key) {
      if (!client.isReady) return undefined;
      return (await client.get(PREFIX + key)) ?? undefined;
    },
    async set(key, value, seconds) {
      if (!client.isReady) return;
      // Redis deletes the entry by itself once the time is up.
      await client.set(PREFIX + key, value, { EX: Math.max(1, Math.round(seconds)) });
    },
    /** The scan library: kept with no expiry (see src/plans/library.ts). */
    library: {
      kind: "redis",
      async get(key) {
        if (!client.isReady) return undefined;
        return (await client.get(LIBRARY_PREFIX + key)) ?? undefined;
      },
      async set(key, value) {
        if (!client.isReady) return;
        await client.set(LIBRARY_PREFIX + key, value);
      },
    },
  };
}

export async function openStore(url = process.env.REDIS_URL?.trim()) {
  if (url) {
    try {
      const store = await redisStore(url);
      console.log("shared store: redis");
      return store;
    } catch (error) {
      console.error("shared store: redis unavailable, using memory:", error instanceof Error ? error.message : error);
    }
  }
  return memoryStore();
}

/**
 * Answers a proxied GET from the store when one is young enough, else fetches it and keeps
 * it for `keepSeconds`. `maxAgeSeconds` is how old an answer the caller accepts (0: fresh).
 * Only successful answers are kept. A store failure never fails the request.
 */
export async function sharedFetch(store, key, maxAgeSeconds, keepSeconds, fetchFresh, now = Date.now) {
  if (maxAgeSeconds > 0) {
    try {
      const raw = await store.get(key);
      if (raw) {
        const saved = JSON.parse(raw);
        if (now() - saved.savedAt <= maxAgeSeconds * 1000) {
          return { status: saved.status, type: saved.type, body: Buffer.from(saved.body, "base64"), savedAt: saved.savedAt, shared: true };
        }
      }
    } catch (error) {
      console.error("shared store read failed:", error instanceof Error ? error.message : error);
    }
  }
  const fresh = await fetchFresh();
  const savedAt = now();
  if (fresh.status === 200) {
    try {
      await store.set(key, JSON.stringify({ status: fresh.status, type: fresh.type, body: fresh.body.toString("base64"), savedAt }), keepSeconds);
    } catch (error) {
      console.error("shared store write failed:", error instanceof Error ? error.message : error);
    }
  }
  return { ...fresh, savedAt, shared: false };
}

/** The scan library in Postgres: one row per token, replaced by each newer scan. */
async function postgresLibrary(url) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 4, connectionTimeoutMillis: 8_000 });
  pool.on("error", (error) => console.error("scan library:", error.message));
  await pool.query(
    "create table if not exists scan_library (key text primary key, value text not null, updated_at timestamptz not null default now())",
  );
  return {
    kind: "postgres",
    async get(key) {
      const result = await pool.query("select value from scan_library where key = $1", [key]);
      return result.rows[0]?.value;
    },
    async set(key, value) {
      await pool.query(
        "insert into scan_library (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value, updated_at = now()",
        [key, value],
      );
    },
  };
}

/**
 * Where the scan library lives: Postgres (DATABASE_URL), which keeps it for good; else the
 * shared store's Redis with no expiry; else undefined, and the scanner keeps it in memory.
 */
export async function openLibrary(sharedStore, url = process.env.DATABASE_URL?.trim()) {
  if (url) {
    try {
      const library = await postgresLibrary(url);
      console.log("scan library: postgres");
      return library;
    } catch (error) {
      console.error("scan library: postgres unavailable:", error instanceof Error ? error.message : error);
    }
  }
  return sharedStore.library;
}

/** Accounts in Postgres: who paid for what (see src/billing/accounts.ts). Kept for good. */
async function postgresAccounts(url) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 8_000 });
  pool.on("error", (error) => console.error("accounts:", error.message));
  await pool.query(
    "create table if not exists accounts_store (key text primary key, value text not null, updated_at timestamptz not null default now())",
  );
  return {
    kind: "postgres",
    async get(key) {
      const result = await pool.query("select value from accounts_store where key = $1", [key]);
      return result.rows[0]?.value;
    },
    async set(key, value) {
      await pool.query(
        "insert into accounts_store (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value, updated_at = now()",
        [key, value],
      );
    },
    async delete(key) {
      await pool.query("delete from accounts_store where key = $1", [key]);
    },
  };
}

const ACCOUNT_PREFIX = "account-store:";

async function redisAccounts(url) {
  const { createClient } = await import("redis");
  const client = createClient({ url, socket: { connectTimeout: 5_000, reconnectStrategy: (tries) => Math.min(tries * 500, 10_000) } });
  client.on("error", (error) => console.error("accounts:", error.message));
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("no answer in 8 seconds")), 8_000)),
    ]);
  } catch (error) {
    client.destroy();
    throw error;
  }
  const ready = () => {
    // Unlike the caches, accounts must not quietly lose writes.
    if (!client.isReady) throw new Error("accounts store is not connected");
  };
  return {
    kind: "redis",
    async get(key) {
      ready();
      return (await client.get(ACCOUNT_PREFIX + key)) ?? undefined;
    },
    async set(key, value) {
      ready();
      await client.set(ACCOUNT_PREFIX + key, value);
    },
    async delete(key) {
      ready();
      await client.del(ACCOUNT_PREFIX + key);
    },
  };
}

/**
 * Where accounts live: Postgres (DATABASE_URL), else Redis (REDIS_URL), else undefined and
 * the scanner keeps them in memory, losing every account on restart (/api/health says so).
 */
export async function openAccounts(databaseUrl = process.env.DATABASE_URL?.trim(), redisUrl = process.env.REDIS_URL?.trim()) {
  if (databaseUrl) {
    try {
      const store = await postgresAccounts(databaseUrl);
      console.log("accounts: postgres");
      return store;
    } catch (error) {
      console.error("accounts: postgres unavailable:", error instanceof Error ? error.message : error);
    }
  }
  if (redisUrl) {
    try {
      const store = await redisAccounts(redisUrl);
      console.log("accounts: redis");
      return store;
    } catch (error) {
      console.error("accounts: redis unavailable:", error instanceof Error ? error.message : error);
    }
  }
  return undefined;
}
