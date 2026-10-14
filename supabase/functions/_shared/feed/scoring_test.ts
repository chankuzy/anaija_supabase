// Behavioural tests on a small Nigerian-campus fixture (inst 1 = AFIT, 5 = a second campus, 7 = a third).
// Run:  deno test --no-check
import { assert, assertEquals } from "jsr:@std/assert@1";
import { DEFAULT_CONFIG as CFG } from "./config.ts";
import { rankCandidates } from "./scoring.ts";
import { distributionStage, effectiveExposure, postQuality } from "./distribution.ts";
import { type Candidate, EMPTY_PROFILE, type Profile, type Scored } from "./types.ts";

let nextId = 1000;
function mk(o: Partial<Candidate> = {}): Candidate {
  const id = nextId++;
  return {
    post_id: id, author_id: id + 5000, kind: "post", subtype: null, listing_type: null,
    age_hours: 10, inst: 1, is_video: false, duration_s: 0, topics: [], srcs: ["fresh"],
    interest_strength: 0, author_followers: 50, is_following: false, creator_score: 0,
    impressions: 20, views: 8, completions: 3, rewatches: 0, skips: 2, likes: 3, comments: 1,
    saves: 1, shares: 0, reposts: 0, follows_from: 0, negatives: 0, delivered: 20, ...o,
  };
}
const P = (o: Partial<Profile>): Profile => ({ ...EMPTY_PROFILE, ...o });
const tp = (t: string, s: number) => ({ t, s });
const rank = (c: Candidate[], p: Profile, mode: "auth" | "guest" = "auth") =>
  rankCandidates(c, p, CFG, { mode, seed: "t", jitter: 0 });
const sc = (r: Scored[], id: number) => r.find((x) => x.c.post_id === id)!;

function campus(): Candidate[] {
  return [
    mk({ post_id: 1, author_id: 101, topics: ["#coding", "#flutter", "cat:tech"], inst: 1 }),
    mk({ post_id: 2, author_id: 102, topics: ["#python", "cat:tech"], inst: 5, likes: 5, views: 12 }),
    mk({ post_id: 3, author_id: 103, topics: ["#naruto", "#anime"], inst: 1, is_video: true }),
    mk({ post_id: 4, author_id: 104, topics: ["#comedy", "cat:ent"], inst: 5, is_video: true, likes: 6, views: 14 }),
    mk({ post_id: 5, author_id: 105, topics: ["#afit", "sub:event"], inst: 1 }),
    mk({ post_id: 6, author_id: 106, kind: "listing", topics: ["cat:fashion", "#thrift"], inst: 1, srcs: ["listing"], views: 0, completions: 0 }),
    mk({ post_id: 7, author_id: 107, kind: "listing", topics: ["cat:tech", "#laptop"], inst: 1, srcs: ["listing"], views: 0, completions: 0 }),
    mk({ post_id: 8, author_id: 108, topics: ["#football", "#barca"], inst: 7, impressions: 40, views: 20, likes: 9 }),
    mk({ post_id: 9, author_id: 109, topics: ["#coding"], inst: 1, author_followers: 2, age_hours: 3, impressions: 0,
         views: 0, completions: 0, skips: 0, likes: 0, comments: 0, saves: 0, delivered: 0 }),
    mk({ post_id: 10, author_id: 110, topics: ["#comedy"], inst: 5, author_followers: 5000, age_hours: 30,
         impressions: 80, views: 40, completions: 25, rewatches: 5, likes: 12, comments: 3, saves: 4, shares: 2,
         follows_from: 1, skips: 6, delivered: 90 }),
  ];
}

const newUser = P({ user_id: 20, institution_id: 1 });
const tech = P({ user_id: 21, institution_id: 1,
  topics: [tp("#coding", 4), tp("#flutter", 3), tp("cat:tech", 3), tp("fmt:image", 4), tp("inst:1", 3)],
  creators: [{ id: 101, s: 2 }] });
