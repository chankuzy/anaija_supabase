import { DEFAULT_CONFIG as cfg } from "./config.ts";
import { type PeopleCandidate, pickGroup, scorePeople } from "./people.ts";

function ok(c: boolean, m: string) { if (!c) throw new Error(m); }
const base: PeopleCandidate = { uid: 1, reasons: [], mutuals: 0, shared_topics: 0, creator_aff: 0, followers: 10, age_days: 20, posts_30d: 3, positives: 2 };
const mk = (o: Partial<PeopleCandidate>) => ({ ...base, ...o });

Deno.test("mutual + campus outranks a weak wide-only candidate", () => {
  const a = scorePeople(mk({ uid: 1, reasons: ["mutual", "same_campus"], mutuals: 2 }), cfg, "s");
  const b = scorePeople(mk({ uid: 2, reasons: ["wide"] }), cfg, "s");
  ok(a.score > b.score && a.reason === "mutual", `got ${a.score} ${a.reason} vs ${b.score}`);
});
Deno.test("weak wide-only candidates are suppressed, strong ones can pass", () => {
  const weak = scorePeople(mk({ reasons: ["wide"] }), cfg, "s");
  const strong = scorePeople(mk({ reasons: ["wide"], positives: 10, posts_30d: 5 }), cfg, "s");
  ok(weak.score < cfg.people.min_score, "weak should be below min");
  ok(strong.score >= cfg.people.min_score, "strong should pass");
});
Deno.test("reason is evidence-bound", () => {
  const r = scorePeople(mk({ reasons: ["wide"], mutuals: 9, shared_topics: 9 }), cfg, "s");
  ok(r.reason === "wide", `reason leaked: ${r.reason}`);
});
Deno.test("same-campus active user is shown", () => {
  const r = scorePeople(mk({ reasons: ["same_campus"] }), cfg, "s");
  ok(r.score >= cfg.people.min_score, `score ${r.score}`);
});
Deno.test("group prefers varied reasons and respects min group", () => {
  const s = [
    { uid: 1, score: 0.50, reason: "same_campus" }, { uid: 2, score: 0.48, reason: "same_campus" },
    { uid: 3, score: 0.46, reason: "mutual" }, { uid: 4, score: 0.20, reason: "emerging" },
  ];
  const g = pickGroup(s, 3, 0.15, 2).map((x) => x.uid);
  ok(g.join() === "1,3,2", `got ${g}`);
  ok(pickGroup([s[3]], 3, 0.15, 2).length === 0, "single candidate must not form a group");
});
Deno.test("deterministic per seed", () => {
  const c = mk({ reasons: ["same_campus"] });
  ok(scorePeople(c, cfg, "x").score === scorePeople(c, cfg, "x").score, "not deterministic");
});
