// Discover orchestrator: session -> candidate pool -> rank -> compose -> pagination -> hydration.
// Shares infrastructure with Feed (eligibility/visibility SQL, affinity tables, sessions, signed cursor,
// hydration) but owns its own candidate pool, scoring, composition and exposure tracking.
import type { SupabaseClient } from "../auth.ts";
import { loadConfig, type FeedConfig } from "../feed/config.ts";
import { hydratePosts } from "../feed/engine.ts";
import {
  advanceSession, createSession, type FeedSession, getSession, mergeRebuild, newCursorPayload,
  SESSION_TTL_MS, type SessionItem, signCursor, verifyCursor,
} from "../feed/session.ts";
import { EMPTY_PROFILE, type Profile } from "../feed/types.ts";
import { compose, type Placed } from "./composer.ts";
import { type DiscoverConfig, loadDiscoverConfig } from "./config.ts";
import { rankDiscover, topFactors } from "./scoring.ts";
import type { DiscoverCandidate, DiscoverFilter } from "./types.ts";

export interface DiscoverRequest {
  supabase: SupabaseClient;
  viewerId: number;
  filter: DiscoverFilter;
  cursor: string | null;
  refresh: boolean;
  cdnBase: string;
}

// Most informative source first: it becomes the event attribution (feed_events.src).
const SRC_PRIORITY = ["campus", "cross", "emerging", "outside", "fresh", "quality", "listing"];
const primarySrc = (srcs: string[]) => [...srcs].sort((a, b) => {
  const ia = SRC_PRIORITY.indexOf(a), ib = SRC_PRIORITY.indexOf(b);
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
});

async function loadProfile(supabase: SupabaseClient, viewerId: number): Promise<Profile> {
  const { data, error } = await supabase.rpc("feed_user_profile", { p_viewer: viewerId });
  if (error) throw error;
  return (data ?? EMPTY_PROFILE) as Profile;
}

function toSessionItem(p: Placed): SessionItem {
  const s = p.s;
  return {
    t: "post", id: s.c.post_id, src: primarySrc(s.c.srcs), score: Math.round(s.score * 1e4) / 1e4,
    stage: s.emerging ? "emerging" : s.fresh01 >= 0.5 ? "fresh" : "proven",
    why: topFactors(s.trace), k: s.c.kind === "listing" ? "listing" : "post",
  };
}

/** One bounded pool rpc + scoring + composition. `exclude` is held back to the tail (or dropped). */
async function buildRanked(
  supabase: SupabaseClient, viewerId: number, filter: DiscoverFilter, d: DiscoverConfig, f: FeedConfig,
  seed: string, exclude: Set<number>, allowRecent: boolean,
): Promise<SessionItem[]> {
  const [pool, profile] = await Promise.all([
    supabase.rpc("discover_candidate_pool", { p_viewer: viewerId, p_seed: seed, p_filter: filter }),
    loadProfile(supabase, viewerId),
  ]);
  if (pool.error) throw pool.error;
  const ranked = rankDiscover((pool.data ?? []) as DiscoverCandidate[], profile, f, d, seed);
  const unseen = ranked.filter((s) => !exclude.has(s.c.post_id));
  const recent = allowRecent ? ranked.filter((s) => exclude.has(s.c.post_id)) : [];
  let placed = compose(unseen, d, { filter });
  if (recent.length) placed = compose(recent, d, { filter }, placed); // tail only: never lead with a repeat
  return placed.map(toSessionItem);
}

/** Posts the viewer's recent live Discover sessions already delivered: a new session must not replay them first. */
async function recentDelivered(supabase: SupabaseClient, userId: number, scope: string): Promise<Set<number>> {
  const { data } = await supabase.from("feed_sessions").select("items, pos")
    .eq("user_id", userId).eq("scope", scope).gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false }).limit(2);
  const out = new Set<number>();
  for (const s of (data ?? []) as { items: SessionItem[]; pos: number }[]) {
    for (const it of s.items.slice(0, s.pos)) if (it.t === "post") out.add(it.id);
  }
  return out;
}

