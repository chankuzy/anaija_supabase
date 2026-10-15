// Feed composition: turns a ranked list into a coherent, varied, paced feed. Pure + deterministic.
// Constraints relax in steps (level 0 strict -> 3 loose) so diversity rules never drop eligible content,
// EXCEPT listings, whose pacing limits are hard (marketplace must stay occasional, never a catalogue).
// Tail exception: when nothing but listings is left, spacing is unsatisfiable (no other content to space
// them with) and enforcing it only yields one-item pages, so the gap/min-slot rules are skipped and the
// per-page cap is raised to compose.listing_tail_max. The score floor still applies.
import type { Scored } from "./types.ts";
import type { FeedConfig } from "./config.ts";
import { hash01 } from "./scoring.ts";

export type Format = "video" | "image" | "listing";
export interface Placed { s: Scored; slot: number; rules: string[] }
export interface ComposeResult { items: Placed[]; leftover: Scored[] }

const FAMILIAR = ["followed", "institution", "interest", "creator"];
export const isFamiliar = (s: Scored) => s.c.srcs.some((x) => FAMILIAR.includes(x));
const isExplore = (s: Scored) => !isFamiliar(s) && s.c.srcs.includes("explore");
const isWide = (s: Scored) => !isFamiliar(s) && !s.c.srcs.includes("explore") && s.c.srcs.includes("wide");
export const formatOf = (s: Scored): Format =>
  s.c.kind === "listing" ? "listing" : s.c.is_video ? "video" : "image";

function extra(cfg: FeedConfig, key: string, dflt: number): number {
  const v = (cfg.compose as unknown as Record<string, unknown>)[key];
  return typeof v === "number" ? v : dflt;
}

export function compose(
  ranked: Scored[], cfg: FeedConfig, opts: { mode: "auth" | "guest"; seed: string },
): ComposeResult {
  const cc = cfg.compose;
  const auth = opts.mode === "auth";
  const remaining = ranked.slice();
  const out: Placed[] = [];
  const top = remaining.length ? remaining[0].score : 0;
  // quota picks must be reasonably relevant: never force something far below the best candidate
  const floor = top > 0 ? top * extra(cfg, "relevance_floor_ratio", 0.35) : -Infinity;
  const limit = Math.min(cc.session_items, remaining.length);
  let exploreN = 0, wideN = 0, lastListing = -1000;

  for (let slot = 0; slot < limit; slot++) {
    const pageStart = Math.floor(slot / cc.page_size) * cc.page_size;
    const inPage = out.filter((p) => p.slot >= pageStart);
    const listingsInPage = inPage.filter((p) => formatOf(p.s) === "listing").length;

    const tail = remaining.length > 0 && remaining.every((s) => formatOf(s) === "listing");
    const listingCap = tail
      ? Math.max(cc.listing_max_per_page, extra(cfg, "listing_tail_max", 4))
      : cc.listing_max_per_page;

    const ok = (s: Scored, level: number): boolean => {
      const f = formatOf(s);
      if (f === "listing") {
        if (s.score < cc.listing_min_score) return false;
        if (listingsInPage >= listingCap) return false;
        if (!tail && slot - lastListing < cc.listing_min_gap) return false;
        if (!tail && level < 3 && slot < cc.listing_min_slot) return false;
      }
      if (level < 3 && inPage.filter((p) => p.s.c.author_id === s.c.author_id).length >= cc.max_author_per_page) {
        return false;
      }
      if (level < 2 && out.slice(-cc.min_author_gap).some((p) => p.s.c.author_id === s.c.author_id)) return false;
      if (level < 1) {
        const run = out.slice(-cc.max_run_format);
        if (run.length === cc.max_run_format && run.every((p) => formatOf(p.s) === f)) return false;
      }
      return true;
    };
    const pickFrom = (pred: (s: Scored) => boolean, level: number) =>
      remaining.findIndex((s) => pred(s) && ok(s, level));

    let idx = -1;
    const rules: string[] = [];
    for (let level = 0; level <= 3 && idx < 0; level++) {
      let pref: ((s: Scored) => boolean) | null = null;
      let tag = "";
      if (auth && slot < cc.first_n_familiar) {
        pref = (s) => isFamiliar(s) && s.score >= floor; tag = "familiar_start";
      } else if (auth && slot >= cc.explore_min_slot && exploreN < Math.floor((slot + 1) * cc.explore_share)) {
        pref = (s) => isExplore(s) && s.score >= floor; tag = "explore_quota";
      } else if (auth && slot >= cc.explore_min_slot && wideN < Math.floor((slot + 1) * cc.wide_share)) {
        pref = (s) => isWide(s) && s.score >= floor; tag = "wide_quota";
      }
      if (pref) {
        idx = pickFrom(pref, level);
        if (idx >= 0) rules.push(tag);
      }
      if (idx < 0) idx = pickFrom(() => true, level);
      if (idx >= 0 && level > 0) rules.push(`relaxed_${level}`);
    }
    if (idx < 0) break; // only blocked listings left: stop rather than force them

    const [s] = remaining.splice(idx, 1);
    if (isExplore(s)) exploreN++;
    if (isWide(s)) wideN++;
    if (formatOf(s) === "listing") {
      lastListing = slot;
      if (tail) rules.push("listing_tail");
    }
    out.push({ s, slot, rules });
  }
  return { items: out, leftover: remaining };
}

// ─── People-suggestion scheduling (the orchestrator may defer or suppress) ────────────────────────────
export interface SuggestState { shown: number; consumed: number; consumedAtLast: number }

export function suggestionThreshold(sessionId: string, n: number, cfg: FeedConfig): number {
  const [lo, hi] = n === 0 ? cfg.compose.suggest.first_after : cfg.compose.suggest.next_after;
  return Math.min(hi, lo + Math.floor(hash01(`${sessionId}:sug:${n}`) * (hi - lo + 1)));
}

export function suggestionDue(
  state: SuggestState, sessionId: string, cfg: FeedConfig, mode: "auth" | "guest",
): { due: boolean; threshold: number; reason: string } {
  if (mode === "guest") return { due: false, threshold: 0, reason: "guest" };
  if (state.shown >= cfg.compose.suggest.max_per_session) return { due: false, threshold: 0, reason: "max_per_session" };
  const threshold = suggestionThreshold(sessionId, state.shown, cfg);
  const since = state.consumed - state.consumedAtLast;
  return since >= threshold
    ? { due: true, threshold, reason: "threshold_reached" }
    : { due: false, threshold, reason: "below_threshold" };
}

/** Insertion index (unit goes BEFORE kinds[idx]); never near the page edges, a listing, or another unit. */
export function suggestionSlot(kinds: string[], seed: string): number | null {
  const n = kinds.length;
  if (n < 6) return null;
  const cands: number[] = [];
  for (let i = 3; i <= n - 2; i++) {
    const a = kinds[i - 1], b = kinds[i];
    if (a !== "listing" && b !== "listing" && a !== "people" && b !== "people") cands.push(i);
  }
  if (!cands.length) return null;
  return cands[Math.min(cands.length - 1, Math.floor(hash01(seed) * cands.length))];
}
