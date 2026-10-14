// People recommendation: SQL supplies evidence (feed_people_candidates), this module scores and groups it.
// Reasons are only ever those the SQL proved; the label shown to the user derives from the winning reason.
import type { SupabaseClient } from "../auth.ts";
import { type FeedConfig, loadConfig } from "./config.ts";

export interface PeopleCandidate {
  uid: number; reasons: string[]; mutuals: number; shared_topics: number; creator_aff: number;
  followers: number; age_days: number; posts_30d: number; positives: number;
}
export interface ScoredPerson { uid: number; score: number; reason: string }

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const PRIORITY = ["mutual", "similar_interests", "same_campus", "emerging", "wide"];

function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000;
}

export function scorePeople(c: PeopleCandidate, cfg: FeedConfig, seed: string): ScoredPerson {
  const p = cfg.people, w = p.weights, has = new Set(c.reasons);
  const parts: Record<string, number> = {
    mutual: has.has("mutual") ? w.mutual * clamp01(Math.sqrt(c.mutuals / 4)) : 0,
    similar_interests: has.has("similar_interests")
      ? w.interest * clamp01(Math.max(c.shared_topics / 4, Math.tanh(Math.max(c.creator_aff, 0) / cfg.rank.creator_scale))) : 0,
    same_campus: has.has("same_campus") ? w.campus : 0,
    emerging: has.has("emerging") ? w.emerging * clamp01(1 - c.followers / p.small_followers) : 0,
    wide: has.has("wide") ? w.wide : 0,
  };
  const quality = w.quality * clamp01(c.positives / 10) + w.activity * clamp01(c.posts_30d / 5);
  const reason = PRIORITY.filter((r) => has.has(r)).sort((a, b) => parts[b] - parts[a])[0] ?? "wide";
  const jitter = (hash01(`${seed}:${c.uid}`) - 0.5) * 2 * p.jitter;
  const score = Object.values(parts).reduce((a, b) => a + b, 0) + quality + jitter;
  return { uid: c.uid, score: Math.round(score * 1e4) / 1e4, reason };
}

/** Greedy pick: highest score first, mild penalty for repeating a reason so a unit feels varied. */
export function pickGroup(scored: ScoredPerson[], size: number, minScore: number, minGroup: number): ScoredPerson[] {
  const pool = scored.filter((s) => s.score >= minScore);
  const out: ScoredPerson[] = [];
  const used = new Set<string>();
  while (out.length < size && pool.length) {
    let bi = 0, bv = -Infinity;
    pool.forEach((s, i) => { const v = s.score - (used.has(s.reason) ? 0.05 : 0); if (v > bv) { bv = v; bi = i; } });
    const [pick] = pool.splice(bi, 1);
    out.push(pick); used.add(pick.reason);
  }
  return out.length >= minGroup ? out : [];
}

export async function peopleProvider(
  ctx: { supabase: SupabaseClient; viewerId: number; sessionId: string },
): Promise<{ id: number; reason: string }[]> {
  const cfg = await loadConfig(ctx.supabase);
  const { data, error } = await ctx.supabase.rpc("feed_people_candidates", { p_viewer: ctx.viewerId });
  if (error) { console.error("[people] candidates failed:", error.message); return []; }

  // never repeat a person already shown in an earlier unit of this same session (impressions may lag)
  const { data: s } = await ctx.supabase.from("feed_sessions").select("items").eq("id", ctx.sessionId).maybeSingle();
  const seen = new Set<number>();
  for (const it of ((s?.items ?? []) as { t: string; users?: { id: number }[] }[])) {
    if (it.t === "people") for (const u of it.users ?? []) seen.add(u.id);
  }
  const scored = ((data ?? []) as PeopleCandidate[]).filter((c) => !seen.has(c.uid))
    .map((c) => scorePeople(c, cfg, ctx.sessionId));
  return pickGroup(scored, cfg.compose.suggest.group_size, cfg.people.min_score, cfg.compose.suggest.min_group)
    .map((x) => ({ id: x.uid, reason: x.reason }));
}
