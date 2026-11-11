
import { getDbHandle } from "../db";
import type { AppBindings } from "../env";
import { getPublicConfig } from "./settings";
import type { AppConfigDTO } from "@shared/types";

// v11: R2 migration removed; config no longer migrates images to R2.
const KEY = "config:v11";

// In-isolate memo so hot paths don't pay a KV read each time.
let memo: { cfg: AppConfigDTO; until: number } | null = null;
const MEMO_MS = 30_000;

/**
 * Public app config, cached in KV.
 * The SPA fetches this on every page load, so serving it from the edge
 * avoids unnecessary DB round-trips.
 */
export async function getCachedPublicConfig(
  env: AppBindings
): Promise<AppConfigDTO> {
  const now = Date.now();

  if (memo && memo.until > now) {
    return memo.cfg;
  }

  try {
    const cached = await env.LINKS_KV.get<AppConfigDTO>(KEY, "json");

    if (cached) {
      memo = { cfg: cached, until: now + MEMO_MS };
      return cached;
    }
  } catch {
    // KV unavailable or over read quota: fall back to the DB.
  }

  try {
    const { db, schema, close } = getDbHandle(env);

    try {
      // No R2 migration. Public config is loaded directly from the database.
      const cfg = await getPublicConfig(db, schema, env.APP_URL);

      await env.LINKS_KV.put(KEY, JSON.stringify(cfg), {
        expirationTtl: 3600,
      }).catch(() => {});

      memo = { cfg, until: now + MEMO_MS };

      return cfg;
    } finally {
      await close();
    }
  } catch (err) {
    // If the DB is unavailable, serve the last successfully loaded config.
    if (memo) {
      return memo.cfg;
    }

    throw err;
  }
}

/** Canonical origin for displaying short links (the admin Short domain). */
export async function shortOrigin(env: AppBindings): Promise<string> {
  return (await getCachedPublicConfig(env)).appOrigin;
}

export async function invalidatePublicConfig(
  kv: KVNamespace
): Promise<void> {
  memo = null;
  await kv.delete(KEY);
}
