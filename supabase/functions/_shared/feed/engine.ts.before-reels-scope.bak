// Feed orchestrator: session lifecycle -> candidates -> rank -> compose -> pagination -> hydration.
// One code path for guests and authenticated users; policy differences live in config/weights.
import type { SupabaseClient } from "../auth.ts";
import { loadConfig, type FeedConfig } from "./config.ts";
import { type Candidate, EMPTY_PROFILE, type Profile } from "./types.ts";
import { rankCandidates, topFactors } from "./scoring.ts";
import { compose, suggestionDue, suggestionSlot } from "./composer.ts";
import {
  advanceSession, createSession, type FeedSession, getSession, mergeRebuild, rebuildAddsContent, newCursorPayload,
  type SessionItem, signCursor, verifyCursor, SESSION_TTL_MS,
} from "./session.ts";
import { batchAttachAudio } from "../services/audioAssetService.ts";
import { batchAttachReposted, formatListing, formatPost, getBookmarkedIds, getLikedIds } from "../services/feedService.ts";
import { resolveAvatarUrl } from "../avatar.ts";

export type Scope = "for_you" | "following" | "campus";
export type PeopleProvider = (ctx: { supabase: SupabaseClient; viewerId: number; sessionId: string }) =>
  Promise<{ id: number; reason: string }[]>;

export interface FeedRequest {
  supabase: SupabaseClient;
  viewerId: number | null;       // null = guest
  scope: Scope;
  cursor: string | null;
  refresh: boolean;
  cdnBase: string;
  peopleProvider?: PeopleProvider; // Phase 6. Absent => suggestion units are suppressed.
}
export interface FeedResult { body: Record<string, unknown>; trace: Record<string, unknown>[] }

const SELECT =
  "*, user:users!posts_user_id_foreign(id, name, username, avatar_key, avatar, allow_story_sharing), media:post_media(*), listingDetail:listing_details(*)";

// Labels are shown ONLY for reasons the provider proved with real evidence.
const PEOPLE_LABELS: Record<string, string> = {
  same_campus: "Faces Around Your Campus",
  mutual: "People Worth Knowing",
  similar_interests: "You Might Love Their Content",
  emerging: "Before Everyone Knows Them",
  wide: "Beyond Your Circle",
};

// ─── candidate building ──────────────────────────────────────────────────────────────────────────
let guestPool: { at: number; rows: Candidate[] } | null = null; // user-independent, so safe to share

async function loadPool(supabase: SupabaseClient, viewerId: number | null, seed: string): Promise<Candidate[]> {
  if (viewerId === null && guestPool && Date.now() - guestPool.at < 60_000) return guestPool.rows;
  const { data, error } = await supabase.rpc("feed_candidate_pool", {
    p_viewer: viewerId, p_seed: viewerId === null ? "guest" : seed,
  });
  if (error) throw error;
  const rows = (data ?? []) as Candidate[];
  if (viewerId === null) guestPool = { at: Date.now(), rows };
  return rows;
}

async function loadProfile(supabase: SupabaseClient, viewerId: number): Promise<Profile> {
  const { data, error } = await supabase.rpc("feed_user_profile", { p_viewer: viewerId });
  if (error) throw error;
  return (data ?? EMPTY_PROFILE) as Profile;
}

async function buildRanked(
  supabase: SupabaseClient, viewerId: number | null, cfg: FeedConfig, seed: string, exclude: Set<number>, resurface = false,
): Promise<{ items: SessionItem[]; poolSize: number }> {
  const mode = viewerId === null ? "guest" : "auth";
  const [pool, profile] = await Promise.all([
    loadPool(supabase, viewerId, seed),
    viewerId === null ? Promise.resolve(EMPTY_PROFILE) : loadProfile(supabase, viewerId),
  ]);
  const usable = pool.filter((c) => !exclude.has(c.post_id));
  const older: Candidate[] = [];  // seen before, outside the recent-delivery window
  const recent: Candidate[] = []; // delivered in the last live sessions: shown last, only if needed
  // First build only: a viewer who has seen everything inside the normal windows still gets a feed.
  // Seen/consumed/old posts are re-admitted; negatives, engaged posts, hides, blocks and visibility stay out.
  if (resurface && viewerId !== null && usable.length < cfg.compose.min_pool_relax) {
    const { data: raw } = await supabase.rpc("feed_cfg");
    const base = (raw ?? {}) as Record<string, any>;
    const wide = 365;
    const relaxed = { ...base, candidates: { ...(base.candidates ?? {}), seen_days: 0, consumed_days: 0,
      followed_days: wide, institution_days: wide, interest_days: wide, creator_days: wide,
      wide_days: wide, listing_days: wide, explore_days: wide } };
    const { data, error } = await supabase.rpc("feed_candidate_pool", { p_viewer: viewerId, p_seed: seed, p_cfg: relaxed });
    if (error) console.error("[feed] resurface pool failed:", error.message);
    else {
      const have = new Set(usable.map((c) => c.post_id));
      let added = 0;
      for (const c of (data ?? []) as Candidate[]) {
        if (have.has(c.post_id)) continue;
        have.add(c.post_id);
        if (exclude.has(c.post_id)) { recent.push(c); continue; }
        older.push(c); added++;
      }
      console.log(`[feed] resurface viewer=${viewerId} unseen=${usable.length} older=${older.length} recent=${recent.length}`);
    }
  }
  // Tiers keep the order honest: unseen first, then older seen posts, then what was delivered moments ago.
  const items = [usable, older, recent].flatMap((tier) =>
    tier.length ? compose(rankCandidates(tier, profile, cfg, { mode, seed }), cfg, { mode, seed }).items : []);
  return {
    poolSize: pool.length,
    items: items.map((p): SessionItem => ({
      t: "post", id: p.s.c.post_id, src: p.s.c.srcs, score: Math.round(p.s.score * 1e4) / 1e4,
      stage: p.s.trace.stage, why: topFactors(p.s.trace), k: p.s.c.kind,
    })),
  };
}

