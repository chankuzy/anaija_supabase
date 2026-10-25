// Discover configuration. Defaults mirror the feed_config 'discover' row (migration discover_01).
// Production values are read from public.feed_config (60s cache) and deep-merged over these defaults,
// so tuning is an UPDATE statement, not a redeploy.
import type { SupabaseClient } from "../auth.ts";

export interface DiscoverConfig {
  page_size: number; session_items: number; rebuild_when_remaining: number; max_rebuilds: number;
  weights: { campus: number; quality: number; fresh: number; novelty: number; interest: number; trending: number };
  listing_weights: { campus: number; quality: number; fresh: number; novelty: number; interest: number; avail: number };
  fresh_halflife_h: { post: number; listing: number };
  interest: { scale: number; cap: number; creator_scale: number };
  campus: { cross_floor: number; cross_quality_gain: number; inst_affinity_weight: number; neutral: number };
  novelty: { expo_scale: number; topic_w: number; creator_w: number; unseen_w: number; emerging_w: number };
  trending: { scale: number; min_age_h: number };
  penalty: { consumed: number; engaged: number; disc_seen: number; disc_seen_decay_h: number; neg: number };
  ctr: { prior_rate: number; prior_strength: number; blend: number };
  listing: { prior_rate: number; prior_strength: number; inquiry_unit: number; save_unit: number; open_unit: number; like_unit: number; squash: number };
  candidates: Record<string, number>;
  compose: {
    columns: number; max_author_per_page: number; min_author_gap: number; topic_max_share: number;
    dup_gap: number; emerging_share: number; emerging_min_slot: number; fresh_floor_share: number;
    first_screen: number; first_screen_max_listings: number;
    listing_first_slot: number; listing_every: number; listing_max_per_page: number;
    listing_min_gap: number; listing_min_score: number; max_run_format: number;
  };
  jitter: number;
}

export const DEFAULT_DISCOVER: DiscoverConfig = {
  page_size: 30, session_items: 90, rebuild_when_remaining: 10, max_rebuilds: 2,
  weights: { campus: 0.25, quality: 0.25, fresh: 0.20, novelty: 0.15, interest: 0.10, trending: 0.05 },
  listing_weights: { campus: 0.28, quality: 0.22, fresh: 0.18, novelty: 0.10, interest: 0.10, avail: 0.12 },
  fresh_halflife_h: { post: 48, listing: 120 },
  interest: { scale: 2.5, cap: 0.6, creator_scale: 4.0 },
  campus: { cross_floor: 0.22, cross_quality_gain: 0.35, inst_affinity_weight: 0.6, neutral: 0.5 },
  novelty: { expo_scale: 25, topic_w: 0.35, creator_w: 0.25, unseen_w: 0.2, emerging_w: 0.2 },
  trending: { scale: 4, min_age_h: 6 },
  penalty: { consumed: 0.55, engaged: 0.8, disc_seen: 0.35, disc_seen_decay_h: 72, neg: 0.6 },
  ctr: { prior_rate: 0.25, prior_strength: 15, blend: 0.3 },
  listing: { prior_rate: 0.4, prior_strength: 10, inquiry_unit: 4, save_unit: 3, open_unit: 1, like_unit: 1, squash: 1.5 },
  candidates: { emerging_cap: 15 },
  compose: {
    columns: 3, max_author_per_page: 2, min_author_gap: 4, topic_max_share: 0.34,
    dup_gap: 12, emerging_share: 0.2, emerging_min_slot: 3, fresh_floor_share: 0.25,
    first_screen: 9, first_screen_max_listings: 1,
    listing_first_slot: 5, listing_every: 8, listing_max_per_page: 4,
    listing_min_gap: 5, listing_min_score: 0.2, max_run_format: 4,
  },
  jitter: 0.03,
};

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function deepMerge<T>(base: T, over: unknown): T {
  if (over === undefined) return base;
  if (!isObj(base) || !isObj(over)) return over as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  return out as T;
}

let cache: { at: number; cfg: DiscoverConfig } | null = null;
export function invalidateDiscoverConfig() { cache = null; }

export async function loadDiscoverConfig(supabase: SupabaseClient, ttlMs = 60_000): Promise<DiscoverConfig> {
  if (cache && Date.now() - cache.at < ttlMs) return cache.cfg;
  const { data, error } = await supabase.from("feed_config").select("value").eq("key", "discover").maybeSingle();
  if (error) {
    console.error("discover config load failed, using cached/default:", error.message);
    return cache?.cfg ?? DEFAULT_DISCOVER;
  }
  const cfg = deepMerge(JSON.parse(JSON.stringify(DEFAULT_DISCOVER)) as DiscoverConfig, (data as { value?: unknown } | null)?.value);
  cache = { at: Date.now(), cfg };
  return cfg;
}
