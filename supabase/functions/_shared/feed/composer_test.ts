// Run: deno test -A --no-check
import { assert, assertEquals } from "jsr:@std/assert@1";
import { DEFAULT_CONFIG as CFG } from "./config.ts";
import { compose, formatOf, suggestionDue, suggestionSlot, suggestionThreshold } from "./composer.ts";
import type { Candidate, ScoreTrace, Scored } from "./types.ts";

function mk(o: Partial<Candidate>): Candidate {
  return {
    post_id: 0, author_id: 0, kind: "post", subtype: null, listing_type: null, age_hours: 10, inst: 1,
    is_video: false, duration_s: 0, topics: [], srcs: ["fresh"], interest_strength: 0, author_followers: 50,
    is_following: false, creator_score: 0, impressions: 20, views: 8, completions: 3, rewatches: 0, skips: 2,
    likes: 3, comments: 1, saves: 1, shares: 0, reposts: 0, follows_from: 0, negatives: 0, delivered: 20, ...o,
  };
}
const S = (id: number, score: number, o: Partial<Candidate> = {}): Scored => ({
  c: mk({ post_id: id, author_id: 1000 + id, ...o }), score, trace: {} as ScoreTrace,
});
const run = (r: Scored[]) => compose(r, CFG, { mode: "auth", seed: "t" });
const ids = (r: ReturnType<typeof run>) => r.items.map((p) => p.s.c.post_id);

Deno.test("every candidate is placed at most once; placed + leftover = input", () => {
  const input = [...Array.from({ length: 40 }, (_, i) => S(i + 1, 0.8 - i * 0.01)),
                 ...Array.from({ length: 5 }, (_, i) => S(101 + i, 0.95 - i * 0.01, { kind: "listing", srcs: ["listing"] }))]
    .sort((a, b) => b.score - a.score);
  const r = run(input);
  assertEquals(new Set(ids(r)).size, r.items.length);
  assertEquals(r.items.length + r.leftover.length, input.length);
});

Deno.test("author cap per page and author spacing", () => {
  // 12 authors x 3 posts; author 100 owns the top 3 scores (a worst case for repetition)
  const input = Array.from({ length: 36 }, (_, i) =>
    S(i + 1, 1 - (i + 1) * 0.01, { author_id: 100 + Math.floor(i / 3), is_video: i % 2 === 0 }));
  const r = run(input);
  const page0 = r.items.filter((p) => p.slot < 15);
  const counts = new Map<number, number>();
  for (const p of page0) counts.set(p.s.c.author_id, (counts.get(p.s.c.author_id) ?? 0) + 1);
  for (const [a, n] of counts) assert(n <= 2, `author ${a} appears ${n}x on page 0`);
  const first20 = r.items.slice(0, 20);
  for (let i = 0; i < first20.length; i++) {
    for (let j = i + 1; j < first20.length; j++) {
      if (first20[i].s.c.author_id === first20[j].s.c.author_id) assert(j - i >= 4, "same author too close");
    }
  }
});

Deno.test("no long runs of one format while variety exists", () => {
  const input = [
    ...Array.from({ length: 10 }, (_, i) => S(i + 1, 1 - i * 0.01, { is_video: true })),
    ...Array.from({ length: 20 }, (_, i) => S(11 + i, 0.8 - i * 0.01, { is_video: false })),
  ];
  const r = run(input).items.slice(0, 13).map((p) => formatOf(p.s));
  for (let i = 0; i + 3 < r.length; i++) {
    assert(!(r[i] === r[i + 1] && r[i] === r[i + 2] && r[i] === r[i + 3]), `run of 4 at ${i}: ${r.join(",")}`);
  }
});

Deno.test("first slots feel familiar when familiar content exists", () => {
  const input = [
    ...Array.from({ length: 5 }, (_, i) => S(i + 1, 1.0 - i * 0.01, { srcs: ["wide"], is_video: i % 2 === 0 })),
    ...Array.from({ length: 10 }, (_, i) => S(6 + i, 0.6 - i * 0.01, { srcs: ["followed"], is_video: i % 2 === 1 })),
  ];
  const r = run(input);
  for (const p of r.items.slice(0, 3)) assert(p.s.c.srcs.includes("followed"), `slot ${p.slot} not familiar`);
  assertEquals(r.items[0].rules.includes("familiar_start"), true);
});

Deno.test("cold start without familiar content just follows the ranking", () => {
  const input = Array.from({ length: 12 }, (_, i) => S(i + 1, 1 - i * 0.02, { srcs: ["explore", "fresh"], is_video: i % 2 === 0 }));
  const r = run(input);
  assertEquals(r.items.length, 12);
  assertEquals(r.items[0].s.c.post_id, 1);
});