async function buildChrono(
  supabase: SupabaseClient, viewerId: number, scope: Scope,
): Promise<{ items: SessionItem[]; poolSize: number }> {
  const { data, error } = await supabase.rpc("feed_chrono_pool", { p_viewer: viewerId, p_scope: scope, p_limit: 100 });
  if (error) throw error;
  const rows = (data ?? []) as { post_id: number; kind: string }[];
  return {
    poolSize: rows.length,
    items: rows.map((r): SessionItem => ({
      t: "post", id: r.post_id, src: [scope], score: 0, stage: "chrono", why: [],
      k: r.kind === "listing" ? "listing" : "post",
    })),
  };
}

/** Posts the previous live sessions already delivered: a reset/new session must not replay them. */
async function recentDelivered(supabase: SupabaseClient, userId: number): Promise<Set<number>> {
  const { data } = await supabase.from("feed_sessions").select("items, pos")
    .eq("user_id", userId).eq("scope", "for_you").gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false }).limit(2);
  const out = new Set<number>();
  for (const s of (data ?? []) as { items: SessionItem[]; pos: number }[]) {
    for (const it of s.items.slice(0, s.pos)) if (it.t === "post") out.add(it.id);
  }
  return out;
}

// ─── hydration (re-validates eligibility/visibility at delivery time) ───────────────────────────────
export async function hydratePosts(
  supabase: SupabaseClient, viewerId: number | null, ids: number[], cdnBase: string,
): Promise<Map<number, unknown>> {
  const out = new Map<number, unknown>();
  if (!ids.length) return out;

  const { data: vis, error: vErr } = await supabase.rpc("feed_filter_visible", { p_viewer: viewerId, p_ids: ids });
  if (vErr) throw vErr;
  const okIds = ids.filter((i) => new Set((vis ?? []).map((r: { post_id: number }) => r.post_id)).has(i));
  if (!okIds.length) return out;

  const { data: rows, error } = await supabase.from("posts").select(SELECT).in("id", okIds);
  if (error) throw error;
  const posts = (rows ?? []) as any[];
  for (const p of posts) p.media = (p.media ?? []).filter((m: any) => !m.purged_at);
  await batchAttachAudio(supabase, posts);

  let liked = new Set<number>(), saved = new Set<number>(), following = new Set<number>();
  if (viewerId !== null) {
    await batchAttachReposted(supabase, viewerId, posts);
    const authorIds = [...new Set(posts.map((p) => p.user_id))];
    const [l, b, f] = await Promise.all([
      getLikedIds(supabase, viewerId, okIds),
      getBookmarkedIds(supabase, viewerId, okIds),
      supabase.from("follows").select("following_id").eq("follower_id", viewerId).in("following_id", authorIds),
    ]);
    liked = l; saved = b;
    following = new Set(((f.data ?? []) as { following_id: number }[]).map((r) => r.following_id));
  }

  await Promise.all(posts.map(async (p) => {
    const fol = following.has(p.user_id), lk = liked.has(p.id), bm = saved.has(p.id);
    out.set(p.id, p.type === "listing"
      ? await formatListing(supabase, p, cdnBase, fol, lk, bm)
      : await formatPost(supabase, p, cdnBase, lk, bm, fol));
  }));
  return out;
}

