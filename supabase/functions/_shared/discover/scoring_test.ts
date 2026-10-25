// Run: deno test --no-check -A   (in this directory)
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../feed/config.ts";
import { buildProfileIndex } from "../feed/scoring.ts";
import { EMPTY_PROFILE, type Profile } from "../feed/types.ts";
import { DEFAULT_DISCOVER } from "./config.ts";
import { rankDiscover, scoreDiscover } from "./scoring.ts";
import type { DiscoverCandidate } from "./types.ts";

const F = DEFAULT_CONFIG, D = DEFAULT_DISCOVER;

export function cand(over: Partial<DiscoverCandidate> = {}): DiscoverCandidate {
  return {
    post_id: 1, author_id: 10, kind: "post", subtype: null, listing_type: null, age_hours: 10, inst: 1,
    is_video: true, duration_s: 20, topics: [], srcs: ["quality"], interest_strength: 0, author_followers: 5,
    is_following: false, creator_score: 0, impressions: 0, views: 0, completions: 0, rewatches: 0, skips: 0,
    likes: 0, comments: 0, saves: 0, shares: 0, reposts: 0, follows_from: 0, negatives: 0, delivered: 0,
    disc_impressions: 0, disc_opens: 0, disc_delivered: 0, disc_seen: 0, disc_seen_hours: null, feed_best: 0,
    feed_acts: 0, likes_24h: 0, comments_24h: 0, saves_24h: 0, caption_fp: null, price_minor: 100000,
    inquiries: 0, list_opens: 0, ...over,
  };
}

const PROFILE: Profile = {
  user_id: 1, institution_id: 1, following: 0, consumed_total: 80,
  topics: [{ t: "#football", s: 9 }, { t: "inst:1", s: 5 }], creators: [], hides: [],
};
const idx = buildProfileIndex(PROFILE, F);
const sc = (c: DiscoverCandidate) => scoreDiscover(c, idx, D, F, "seed");

Deno.test("weights sum to 1 for posts and listings", () => {
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum(D.weights as unknown as Record<string, number>) - 1) < 1e-9);
  assert.ok(Math.abs(sum(D.listing_weights as unknown as Record<string, number>) - 1) < 1e-9);
});

Deno.test("same campus beats another campus, all else equal", () => {
  assert.ok(sc(cand({ inst: 1 })).score > sc(cand({ inst: 2 })).score);
});

Deno.test("strong cross-campus content still beats heavily rejected same-campus content", () => {
  const same = sc(cand({ post_id: 2, inst: 1, impressions: 50, negatives: 40 }));
  const cross = sc(cand({ post_id: 3, inst: 2, impressions: 100, views: 80, completions: 60, likes: 40, comments: 10, saves: 10 }));
  assert.ok(cross.score > same.score, `${cross.score} vs ${same.score}`);
});

Deno.test("raw counts do not dominate: a small good-rate post out-qualifies a huge low-rate one", () => {
  const huge = sc(cand({ impressions: 2000, views: 300, likes: 20 }));
  const small = sc(cand({ impressions: 40, views: 30, completions: 20, likes: 12, comments: 3 }));
  assert.ok(small.trace.features.quality > huge.trace.features.quality);
});

Deno.test("sparse data is neutral, not zero or maxed", () => {
  const q = sc(cand()).trace.features.quality;
  assert.ok(q > 0.3 && q < 0.7, String(q));
});

Deno.test("interest cannot take over: the football edge is bounded by the interest weight", () => {
  const football = sc(cand({ post_id: 5, topics: ["#football"] }));
  const other = sc(cand({ post_id: 6, topics: ["#cooking"] }));
  assert.ok(football.score - other.score < D.weights.interest, String(football.score - other.score));
});

Deno.test("cold start (no profile) produces finite scores and an ordered ranking", () => {
  const ranked = rankDiscover([cand({ post_id: 1 }), cand({ post_id: 2, age_hours: 200 })], EMPTY_PROFILE, F, D, "s");
  assert.ok(ranked.every((r) => Number.isFinite(r.score)));
  assert.ok(ranked[0].score >= ranked[1].score);
  assert.equal(ranked[0].trace.features.interest, 0);
});

Deno.test("content already consumed or engaged in Feed is demoted", () => {
  const fresh = sc(cand()).score;
  assert.ok(sc(cand({ feed_best: 4 })).score < fresh);
  assert.ok(sc(cand({ feed_acts: 4 })).score < fresh);
});

Deno.test("a tile seen in the grid is demoted, and the penalty decays with time", () => {
  const recent = sc(cand({ disc_seen: 2, disc_seen_hours: 1 })).score;
  const old = sc(cand({ disc_seen: 2, disc_seen_hours: 400 })).score;
  assert.ok(recent < old);
});

Deno.test("listings have their own quality track: inquiries help, video metrics are irrelevant", () => {
  const base = sc(cand({ kind: "listing", impressions: 20 })).trace.features.quality;
  const inquired = sc(cand({ kind: "listing", impressions: 20, inquiries: 3, list_opens: 6 })).trace.features.quality;
  const withVideoStats = sc(cand({ kind: "listing", impressions: 20, views: 500, completions: 500 })).trace.features.quality;
  assert.ok(inquired > base);
  assert.equal(withVideoStats, base);
});

Deno.test("scoring is deterministic for a given seed", () => {
  assert.equal(sc(cand()).score, sc(cand()).score);
});