const ent = P({ user_id: 22, institution_id: 5,
  topics: [tp("#naruto", 4.5), tp("#anime", 3.5), tp("#comedy", 3), tp("cat:ent", 2), tp("fmt:video", 4), tp("inst:5", 2)],
  creators: [{ id: 103, s: 5 }] });
const followsFew = P({ user_id: 23, institution_id: 1, following: 1, creators: [{ id: 105, s: 3 }] });

Deno.test("guest ranking ignores any personal profile", () => {
  const cands = [
    mk({ post_id: 1, topics: ["#coding"] }),
    mk({ post_id: 2, topics: ["#naruto"] }),
  ];
  const a = rank(cands, tech, "guest");
  const b = rank(cands, ent, "guest");
  assertEquals(a.map((x) => x.c.post_id), b.map((x) => x.c.post_id));
  assert(Math.abs(sc(a, 1).score - sc(a, 2).score) < 1e-9, "same stats + different topics must tie for guests");
  assertEquals(sc(a, 1).trace.features.interest, 0);
});

Deno.test("contrasting profiles produce different feeds", () => {
  const tops = [tech, ent, newUser, followsFew].map((p) => rank(campus(), p).slice(0, 3).map((x) => x.c.post_id).join(","));
  tops.push(rank(campus(), EMPTY_PROFILE, "guest").slice(0, 3).map((x) => x.c.post_id).join(","));
  assert(new Set(tops).size >= 3, `expected at least 3 distinct top-3 lists, got ${JSON.stringify(tops)}`);
});

Deno.test("interest drives ordering at equal quality", () => {
  const mkPair = () => [mk({ post_id: 1, topics: ["#coding", "#flutter"] }), mk({ post_id: 2, topics: ["#naruto", "#anime"] })];
  const rt = rank(mkPair(), tech);
  const re = rank(mkPair(), ent);
  assert(sc(rt, 1).score > sc(rt, 2).score + 0.1, "tech student should prefer tech");
  assert(sc(re, 2).score > sc(re, 1).score + 0.1, "entertainment fan should prefer anime");
});

Deno.test("a followed creator leads for a student who follows only one person", () => {
  const cands = campus().map((c) => ({ ...c, is_following: c.author_id === 105 }));
  assertEquals(rank(cands, followsFew)[0].c.post_id, 5);
});

Deno.test("cold-start user: finite scores, campus anchor but not a hard boundary", () => {
  const r = rank(campus(), newUser);
  for (const x of r) assert(Number.isFinite(x.score));
  assert(r.slice(0, 5).some((x) => x.c.inst !== 1) || r.some((x) => x.c.inst !== 1), "other campuses remain rankable");
  assert(sc(r, 1).trace.features.campus === 1 && sc(r, 2).trace.features.campus === 0);
});

Deno.test("cross-campus affinity lifts another campus's post", () => {
  const onlyHome = P({ user_id: 24, institution_id: 1, topics: [tp("inst:1", 3), tp("#coding", 3)] });
  const both = P({ user_id: 25, institution_id: 1, topics: [tp("inst:1", 3), tp("inst:5", 3), tp("#coding", 3)] });
  const cand = () => [mk({ post_id: 2, topics: ["#python", "cat:tech"], inst: 5 })];
  const a = sc(rank(cand(), onlyHome), 2).score;
  const b = sc(rank(cand(), both), 2).score;
  assert(b - a > 0.025, `cross-campus affinity should add ~0.03, got ${b - a}`);
});

Deno.test("new creator's seed post is not buried by an established post (cold-start viewer)", () => {
  const r = rank(campus(), newUser);
  assertEquals(sc(r, 9).trace.stage, "seed");
  assert(sc(r, 9).score > sc(r, 10).score, "fresh post from a 2-follower creator should outrank the mediocre 5000-follower post");
});