async function hydratePeople(
  supabase: SupabaseClient, viewerId: number, unit: Extract<SessionItem, { t: "people" }>, minGroup: number,
): Promise<Record<string, unknown> | null> {
  const ids = unit.users.map((u) => u.id);
  const [{ data: users }, { data: follows }, { data: blocks }] = await Promise.all([
    supabase.from("users").select("id, name, username, avatar_key, avatar, is_verified, campus_verified, tagline")
      .in("id", ids).eq("is_active", true).is("deleted_at", null),
    supabase.from("follows").select("following_id").eq("follower_id", viewerId).in("following_id", ids),
    supabase.from("user_blocks").select("blocker_id, blocked_id")
      .or(`and(blocker_id.eq.${viewerId},blocked_id.in.(${ids.join(",")})),and(blocked_id.eq.${viewerId},blocker_id.in.(${ids.join(",")}))`),
  ]);
  const followed = new Set(((follows ?? []) as { following_id: number }[]).map((r) => r.following_id));
  const blocked = new Set(((blocks ?? []) as { blocker_id: number; blocked_id: number }[])
    .flatMap((r) => [r.blocker_id, r.blocked_id]));
  const byId = new Map(((users ?? []) as any[]).map((u) => [u.id, u]));
  const out = unit.users
    .filter((u) => byId.has(u.id) && !followed.has(u.id) && !blocked.has(u.id) && u.id !== viewerId)
    .map((u) => {
      const row = byId.get(u.id);
      return {
        id: row.id, name: row.name, username: row.username,
        avatar: resolveAvatarUrl(row.avatar_key ?? row.avatar),
        is_verified: row.is_verified, campus_verified: row.campus_verified, tagline: row.tagline ?? null,
        reason: u.reason, label: PEOPLE_LABELS[u.reason] ?? null,
      };
    });
  if (out.length < minGroup) return null;
  return { type: "people_suggestion", id: unit.id, users: out };
}

