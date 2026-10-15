import { compose } from "./composer.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import type { Candidate, Scored } from "./types.ts";

function cand(id: number, author: number, kind: "post" | "listing"): Candidate {
  return {
    post_id: id, author_id: author, kind, subtype: null,
    listing_type: kind === "listing" ? "product" : null,
    age_hours: 5, inst: 1, is_video: kind === "post" && id % 2 === 0, duration_s: 0,
    topics: [], srcs: ["wide"], interest_strength: 0, author_followers: 0, is_following: false,
    creator_score: 0, impressions: 0, views: 0, completions: 0, rewatches: 0, skips: 0, likes: 0,
    comments: 0, saves: 0, shares: 0, reposts: 0, follows_from: 0, negatives: 0, delivered: 0,
  };
}
function scored(c: Candidate, score: number): Scored {
  return {
    c, score,
    trace: { mode: "guest", stage: "seed", boost: 1, rate: 0, quality: 0, features: {}, weights: {},
             contributions: {}, jitter: 0, total: score },
  };
}
const byScore = (a: Scored, b: Scored) => b.score - a.score;
function posts(n: number): Scored[] {
  return Array.from({ length: n }, (_, i) => scored(cand(i + 1, (i % 10) + 1, "post"), 1 - i * 0.01));
}
function expect(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

Deno.test("tail: leftover listings are delivered together, not one per page", () => {
  const ranked = [
    ...posts(30),
    scored(cand(101, 21, "listing"), 0.5),
    scored(cand(102, 22, "listing"), 0.45),
    scored(cand(103, 23, "listing"), 0.4),
  ].sort(byScore);
  const r = compose(ranked, DEFAULT_CONFIG, { mode: "guest", seed: "t1" });
  expect(r.leftover.length === 0, `leftover should be empty, got ${r.leftover.length}`);
  expect(r.items.length === 33, `expected 33 items, got ${r.items.length}`);
  expect(r.items.slice(-3).every((p) => p.s.c.kind === "listing"), "last three should be the listings");
  expect(r.items.slice(-3).every((p) => p.rules.includes("listing_tail")), "tail rule should be tagged");
});

Deno.test("tail: a below-floor listing never pads the end", () => {
  const ranked = [...posts(20), scored(cand(201, 30, "listing"), 0.05)].sort(byScore);
  const r = compose(ranked, DEFAULT_CONFIG, { mode: "guest", seed: "t2" });
  expect(r.items.every((p) => p.s.c.kind === "post"), "junk listing must not be placed");
  expect(r.leftover.length === 1, "junk listing stays out");
});

Deno.test("listings stay paced while other content exists", () => {
  const ranked = [
    ...posts(40),
    scored(cand(301, 21, "listing"), 0.995),
    scored(cand(302, 22, "listing"), 0.994),
    scored(cand(303, 23, "listing"), 0.993),
  ].sort(byScore);
  const cc = DEFAULT_CONFIG.compose;
  const r = compose(ranked, DEFAULT_CONFIG, { mode: "guest", seed: "t3" });
  const slots = r.items.filter((p) => p.s.c.kind === "listing").map((p) => p.slot);
  expect(slots.length === 3, `expected 3 listings placed, got ${slots.length}`);
  for (let i = 1; i < slots.length; i++) {
    expect(slots[i] - slots[i - 1] >= cc.listing_min_gap, `gap too small: ${slots}`);
  }
  const pages = new Set(slots.map((s) => Math.floor(s / cc.page_size)));
  expect(pages.size === slots.length, `more than one listing in a page: ${slots}`);
  expect(slots[0] >= cc.listing_min_slot, `first listing too early: ${slots}`);
});