Deno.test("discovery boost is relevance-gated for personalised users; exploration gets a partial pass", () => {
  const relevant = mk({ post_id: 1, topics: ["#coding"], age_hours: 3, impressions: 0, delivered: 0, views: 0, completions: 0, skips: 0, likes: 0, comments: 0, saves: 0, inst: null });
  const irrelevant = mk({ post_id: 2, topics: ["#naruto"], age_hours: 3, impressions: 0, delivered: 0, views: 0, completions: 0, skips: 0, likes: 0, comments: 0, saves: 0, inst: null });
  const explore = { ...irrelevant, post_id: 3, srcs: ["explore"] };
  const r = rank([relevant, irrelevant, explore], tech);
  assert(sc(r, 1).trace.features.discovery > 0.5);
  assert(Math.abs(sc(r, 2).trace.features.discovery) < 1e-12);
  assert(sc(r, 3).trace.features.discovery > 0.4);
});

Deno.test("negative creator feedback pushes a creator's post down", () => {
  const liked = P({ ...tech, creators: [{ id: 101, s: 2 }] });
  const disliked = P({ ...tech, creators: [{ id: 101, s: -6 }] });
  const cand = () => [mk({ post_id: 1, author_id: 101, topics: ["#coding"] })];
  const diff = sc(rank(cand(), liked), 1).score - sc(rank(cand(), disliked), 1).score;
  assert(diff > 0.2, `expected a large drop, got ${diff}`);
});

Deno.test("post-level negative feedback lowers rank and can demote", () => {
  const clean = mk({ post_id: 1 });
  const bad = mk({ post_id: 2, negatives: 6 });
  const r = rank([clean, bad], newUser);
  assert(sc(r, 1).score - sc(r, 2).score > 0.2);
  assertEquals(sc(r, 2).trace.stage, "demoted");
});

Deno.test("one lonely like does not create an interest", () => {
  const weak = P({ user_id: 26, institution_id: 1, topics: [tp("#coding", 1.0)] });
  const r = rank([mk({ post_id: 1, topics: ["#coding"] })], weak);
  assert(sc(r, 1).trace.features.interest < 0.15);
});

Deno.test("distribution lifecycle", () => {
  const D = CFG.dist;
  assertEquals(distributionStage(0, 0.41, 3, D).stage, "seed");
  assert(distributionStage(0, 0.41, 3, D).boost > 0.8);
  assertEquals(distributionStage(5, 0.41, 3, D).stage, "seed");
  assert(effectiveExposure(5, 40) >= D.seed_cap, "pages served bound exposure even when impressions are lost");
  assertEquals(distributionStage(30, 0.10, 10, D).stage, "demoted");
  assert(distributionStage(30, 0.10, 10, D).boost < 0);
  assertEquals(distributionStage(30, 0.55, 10, D).stage, "promoted");
  assertEquals(distributionStage(30, 0.25, 10, D).stage, "held");
  assertEquals(distributionStage(500, 0.90, 10, D).stage, "saturated");
  // seed boost fades with age
  assert(distributionStage(0, 0.4, 600, D).boost < distributionStage(0, 0.4, 3, D).boost);
});

Deno.test("sparse data does not overreact", () => {
  const one = postQuality({ impressions: 10, views: 2, completions: 0, rewatches: 0, skips: 1, likes: 0, comments: 0,
    saves: 0, shares: 0, reposts: 0, follows_from: 0, negatives: 0 }, CFG.quality);
  assert(one.quality >= CFG.dist.demote_q, "a single skip at 10 impressions must not demote");
  const fresh = postQuality({ impressions: 0, views: 0, completions: 0, rewatches: 0, skips: 0, likes: 0, comments: 0,
    saves: 0, shares: 0, reposts: 0, follows_from: 0, negatives: 0 }, CFG.quality);
  assert(fresh.quality > 0.3 && fresh.quality < 0.5, "a brand-new post starts at a neutral prior");
});

Deno.test("scores are finite for every fixture across every profile", () => {
  for (const p of [newUser, tech, ent, followsFew, EMPTY_PROFILE]) {
    for (const mode of ["auth", "guest"] as const) {
      for (const x of rank(campus(), p, mode)) assert(Number.isFinite(x.score), `${mode} ${x.c.post_id}`);
    }
  }
});