export async function getDiscover(req: DiscoverRequest): Promise<Record<string, unknown>> {
  const { supabase, viewerId, filter } = req;
  const [f, d] = await Promise.all([loadConfig(supabase), loadDiscoverConfig(supabase)]);
  const scope = filter === "marketplace" ? "discover_market" : "discover";

  // 1. resolve session ---------------------------------------------------------------------------
  let session: FeedSession | null = null;
  let p = 0;
  let cursorReset = false;
  if (req.cursor && !req.refresh) {
    const v = await verifyCursor(req.cursor, viewerId);
    if (v.ok) {
      const s = await getSession(supabase, v.payload.s);
      if (s && s.user_id === viewerId && s.scope === scope && s.mode === "auth") {
        session = s;
        p = Math.min(v.payload.p, s.pos);
      } else cursorReset = true;
    } else cursorReset = true;
  }

  if (!session) {
    const seed = crypto.randomUUID();
    const exclude = await recentDelivered(supabase, viewerId, scope);
    const items = await buildRanked(supabase, viewerId, filter, d, f, seed, exclude, true);
    const id = await createSession(supabase, {
      userId: viewerId, mode: "auth", scope, items, configVersion: `${f.version}/discover1`,
    });
    const now = Date.now();
    session = {
      id, user_id: viewerId, mode: "auth", scope, items, pos: 0, delivered: 0, consumed: 0,
      suggestions_shown: 0, consumed_at_last_suggestion: 0, rebuilds: 0, config_version: f.version,
      created_at: new Date(now).toISOString(), expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
    };
    p = 0;
  }

  // 2. assemble this page ----------------------------------------------------------------------------
  let items = session.items.slice();
  const replay = session.pos > p; // retried / older cursor: serve exactly what was served
  let rebuilds = session.rebuilds;
  let changed = false;
  const slice = items.slice(p, p + d.page_size);
  const nextPos = p + slice.length;

  if (!replay && items.length - nextPos < d.rebuild_when_remaining && rebuilds < d.max_rebuilds) {
    const have = new Set(items.filter((i): i is Extract<SessionItem, { t: "post" }> => i.t === "post").map((i) => i.id));
    const built = await buildRanked(supabase, viewerId, filter, d, f, `${session.id}:${rebuilds + 1}`, have, false);
    if (built.some((i) => i.t === "post" && !have.has(i.id))) {
      items = mergeRebuild(items, built);
      rebuilds++;
    } else {
      rebuilds = d.max_rebuilds; // nothing new left: end cleanly instead of retrying every page
    }
    changed = true;
  }

  // 3. persist progress; only the request that really advances the session counts as a delivery ----------
  let advanced = false;
  if (!replay && nextPos > session.pos) {
    advanced = await advanceSession(supabase, session.id, nextPos, changed ? { items, rebuilds } : {});
  }

  // 4. hydrate (re-checks eligibility + visibility at delivery time) + type -----------------------------------
  const postIds = slice.filter((i): i is Extract<SessionItem, { t: "post" }> => i.t === "post").map((i) => i.id);
  const hydrated = await hydratePosts(supabase, viewerId, postIds, req.cdnBase);

  const typed: Record<string, unknown>[] = [];
  for (let i = 0; i < slice.length; i++) {
    const it = slice[i];
    if (it.t !== "post") continue;
    const post = hydrated.get(it.id) as { type?: string } | undefined;
    if (!post) continue; // vanished / restricted since it was ranked: silently dropped
    const type = post.type === "listing" ? "listing" : "post";
    typed.push({
      type, id: `${type}_${it.id}`, score: null, data: post,
      meta: { src: it.src[0] ?? null, slot: p + i, stage: it.stage },
    });
  }

  if (advanced && hydrated.size) {
    const { error } = await supabase.rpc("discover_mark_delivered", { p_ids: [...hydrated.keys()] });
    if (error) console.error("discover_mark_delivered failed:", error.message);
  }

  // 5. response ----------------------------------------------------------------------------------------------
  const remaining = items.length - nextPos;
  const caughtUp = remaining <= 0;
  const nextCursor = caughtUp ? null : await signCursor(newCursorPayload(session.id, nextPos, viewerId));
  const total = items.length;

  return {
    version: 1,
    filter,
    session_id: session.id,
    items: typed,
    next_cursor: nextCursor,
    has_more: !caughtUp,
    caught_up: caughtUp,
    inventory: caughtUp ? "caught_up" : total < d.page_size * 2 ? "growing" : "healthy",
    cursor_reset: cursorReset,
  };
}
