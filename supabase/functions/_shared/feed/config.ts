// Feed engine configuration. Defaults mirror the feed_config seed rows (migration 03).
// Production values are read from public.feed_config (60s cache) and deep-merged over these defaults,
// so tuning is an UPDATE statement, not a redeploy. Treat every weight as a hypothesis.
import type { SupabaseClient } from "../auth.ts";

export interface RankWeights {
  follow: number; interest: number; creator: number; campus: number; format: number;
  quality: number; fresh: number; discovery: number; small: number; neg: number; sat: number;
}

export interface FeedConfig {
  version: string;
  rank: {
    auth: RankWeights; guest: RankWeights; listing: RankWeights;
    fresh_halflife_h: { post: number; listing: number };
    interest_scale: number; creator_scale: number;
    topic_prefix_weight: Record<string, number>;
    small_followers_scale: number;
    format_baseline: number; format_gain: number;
    inst_affinity_weight: number;
    discovery_relevance_floor: number;
    jitter: number;
  };
  quality: {
    unit: { view: number; complete: number; rewatch: number; like: number; comment: number; save: number; share: number; follow: number };
    neg_unit: { skip: number; negative: number };
    prior_rate: number; prior_strength: number; squash: number;
  };
  dist: {
    seed_cap: number; expand_cap: number; saturation_cap: number;
    promote_q: number; demote_q: number;
    boost_seed: number; boost_promote: number; penalty_demote: number;
    seed_age_halflife_h: number;
  };
  affinity: {
    halflife_days: number; max_score: number; min_topic_score: number; min_creator_score: number;
    neg_topic_score: number; creator_factor: number; format_factor: number; inst_factor: number;
    topics_per_post: number;
  };
  candidates: Record<string, number | Record<string, number>>;
  compose: {
    page_size: number; session_items: number; first_n_familiar: number;
    max_author_per_page: number; min_author_gap: number; max_run_format: number;
    explore_share: number; explore_min_slot: number; wide_share: number;
    listing_max_per_page: number; listing_min_gap: number; listing_min_score: number; listing_min_slot: number;
    min_pool_relax: number; caught_up_min_items: number; rebuild_when_remaining: number; max_rebuilds: number;
    suggest: {
      first_after: [number, number]; next_after: [number, number];
      max_per_session: number; group_size: number; min_group: number; min_score: number;
    };
  };
}

export const DEFAULT_CONFIG: FeedConfig = {
  version: "v1",
  rank: {
    auth:    { follow: 0.22, interest: 0.20, creator: 0.12, campus: 0.10, format: 0.04, quality: 0.16, fresh: 0.14, discovery: 0.10, small: 0.04, neg: 0.30, sat: 0.06 },
    guest:   { follow: 0, interest: 0, creator: 0, campus: 0, format: 0, quality: 0.42, fresh: 0.28, discovery: 0.20, small: 0.06, neg: 0.30, sat: 0.08 },
    listing: { follow: 0.12, interest: 0.22, creator: 0.06, campus: 0.28, format: 0, quality: 0.08, fresh: 0.20, discovery: 0.06, small: 0.02, neg: 0.30, sat: 0.06 },
    fresh_halflife_h: { post: 36, listing: 96 },
    interest_scale: 2.5, creator_scale: 4.0,
    topic_prefix_weight: { "#": 1.0, "cat:": 1.0, "sub:": 0.4 },
    small_followers_scale: 30,
    format_baseline: 0.3333, format_gain: 1.5,
    inst_affinity_weight: 0.6,
    discovery_relevance_floor: 0.35,
    jitter: 0.02,
  },
  quality: {
    unit: { view: 1, complete: 1, rewatch: 1, like: 2, comment: 3, save: 3, share: 3, follow: 4 },
    neg_unit: { skip: 0.6, negative: 4 },
    prior_rate: 0.8, prior_strength: 8, squash: 1.5,
  },
  dist: {
    seed_cap: 10, expand_cap: 60, saturation_cap: 300,
    promote_q: 0.38, demote_q: 0.18,
    boost_seed: 0.9, boost_promote: 0.6, penalty_demote: -0.8,
    seed_age_halflife_h: 168,
  },
  affinity: {
    halflife_days: 21, max_score: 10, min_topic_score: 1.5, min_creator_score: 1.5,
    neg_topic_score: -1.5, creator_factor: 1.0, format_factor: 0.5, inst_factor: 0.5, topics_per_post: 8,
  },
  candidates: {},
  compose: {
    page_size: 15, session_items: 60, first_n_familiar: 3,
    max_author_per_page: 2, min_author_gap: 4, max_run_format: 3,
    explore_share: 0.15, explore_min_slot: 4, wide_share: 0.20,
    listing_max_per_page: 1, listing_min_gap: 10, listing_min_score: 0.18, listing_min_slot: 4,
    min_pool_relax: 30, caught_up_min_items: 5, rebuild_when_remaining: 6, max_rebuilds: 3,
    suggest: { first_after: [12, 18], next_after: [20, 30], max_per_session: 2, group_size: 3, min_group: 2, min_score: 0.35 },
  },
};

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function deepMerge<T>(base: T, over: unknown): T {
  if (over === undefined) return base;
  if (!isObj(base) || !isObj(over)) return over as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) {
    out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}

let cache: { at: number; cfg: FeedConfig } | null = null;

export function invalidateConfig() {
  cache = null;
}

export async function loadConfig(supabase: SupabaseClient, ttlMs = 60_000): Promise<FeedConfig> {
  if (cache && Date.now() - cache.at < ttlMs) return cache.cfg;
  const { data, error } = await supabase.from("feed_config").select("key, value");
  if (error || !data) {
    console.error("feed_config load failed, using cached/default config:", error?.message);
    return cache?.cfg ?? DEFAULT_CONFIG;
  }
  const merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Record<string, unknown>;
  for (const row of data as { key: string; value: unknown }[]) {
    if (row.key === "meta") {
      const v = (row.value as { version?: string } | null)?.version;
      if (v) merged.version = v;
    } else if (row.key in merged) {
      merged[row.key] = deepMerge(merged[row.key], row.value);
    }
  }
  const cfg = merged as unknown as FeedConfig;
  cache = { at: Date.now(), cfg };
  return cfg;
}
