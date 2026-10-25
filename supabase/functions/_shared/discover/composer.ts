// Grid composition. Turns a ranked list into a varied 3-column grid. Pure + deterministic.
// Constraints are SOFT: level 0 is strict, each level relaxes more (4 = anything goes), so a small
// inventory never produces an empty grid. Listing placement is allocation-driven (fixed slots), not
// competition: listings only enter at their slots until posts run out.
import type { DiscoverConfig } from "./config.ts";
import { majorTopics } from "./scoring.ts";
import type { DiscoverFilter, DScored } from "./types.ts";

export type Format = "video" | "image" | "listing";
export interface Placed { s: DScored; slot: number; rules: string[] }

const FLOOR_RATIO = 0.35; // quota picks must stay within 35% of the best candidate's score

export const formatOf = (s: DScored): Format =>
  s.c.kind === "listing" ? "listing" : s.c.is_video ? "video" : "image";

function jaccard(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  const inter = a.filter((x) => sb.has(x)).length;
  return inter / (a.length + b.length - inter);
}

/** Same normalised caption, or same author posting about (nearly) the same topics. */
export function nearDuplicate(a: DScored, b: DScored): boolean {
  if (a.c.caption_fp && a.c.caption_fp === b.c.caption_fp) return true;
  if (a.c.author_id === b.c.author_id) {
    const ta = majorTopics(a.c), tb = majorTopics(b.c);
    if (ta.length >= 2 && tb.length >= 2 && jaccard(ta, tb) >= 0.6) return true;
  }
  return false;
}

export function compose(
  ranked: DScored[], d: DiscoverConfig, opts: { filter: DiscoverFilter }, prior: Placed[] = [],
): Placed[] {
  const cc = d.compose;
  const market = opts.filter === "marketplace";
  const out: Placed[] = prior.slice();
  const remaining = ranked.slice();
  const top = remaining.length ? remaining[0].score : 0;
  const floor = top > 0 ? top * FLOOR_RATIO : -Infinity;
  const limit = Math.min(d.session_items, out.length + remaining.length);

  let emergingN = out.filter((p) => p.s.emerging).length;
  let freshN = out.filter((p) => p.s.fresh01 >= 0.5).length;
  let lastListing = -1000;
  for (const p of out) if (formatOf(p.s) === "listing") lastListing = p.slot;

  const isTarget = (slot: number) =>
    !market && slot >= cc.listing_first_slot && (slot - cc.listing_first_slot) % cc.listing_every === 0;
  const gapBase = Math.max(cc.min_author_gap, cc.columns + 1); // covers the tile above AND beside

  for (let slot = out.length; slot < limit; slot++) {
    const pageStart = Math.floor(slot / d.page_size) * d.page_size;
    const inPage = out.filter((p) => p.slot >= pageStart);
    const listingsInPage = inPage.filter((p) => formatOf(p.s) === "listing").length;
    const topicWindow = slot - pageStart < cc.first_screen ? cc.first_screen : d.page_size;
    const topicLimit = Math.max(2, Math.ceil(cc.topic_max_share * topicWindow));

    const ok = (s: DScored, level: number): boolean => {
      const f = formatOf(s);
      if (!market && f === "listing") {
        if (s.score < cc.listing_min_score) return false;
        if (listingsInPage >= cc.listing_max_per_page) return false;
        if (slot - lastListing < cc.listing_min_gap) return false;
        if (level < 3 && !isTarget(slot)) return false;
        if (level < 3 && slot < cc.first_screen &&
            out.filter((p) => p.slot < cc.first_screen && formatOf(p.s) === "listing").length >= cc.first_screen_max_listings) return false;
      }
      const gap = level < 2 ? gapBase : level < 3 ? 2 : 0;
      if (gap > 0 && out.slice(-gap).some((p) => p.s.c.author_id === s.c.author_id)) return false;
      const perPage = level < 3 ? cc.max_author_per_page : level < 4 ? cc.max_author_per_page + 1 : Infinity;
      if (inPage.filter((p) => p.s.c.author_id === s.c.author_id).length >= perPage) return false;
      if (level < 2 && slot < cc.first_screen &&
          out.some((p) => p.slot < cc.first_screen && p.s.c.author_id === s.c.author_id)) return false;
      const dupWin = level < 2 ? cc.dup_gap : level < 3 ? Math.floor(cc.dup_gap / 2) : 0;
      if (dupWin > 0 && out.slice(-dupWin).some((p) => nearDuplicate(s, p.s))) return false;
      if (level < 2) {
        for (const t of majorTopics(s.c)) {
          if (inPage.filter((p) => p.s.c.topics.includes(t)).length >= topicLimit) return false;
        }
      }
      if (level < 1 && !market) {
        const run = out.slice(-cc.max_run_format);
        if (run.length === cc.max_run_format && run.every((p) => formatOf(p.s) === f)) return false;
      }
      return true;
    };

    const pick = (pred: (s: DScored) => boolean, level: number) =>
      remaining.findIndex((s) => pred(s) && ok(s, level));

    let idx = -1;
    const rules: string[] = [];
    for (let level = 0; level <= 4 && idx < 0; level++) {
      const quotas: [string, (s: DScored) => boolean][] = [];
      if (isTarget(slot)) quotas.push(["listing_slot", (s) => formatOf(s) === "listing"]);
      if (slot >= cc.emerging_min_slot && emergingN < Math.floor((slot + 1) * cc.emerging_share)) {
        quotas.push(["emerging_quota", (s) => s.emerging && (market || formatOf(s) !== "listing") && s.score >= floor]);
      }
      if (freshN < Math.floor((slot + 1) * cc.fresh_floor_share)) {
        quotas.push(["fresh_quota", (s) => s.fresh01 >= 0.5 && (market || formatOf(s) !== "listing") && s.score >= floor]);
      }
      for (const [tag, pred] of quotas) {
        idx = pick(pred, level);
        if (idx >= 0) { rules.push(tag); break; }
      }
      if (idx < 0) idx = pick(() => true, level);
      if (idx >= 0 && level > 0) rules.push(`relaxed_${level}`);
    }
    if (idx < 0) break; // only blocked listings left: stop rather than force a listing wall

    const [s] = remaining.splice(idx, 1);
    if (s.emerging) emergingN++;
    if (s.fresh01 >= 0.5) freshN++;
    if (formatOf(s) === "listing") lastListing = slot;
    out.push({ s, slot, rules });
  }
  return out;
}