Deno.test("listings stay occasional: not early, one per page, spaced, never flooded", () => {
  const input = [
    ...Array.from({ length: 40 }, (_, i) => S(i + 1, 0.79 - i * 0.01, { is_video: i % 2 === 0 })),
    ...Array.from({ length: 5 }, (_, i) => S(101 + i, 0.95 - i * 0.01, { kind: "listing", srcs: ["listing"] })),
  ].sort((a, b) => b.score - a.score);
  const r = run(input);
  const ls = r.items.filter((p) => formatOf(p.s) === "listing").map((p) => p.slot);
  assert(ls.length >= 2 && ls.length <= 3, `listings placed: ${ls.join(",")}`);
  assert(ls[0] >= 4, "no listing in the first 4 slots");
  for (let i = 1; i < ls.length; i++) assert(ls[i] - ls[i - 1] >= 10, "listing gap");
  const perPage = new Map<number, number>();
  for (const s of ls) perPage.set(Math.floor(s / 15), (perPage.get(Math.floor(s / 15)) ?? 0) + 1);
  for (const n of perPage.values()) assert(n <= 1);
  assert(r.leftover.some((s) => s.c.kind === "listing"), "surplus listings stay out of the session");
});

Deno.test("low-scoring listings are never forced in", () => {
  const input = [...Array.from({ length: 10 }, (_, i) => S(i + 1, 0.8 - i * 0.01, { is_video: i % 2 === 0 })),
                 S(200, 0.05, { kind: "listing", srcs: ["listing"] })];
  assertEquals(run(input).items.some((p) => p.s.c.post_id === 200), false);
});

Deno.test("irrelevant exploration is not forced into quota slots", () => {
  const input = [
    ...Array.from({ length: 30 }, (_, i) => S(i + 1, 1.0 - i * 0.01, { srcs: ["followed"], is_video: i % 2 === 0 })),
    ...Array.from({ length: 5 }, (_, i) => S(100 + i, 0.05, { srcs: ["explore"], is_video: i % 2 === 0 })),
  ];
  for (const p of run(input).items.filter((p) => p.s.c.post_id >= 100)) assert(p.slot >= 30, `forced at ${p.slot}`);
});

Deno.test("relevant exploration is honoured by the quota", () => {
  const input = [
    ...Array.from({ length: 40 }, (_, i) => S(i + 1, 0.99 - i * 0.01, { srcs: ["followed"], is_video: i % 2 === 0 })),
    ...Array.from({ length: 6 }, (_, i) => S(100 + i, 0.5, { srcs: ["explore"], is_video: i % 2 === 1 })),
  ].sort((a, b) => b.score - a.score);
  const n = run(input).items.slice(0, 20).filter((p) => p.s.c.srcs.includes("explore")).length;
  assert(n >= 2, `explore items in first 20: ${n}`);
});

Deno.test("deterministic for identical input", () => {
  const input = Array.from({ length: 30 }, (_, i) => S(i + 1, 1 - i * 0.01, { is_video: i % 3 === 0 }));
  assertEquals(ids(run(input)), ids(run(input)));
});

Deno.test("relaxation never drops eligible content", () => {
  const same = Array.from({ length: 6 }, (_, i) => S(i + 1, 0.9 - i * 0.05, { author_id: 7 }));
  assertEquals(run(same).items.length, 6);
});

Deno.test("suggestion thresholds are deterministic and inside the configured windows", () => {
  for (const sid of ["a", "b", "c", "d", "e", "f"]) {
    const t0 = suggestionThreshold(sid, 0, CFG), t1 = suggestionThreshold(sid, 1, CFG);
    assert(t0 >= 12 && t0 <= 18, `first ${t0}`);
    assert(t1 >= 20 && t1 <= 30, `next ${t1}`);
    assertEquals(t0, suggestionThreshold(sid, 0, CFG));
  }
  assert(new Set(["a", "b", "c", "d", "e", "f"].map((s) => suggestionThreshold(s, 0, CFG))).size > 1, "thresholds vary by session");
});

Deno.test("suggestion eligibility: guests never, threshold gating, session cap, fatigue spacing", () => {
  const sid = "sess-1";
  assertEquals(suggestionDue({ shown: 0, consumed: 99, consumedAtLast: 0 }, sid, CFG, "guest").due, false);
  assertEquals(suggestionDue({ shown: 0, consumed: 5, consumedAtLast: 0 }, sid, CFG, "auth").due, false);
  assertEquals(suggestionDue({ shown: 0, consumed: 18, consumedAtLast: 0 }, sid, CFG, "auth").due, true);
  const t1 = suggestionThreshold(sid, 1, CFG);
  assertEquals(suggestionDue({ shown: 1, consumed: 18 + t1 - 1, consumedAtLast: 18 }, sid, CFG, "auth").due, false);
  assertEquals(suggestionDue({ shown: 1, consumed: 18 + t1, consumedAtLast: 18 }, sid, CFG, "auth").due, true);
  assertEquals(suggestionDue({ shown: 2, consumed: 500, consumedAtLast: 100 }, sid, CFG, "auth").reason, "max_per_session");
});

Deno.test("suggestion slot avoids edges, listings and other units", () => {
  const plain = Array(15).fill("post");
  const i = suggestionSlot(plain, "x")!;
  assert(i >= 3 && i <= 13);
  const withListing = [...plain];
  withListing[5] = "listing"; withListing[6] = "listing";
  for (const seed of ["a", "b", "c", "d", "e", "f", "g"]) {
    const j = suggestionSlot(withListing, seed)!;
    assert(![5, 6, 7].includes(j), `slot ${j} touches a listing`);
  }
  assertEquals(suggestionSlot(["post", "post", "post"], "x"), null);
  assertEquals(suggestionSlot(plain, "x"), suggestionSlot(plain, "x"));
});
