// Run: deno test --no-check -A   (in this directory)
import assert from "node:assert/strict";
import { mergeRebuild, signCursor, verifyCursor, newCursorPayload, type SessionItem } from "../feed/session.ts";
import { compose, formatOf } from "./composer.ts";
import { DEFAULT_DISCOVER as D } from "./config.ts";
import { cand } from "./scoring_test.ts";
import type { DiscoverCandidate, DScored } from "./types.ts";

function ds(id: number, author: number, score: number, over: Partial<DiscoverCandidate> = {}, extra: Partial<DScored> = {}): DScored {
  return {
    c: cand({ post_id: id, author_id: author, ...over }), score, emerging: false, fresh01: 0.3, expo: 50,
    trace: { features: {}, weights: {}, contributions: {}, mult: 1, jitter: 0, total: score }, ...extra,
  };
}
const desc = (a: DScored[]) => a.slice().sort((x, y) => y.score - x.score);
const run = (a: DScored[], filter: "for_you" | "marketplace" = "for_you") => compose(desc(a), D, { filter });
const authors = (p: ReturnType<typeof run>) => p.map((x) => x.s.c.author_id);

function skewedPool(): DScored[] {
  const out: DScored[] = [];
  let id = 1;
  for (let i = 0; i < 10; i++) out.push(ds(id++, 1, 0.9 - i * 0.01)); // one creator dominates the top
  for (let a = 2; a <= 12; a++) for (let i = 0; i < 3; i++) out.push(ds(id++, a, 0.7 - a * 0.01 - i * 0.05));
  return out;
}

Deno.test("a dominant creator cannot take the first screen; no adjacent repeats on the first page", () => {
  const placed = run(skewedPool());
  const first = authors(placed).slice(0, D.compose.first_screen);
  assert.equal(new Set(first).size, first.length, `first screen repeats: ${first}`);
  const page = authors(placed).slice(0, D.page_size);
  for (let i = 1; i < page.length; i++) assert.notEqual(page[i], page[i - 1]);
  const perAuthor = new Map<number, number>();
  for (const a of page) perAuthor.set(a, (perAuthor.get(a) ?? 0) + 1);
  assert.ok(Math.max(...perAuthor.values()) <= D.compose.max_author_per_page + 1);
});

Deno.test("low inventory relaxes constraints instead of returning an empty grid", () => {
  const pool = [1, 2, 3, 4, 5].map((i) => ds(i, 7, 0.9 - i * 0.05)); // five posts, ONE creator
  assert.equal(run(pool).length, 5);
  assert.equal(run([]).length, 0);
});

Deno.test("no duplicate posts, and composition is deterministic", () => {
  const a = run(skewedPool()).map((p) => p.s.c.post_id);
  const b = run(skewedPool()).map((p) => p.s.c.post_id);
  assert.equal(new Set(a).size, a.length);
  assert.deepEqual(a, b);
});

Deno.test("listings are allocated to fixed slots: <=1 on the first screen, <=cap per page, never adjacent", () => {
  const pool: DScored[] = [];
  for (let i = 1; i <= 30; i++) pool.push(ds(i, i, 0.9 - i * 0.01));
  for (let i = 31; i <= 40; i++) pool.push(ds(i, i, 0.8 - (i - 31) * 0.01, { kind: "listing", is_video: false }));
  const placed = run(pool);
  const isL = (p: (typeof placed)[number]) => formatOf(p.s) === "listing";
  assert.ok(placed.filter((p) => p.slot < D.compose.first_screen).filter(isL).length <= D.compose.first_screen_max_listings);
  assert.ok(placed.filter((p) => p.slot < D.page_size).filter(isL).length <= D.compose.listing_max_per_page);
  for (let i = 1; i < placed.length; i++) assert.ok(!(isL(placed[i]) && isL(placed[i - 1])));
  assert.ok(placed.filter(isL).every((p) => p.slot >= D.compose.listing_first_slot));
  assert.ok(placed.filter(isL).length >= 1);
});

Deno.test("emerging posts get a fair share without outranking proven content wholesale", () => {
  const pool: DScored[] = [];
  for (let i = 1; i <= 40; i++) pool.push(ds(i, i, 0.9 - i * 0.005));
  for (let i = 41; i <= 48; i++) pool.push(ds(i, i, 0.55, {}, { emerging: true, expo: 2 }));
  const page = run(pool).slice(0, D.page_size);
  const n = page.filter((p) => p.s.emerging).length;
  assert.ok(n >= 5 && n <= 10, `emerging in first page: ${n}`);
});

Deno.test("near-duplicate captions are kept apart", () => {
  const pool: DScored[] = [ds(1, 1, 0.95, { caption_fp: "abc" }), ds(2, 2, 0.94, { caption_fp: "abc" })];
  for (let i = 3; i <= 30; i++) pool.push(ds(i, i, 0.9 - i * 0.01));
  const placed = run(pool);
  const a = placed.find((p) => p.s.c.post_id === 1)!.slot;
  const b = placed.find((p) => p.s.c.post_id === 2)!.slot;
  assert.ok(Math.abs(a - b) > D.compose.dup_gap, `${a} vs ${b}`);
});

Deno.test("marketplace filter returns only listings and still spreads sellers", () => {
  const pool: DScored[] = [];
  let id = 1;
  for (let a = 1; a <= 4; a++) for (let i = 0; i < 3; i++) pool.push(ds(id++, a, 0.8 - a * 0.02 - i * 0.01, { kind: "listing", is_video: false }));
  const placed = run(pool, "marketplace");
  assert.equal(placed.length, 12);
  const a = authors(placed);
  for (let i = 1; i < a.length; i++) assert.notEqual(a[i], a[i - 1]);
});

Deno.test("pagination: pages never repeat a post, and rebuild merges never reintroduce one", () => {
  const pool: DScored[] = [];
  for (let i = 1; i <= 80; i++) pool.push(ds(i, (i % 15) + 1, 0.95 - i * 0.003));
  const ids = run(pool).map((p) => p.s.c.post_id);
  const seen = new Set<number>();
  for (let p = 0; p < ids.length; p += D.page_size) for (const id of ids.slice(p, p + D.page_size)) {
    assert.ok(!seen.has(id), `duplicate ${id} across pages`);
    seen.add(id);
  }
  const mk = (id: number): SessionItem => ({ t: "post", id, src: ["quality"], score: 0, stage: "proven", why: [] });
  const merged = mergeRebuild([1, 2, 3].map(mk), [2, 3, 4, 5].map(mk));
  assert.deepEqual(merged.map((m) => (m as { id: number }).id), [1, 2, 3, 4, 5]);
});

Deno.test("signed cursor: round-trips, rejects tampering and other users", async () => {
  Deno.env.set("FEED_CURSOR_SECRET", "x".repeat(32));
  const tok = await signCursor(newCursorPayload("11111111-1111-4111-8111-111111111111", 30, 42));
  const ok = await verifyCursor(tok, 42);
  assert.ok(ok.ok && ok.payload.p === 30);
  const bad = await verifyCursor(tok.slice(0, -2) + "xx", 42);
  assert.ok(!bad.ok);
  const other = await verifyCursor(tok, 43);
  assert.ok(!other.ok && other.reason === "wrong_user");
});