// ─── the orchestrator ─────────────────────────────────────────────────────────────────────────────
export async function getFeed(req: FeedRequest): Promise<FeedResult> {
  const { supabase, viewerId, scope } = req;
  const mode = viewerId === null ? "guest" : "auth";
  if (mode === "guest" && scope !== "for_you") throw new Error("guest feeds only support for_you");
  const cfg = await loadConfig(supabase);

  // 1. resolve session ----------------------------------------------------------------------
  let session: FeedSession | null = null;
  let p = 0;
  let cursorReset = false;
  if (req.cursor && !req.refresh) {
    const v = await verifyCursor(req.cursor, viewerId);
    if (v.ok) {
      const s = await getSession(supabase, v.payload.s);
      if (s && s.user_id === viewerId && s.scope === scope && s.mode === mode) {
        session = s;
        p = Math.min(v.payload.p, s.pos);
      } else cursorReset = true;
    } else cursorReset = true;
  }

  if (!session) {
    const seed = crypto.randomUUID();
    const exclude = viewerId !== null && scope === "for_you" ? await recentDelivered(supabase, viewerId) : new Set<number>();
    const built = scope === "for_you"
      ? await buildRanked(supabase, viewerId, cfg, seed, exclude, true)
      : await buildChrono(supabase, viewerId as number, scope);
    const id = await createSession(supabase, {
      userId: viewerId, mode, scope, items: built.items, configVersion: cfg.version,
    });
    const now = Date.now();
    session = {
      id, user_id: viewerId, mode, scope, items: built.items, pos: 0, delivered: 0, consumed: 0,
      suggestions_shown: 0, consumed_at_last_suggestion: 0, rebuilds: 0, config_version: cfg.version,
      created_at: new Date(now).toISOString(), expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
    };
    p = 0;
  }

  // 2. assemble this page ---------------------------------------------------------------------
  const pageSize = cfg.compose.page_size;
  let items = session.items.slice();
  const replay = session.pos > p; // a retried / older cursor: serve exactly what was served, change nothing
  let suggestionsShown = session.suggestions_shown;
  let lastSuggestionAt = session.consumed_at_last_suggestion;
  let rebuilds = session.rebuilds;
  let changed = false;

  let slice = items.slice(p, p + pageSize);

  if (!replay && mode === "auth" && scope === "for_you" && req.peopleProvider &&
      slice.length >= 6 && !slice.some((i) => i.t === "people")) {
    const { count } = await supabase.from("feed_events").select("*", { count: "exact", head: true })
      .eq("user_id", viewerId as number).eq("session_id", session.id).eq("kind", "consume")
      .in("outcome", ["view", "complete", "rewatch"]);
    const consumed = count ?? 0;
    const due = suggestionDue({ shown: suggestionsShown, consumed, consumedAtLast: lastSuggestionAt }, session.id, cfg, mode);
    if (due.due) {
      const at = suggestionSlot(slice.map((i) => (i.t === "people" ? "people" : (i.k ?? "post"))), `${session.id}:${suggestionsShown}`);
      if (at !== null) {
        const users = await req.peopleProvider({ supabase, viewerId: viewerId as number, sessionId: session.id });
        if (users.length >= cfg.compose.suggest.min_group) {
          const unit: SessionItem = {
            t: "people", id: `ps_${session.id.slice(0, 8)}_${suggestionsShown}`,
            users: users.slice(0, cfg.compose.suggest.group_size),
          };
          items = [...items.slice(0, p + at), unit, ...items.slice(p + at)];
          slice = items.slice(p, p + pageSize);
          suggestionsShown++;
          lastSuggestionAt = consumed;
          changed = true;
        } // else: deferred/suppressed, state untouched so it is re-evaluated next page
      }
    }
  }

  const nextPos = p + slice.length;

  if (!replay && scope === "for_you" && items.length - nextPos < cfg.compose.rebuild_when_remaining &&
      rebuilds < cfg.compose.max_rebuilds) {
    const exclude = new Set(items.filter((i): i is Extract<SessionItem, { t: "post" }> => i.t === "post").map((i) => i.id));
    const built = await buildRanked(supabase, viewerId, cfg, `${session.id}:${rebuilds + 1}`, exclude);
    if (rebuildAddsContent(items, built.items)) {
      const merged = mergeRebuild(items, built.items);
      if (merged.length > items.length) items = merged;
      rebuilds++;
    } else {
      // Only surplus listings (or nothing) are left. Merging them would add one paced listing per
      // rebuild, i.e. one-item pages. Stop rebuilding; the feed ends cleanly at caught_up.
      rebuilds = cfg.compose.max_rebuilds;
    }
    changed = true;
  }

  // 3. persist progress; only the request that really advances the session counts as a delivery ----
  let advanced = false;
  if (!replay && nextPos > session.pos) {
    advanced = await advanceSession(supabase, session.id, nextPos, changed
      ? { items, suggestions_shown: suggestionsShown, consumed_at_last_suggestion: lastSuggestionAt, rebuilds }
      : {});
  }

  // 4. hydrate + type ------------------------------------------------------------------------------
  const postIds = slice.filter((i): i is Extract<SessionItem, { t: "post" }> => i.t === "post").map((i) => i.id);
  const hydrated = await hydratePosts(supabase, viewerId, postIds, req.cdnBase);

  const typed: Record<string, unknown>[] = [];
  const trace: Record<string, unknown>[] = [];
  for (let i = 0; i < slice.length; i++) {
    const it = slice[i];
    if (it.t === "post") {
      const post = hydrated.get(it.id);
      if (!post) continue; // vanished/restricted since it was ranked: silently dropped
      typed.push({ type: "post", id: `post_${it.id}`, post, meta: { src: it.src[0] ?? null, slot: p + i } });
      trace.push({ post_id: it.id, slot: p + i, src: it.src, score: it.score, stage: it.stage, why: it.why });
    } else if (viewerId !== null) {
      const unit = await hydratePeople(supabase, viewerId, it, cfg.compose.suggest.min_group);
      if (unit) { typed.push({ ...unit, meta: { slot: p + i } }); trace.push({ unit: it.id, slot: p + i }); }
    }
  }

  if (advanced && viewerId !== null && postIds.length) {
    const { error } = await supabase.rpc("feed_mark_delivered", { p_ids: [...hydrated.keys()] });
    if (error) console.error("feed_mark_delivered failed:", error.message);
  }

  // 5. response -------------------------------------------------------------------------------------
  const remaining = items.length - nextPos;
  const caughtUp = remaining <= 0;
  const nextCursor = caughtUp ? null : await signCursor(newCursorPayload(session.id, nextPos, viewerId));
  const total = items.filter((i) => i.t === "post").length;

  return {
    body: {
      version: 1,
      scope,
      session_id: session.id,
      items: typed,
      posts: typed.filter((i) => i.type === "post").map((i) => i.post), // legacy clients
      next_cursor: nextCursor,
      has_more: !caughtUp,
      caught_up: caughtUp,
      inventory: caughtUp ? "caught_up" : total < cfg.compose.min_pool_relax ? "growing" : "healthy",
      cursor_reset: cursorReset,
      ...(caughtUp ? { next_actions: mode === "guest" ? ["sign_up", "refresh"] : ["refresh", "discover_people", "discover_marketplace"] } : {}),
    },
    trace,
  };
}
