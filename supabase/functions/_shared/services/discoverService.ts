// supabase/functions/_shared/services/discoverService.ts
// Discover = candidate pool (SQL: discover_candidate_pool) + scoring/composition here.
// Tunables live in feed_config key 'discover' (UPDATE, no redeploy). The SQL side only reads 'candidates'.
import type { SupabaseClient } from "../auth.ts";
import {
  batchAttachReposted, formatListing, formatPost, getBookmarkedIds, getLikedIds, getMarketplaceFeed,
} from "./feedService.ts";
import { batchAttachAudio } from "./audioAssetService.ts";
import { getTrending } from "./hashtagService.ts";
import { getSuggestedCommunities } from "./communityService.ts";
import { resolveAvatarUrl } from "../avatar.ts";

const PEOPLE_PAGE_SIZE = 24;
const GEO_PAGE_SIZE = 24;
const NEARBY_RADIUS_KM = 25;

export type DiscoverLens = "for_you" | "trending" | "nearby" | "people" | "marketplace";

interface DiscoverCursor {
  s?: string;      // session seed (uuid) for pooled lenses
  d?: number[];    // post ids already delivered in this session
  n?: number;      // geo cursor (post id)
  u?: number;      // people cursor (user id)
  l?: number;      // marketplace cursor (listing id)
  all?: boolean;   // people lens fell back to all campuses
  seeded?: boolean;
}

function decodeCursor(raw: string | null): DiscoverCursor {
  if (!raw) return {};
  try { return JSON.parse(atob(raw)); } catch { return {}; }
}
function encodeCursor(c: DiscoverCursor): string { return btoa(JSON.stringify(c)); }

// ─── config ─────────────────────────────────────────────────────────────────────────────────────
const DEFAULTS: any = {
  page_size: 30, session_items: 90, max_rebuilds: 2,
  weights: { campus: 0.25, quality: 0.25, fresh: 0.2, novelty: 0.15, interest: 0.1, trending: 0.05 },
  listing_weights: { campus: 0.28, quality: 0.22, fresh: 0.18, novelty: 0.1, interest: 0.1, avail: 0.12 },
  fresh_halflife_h: { post: 48, listing: 120 },
  interest: { scale: 2.5, cap: 0.6, creator_scale: 4.0 },
  campus: { cross_floor: 0.22, cross_quality_gain: 0.35, neutral: 0.5 },
  novelty: { expo_scale: 25, unseen_w: 0.2, emerging_w: 0.2 },
  trending: { scale: 4, min_age_h: 6 },
  penalty: { consumed: 0.55, engaged: 0.8, disc_seen: 0.35, disc_seen_decay_h: 72, neg: 0.6 },
  ctr: { prior_rate: 0.25, prior_strength: 15, blend: 0.3 },
  listing: { prior_rate: 0.4, prior_strength: 10, inquiry_unit: 4, save_unit: 3, open_unit: 1, like_unit: 1, squash: 1.5 },
  compose: {
    max_author_per_page: 2, min_author_gap: 4, dup_gap: 12, emerging_share: 0.2, emerging_min_slot: 3,
    first_screen: 9, first_screen_max_listings: 1, listing_first_slot: 5, listing_max_per_page: 4,
    listing_min_gap: 5, listing_min_score: 0.2, max_run_format: 4,
  },
};

const TRENDING_WEIGHTS = { trending: 0.4, quality: 0.28, fresh: 0.17, novelty: 0.1, campus: 0.05, interest: 0 };
const CAMPUS_WEIGHTS = { campus: 0, quality: 0.32, fresh: 0.38, novelty: 0.2, interest: 0.1, trending: 0 };

function isObj(v: unknown): v is Record<string, any> { return !!v && typeof v === "object" && !Array.isArray(v); }
function deepMerge(base: any, over: any): any {
  if (!isObj(base) || !isObj(over)) return over ?? base;
  const out: any = { ...base };
  for (const k of Object.keys(over)) out[k] = isObj(base[k]) && isObj(over[k]) ? deepMerge(base[k], over[k]) : over[k];
  return out;
}

let cfgCache: { at: number; value: any } | null = null;
async function loadDiscoverConfig(supabase: SupabaseClient): Promise<any> {
  if (cfgCache && Date.now() - cfgCache.at < 60_000) return cfgCache.value;
  const { data } = await supabase.from("feed_config").select("value").eq("key", "discover").maybeSingle();
  const value = deepMerge(DEFAULTS, data?.value ?? {});
  cfgCache = { at: Date.now(), value };
  return value;
}

// ─── hydration ──────────────────────────────────────────────────────────────────────────────────
const POST_SELECT =
  "*, user:users!posts_user_id_foreign(id, name, username, avatar_key, avatar, allow_story_sharing), media:post_media(*), listingDetail:listing_details(*)";

/** Re-validates visibility at delivery time, then formats like every other post surface. */
async function hydrate(
  supabase: SupabaseClient, viewerId: number, ids: number[], cdnBase: string,
): Promise<Map<number, { type: string; data: any }>> {
  const out = new Map<number, { type: string; data: any }>();
  if (!ids.length) return out;

  const { data: vis, error: vErr } = await supabase.rpc("feed_filter_visible", { p_viewer: viewerId, p_ids: ids });
  if (vErr) throw vErr;
  const okSet = new Set((vis ?? []).map((r: any) => r.post_id));
  const okIds = ids.filter((i) => okSet.has(i));
  if (!okIds.length) return out;

  const { data: rows, error } = await supabase.from("posts").select(POST_SELECT).in("id", okIds);
  if (error) throw error;
  const posts = (rows ?? []) as any[];
  for (const p of posts) p.media = (p.media ?? []).filter((m: any) => !m.purged_at);
  await batchAttachAudio(supabase, posts);
  await batchAttachReposted(supabase, viewerId, posts);

  const authorIds = [...new Set(posts.map((p) => p.user_id))];
  const [liked, saved, fol] = await Promise.all([
    getLikedIds(supabase, viewerId, okIds),
    getBookmarkedIds(supabase, viewerId, okIds),
    supabase.from("follows").select("following_id").eq("follower_id", viewerId).in("following_id", authorIds),
  ]);
  const following = new Set(((fol.data ?? []) as any[]).map((r) => r.following_id));

  await Promise.all(posts.map(async (p) => {
    const f = following.has(p.user_id), l = liked.has(p.id), b = saved.has(p.id);
    const data = p.type === "listing"
      ? await formatListing(supabase, p, cdnBase, f, l, b)
      : await formatPost(supabase, p, cdnBase, l, b, f);
    out.set(p.id, { type: p.type, data });
  }));
  return out;
}

// ─── scoring ────────────────────────────────────────────────────────────────────────────────────
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

function hashUnit(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 10000) / 10000;
}

interface ScoreCtx { cfg: any; viewerInst: number | null; topics: Map<string, number>; seed: string; weights: Record<string, number> }
interface Scored { c: any; score: number }

function scoreOne(c: any, x: ScoreCtx): number {
  const cfg = x.cfg;
  const isListing = c.kind === "listing";

  // quality: smoothed engagement rate blended with Discover tile CTR
  let quality: number;
  if (isListing) {
    const L = cfg.listing;
    const demand = c.inquiries * L.inquiry_unit + c.saves * L.save_unit + c.list_opens * L.open_unit + c.likes * L.like_unit;
    const rate = (demand + L.prior_rate * L.prior_strength) / (c.impressions + L.prior_strength);
    quality = rate / (rate + L.squash);
  } else {
    const eng = (c.likes + 2 * c.comments + 3 * c.saves + 2 * c.shares + c.reposts + 0.3 * c.views + 1) / (c.impressions + 20);
    const ctr = cfg.ctr;
    const rate = (c.disc_opens + ctr.prior_rate * ctr.prior_strength) / (c.disc_impressions + ctr.prior_strength);
    quality = (1 - ctr.blend) * (eng / (eng + 0.4)) + ctr.blend * clamp01(rate);
  }

  const hl = isListing ? cfg.fresh_halflife_h.listing : cfg.fresh_halflife_h.post;
  const fresh = Math.pow(0.5, Math.max(0, c.age_hours) / hl);

  const cp = cfg.campus;
  const campus = x.viewerInst === null ? cp.neutral
    : c.inst === x.viewerInst ? 1
    : clamp01(cp.cross_floor + cp.cross_quality_gain * quality);

  const nv = cfg.novelty;
  const expo = c.impressions + c.disc_impressions;
  const lowExpo = 1 / (1 + expo / nv.expo_scale);
  const unseen = c.disc_seen === 0 ? 1 : 0;
  const emerging = (c.srcs ?? []).includes("emerging") ? 1 : 0;
  const novelty = (1 - nv.unseen_w - nv.emerging_w) * lowExpo + nv.unseen_w * unseen + nv.emerging_w * emerging;

  const it = cfg.interest;
  let topicSum = 0;
  for (const t of c.topics ?? []) topicSum += x.topics.get(t) ?? 0;
  const topicPart = Math.min(it.cap, 1 - Math.exp(-topicSum / it.scale));
  const creatorPart = 1 - Math.exp(-(c.creator_score ?? 0) / it.creator_scale);
  const interest = clamp01(topicPart + (1 - it.cap) * creatorPart);

  const tr = cfg.trending;
  const m = c.likes_24h + 2 * c.comments_24h + 3 * c.saves_24h;
  const ageGate = c.age_hours >= tr.min_age_h ? 1 : Math.max(0, c.age_hours) / tr.min_age_h;
  const trending = (m / (m + tr.scale)) * ageGate;

  const avail = c.price_minor != null ? 1 : 0.5;

  const f: Record<string, number> = { campus, quality, fresh, novelty, interest, trending, avail };
  let weighted = 0;
  for (const [k, w] of Object.entries(x.weights)) weighted += w * (f[k] ?? 0);

  // penalties: ASSUMPTION - feed_best/feed_acts non-zero means "already seen/engaged in the feed"
  const P = cfg.penalty;
  const feedPen = c.feed_acts > 0 ? P.engaged : c.feed_best > 0 ? P.consumed : 0;
  const seenPen = c.disc_seen > 0
    ? P.disc_seen * Math.pow(0.5, (c.disc_seen_hours ?? 0) / P.disc_seen_decay_h) : 0;
  const negPen = Math.min(P.neg, (c.negatives / (c.impressions + 20)) * 4);
  const pen = Math.min(0.95, feedPen + seenPen + negPen);

  return weighted * (1 - pen) + 0.03 * hashUnit(`${x.seed}:${c.post_id}`);
}

// ─── composition ────────────────────────────────────────────────────────────────────────────────
const SRC_PRIORITY = ["listing", "campus", "emerging", "cross", "outside", "fresh", "quality"];
const primarySrc = (c: any): string => SRC_PRIORITY.find((s) => (c.srcs ?? []).includes(s)) ?? (c.srcs?.[0] ?? "pool");

function compose(ranked: Scored[], cc: any, size: number): Scored[] {
  const rest = ranked.slice();
  const out: Scored[] = [];
  const authorCount = new Map<number, number>();
  let listings = 0, lastListingSlot = -999, emerging = 0, runLen = 0;
  let runKind: boolean | null = null;
  const emergingCap = Math.ceil(cc.emerging_share * size);

  // stage 0: all rules; 1: drop gap/dup/run; 2: author cap only; 3: anything
  const ok = (s: Scored, stage: number): boolean => {
    if (stage >= 3) return true;
    const c = s.c, slot = out.length;
    if ((authorCount.get(c.author_id) ?? 0) >= cc.max_author_per_page) return false;
    if (stage >= 2) return true;
    if (c.kind === "listing") {
      if (listings >= cc.listing_max_per_page) return false;
      if (slot < cc.listing_first_slot) return false;
      if (slot < cc.first_screen && listings >= cc.first_screen_max_listings) return false;
      if (slot - lastListingSlot < cc.listing_min_gap) return false;
      if (s.score < cc.listing_min_score) return false;
    }
    if (stage >= 1) return true;
    if (out.slice(-cc.min_author_gap).some((o) => o.c.author_id === c.author_id)) return false;
    if (c.caption_fp && out.slice(-cc.dup_gap).some((o) => o.c.caption_fp === c.caption_fp)) return false;
    if (runKind === c.is_video && runLen >= cc.max_run_format) return false;
    return true;
  };

  while (out.length < size && rest.length) {
    const slot = out.length;
    let idx = -1;
    if (slot >= cc.emerging_min_slot && emerging < emergingCap && slot % 4 === 3) {
      idx = rest.findIndex((s) => (s.c.srcs ?? []).includes("emerging") && ok(s, 0));
    }
    for (let stage = 0; idx < 0 && stage <= 3; stage++) idx = rest.findIndex((s) => ok(s, stage));
    if (idx < 0) break;
    const [s] = rest.splice(idx, 1);
    out.push(s);
    authorCount.set(s.c.author_id, (authorCount.get(s.c.author_id) ?? 0) + 1);
    if (s.c.kind === "listing") { listings++; lastListingSlot = slot; }
    if ((s.c.srcs ?? []).includes("emerging")) emerging++;
    if (runKind === s.c.is_video) runLen++; else { runKind = s.c.is_video; runLen = 1; }
  }
  return out;
}

/** Spreads seed units (people/communities/hashtags) evenly through a page of posts. */
function weave(items: any[], seeds: any[]): any[] {
  if (!seeds.length) return items;
  const out = items.slice();
  seeds.forEach((s, k) => {
    const pos = Math.round(((k + 1) * items.length) / (seeds.length + 1));
    out.splice(Math.min(out.length, pos + k), 0, s);
  });
  return out;
}

// ─── people / communities / hashtags seeds ─────────────────────────────────────────────────────
async function getSuggestedPeople(supabase: SupabaseClient, viewerId: number, institutionId: number | null, limit: number, maxId?: number) {
  const { data: follows } = await supabase.from("follows").select("following_id").eq("follower_id", viewerId);
  const followingIds = (follows ?? []).map((f: any) => f.following_id);

  let query = supabase
    .from("users")
    .select("id, name, username, avatar_key, avatar, is_verified, campus_verified")
    .eq("is_active", true)
    .neq("id", viewerId);

  if (followingIds.length) query = query.not("id", "in", `(${followingIds.join(",")})`);
  if (institutionId) query = query.eq("institution_id", institutionId);
  if (maxId !== undefined) query = query.lt("id", maxId);

  const { data, error } = await query.order("id", { ascending: false }).limit(limit);
  if (error) throw error;

  const counts = new Map<number, number>();
  await Promise.all((data ?? []).map(async (u: any) => {
    const { count } = await supabase.from("follows").select("*", { count: "exact", head: true }).eq("following_id", u.id);
    counts.set(u.id, count ?? 0);
  }));

  return (data ?? []).map((u: any) => ({
    id: u.id, name: u.name, username: u.username,
    avatar: resolveAvatarUrl(u.avatar_key ?? u.avatar),
    is_verified: u.is_verified, campus_verified: u.campus_verified,
    followers_count: counts.get(u.id) ?? 0,
  }));
}

async function seedPeopleAndCommunities(supabase: SupabaseClient, userId: number, institutionId: number | null) {
  const [people, communities] = await Promise.all([
    getSuggestedPeople(supabase, userId, institutionId, 4),
    getSuggestedCommunities(supabase, userId, institutionId, 3),
  ]);
  return [
    ...people.map((u: any) => ({ type: "person", id: `person_${u.id}`, score: null, data: u })),
    ...communities.map((c: any) => ({ type: "community", id: `community_${c.id}`, score: null, data: c })),
  ];
}

// ─── pooled lenses: for_you / trending / campus ────────────────────────────────────────────────
async function pooled(
  supabase: SupabaseClient, userId: number, institutionId: number | null,
  lens: "for_you" | "trending" | "campus", cursor: DiscoverCursor, cdnBase: string,
) {
  const cfg = await loadDiscoverConfig(supabase);
  const seed = cursor.s ?? crypto.randomUUID();
  const delivered = new Set<number>(cursor.d ?? []);
  const cap = cfg.session_items * (1 + cfg.max_rebuilds);
  const room = Math.min(cfg.page_size, cap - delivered.size);
  if (room <= 0) return { items: [], cursor: { s: seed, d: [...delivered], seeded: true }, hasMore: false, sessionId: seed };

  const [poolRes, profRes] = await Promise.all([
    supabase.rpc("discover_candidate_pool", { p_viewer: userId, p_seed: seed, p_filter: "for_you" }),
    supabase.rpc("feed_user_profile", { p_viewer: userId }),
  ]);
  if (poolRes.error) throw poolRes.error;

  const topics = new Map<string, number>();
  for (const t of ((profRes.data as any)?.topics ?? []) as { t: string; s: number }[]) topics.set(t.t, t.s);

  const campusOnly = lens === "campus" && institutionId !== null;
  const usable = ((poolRes.data ?? []) as any[]).filter((c) =>
    !delivered.has(c.post_id) && (!campusOnly || c.inst === institutionId));

  const weights = lens === "trending" ? TRENDING_WEIGHTS : lens === "campus" ? CAMPUS_WEIGHTS : cfg.weights;
  const listingWeights = lens === "for_you" ? cfg.listing_weights : weights;
  const ctxPost: ScoreCtx = { cfg, viewerInst: institutionId, topics, seed, weights };
  const ctxListing: ScoreCtx = { ...ctxPost, weights: listingWeights };

  const ranked: Scored[] = usable
    .map((c) => ({ c, score: scoreOne(c, c.kind === "listing" ? ctxListing : ctxPost) }))
    .sort((a, b) => b.score - a.score);

  const picks = compose(ranked, cfg.compose, room);
  const leftover = usable.length - picks.length;

  // Thin inventory: top the page up with the newest eligible posts rather than an empty grid.
  let fill: number[] = [];
  let fbMore = false;
  if (picks.length < room) {
    const exclude = new Set<number>([...delivered, ...picks.map((p) => p.c.post_id)]);
    let q = supabase.from("feed_eligible_posts").select("id, type, author_id")
      .in("type", ["post", "listing"]).neq("author_id", userId)
      .order("created_at", { ascending: false }).limit(150);
    if (campusOnly) q = q.or(`institution_id.eq.${institutionId},author_institution_id.eq.${institutionId}`);
    const { data: fb } = await q;
    const rows = ((fb ?? []) as any[]).filter((r) => !exclude.has(r.id));
    const need = room - picks.length;
    fill = rows.slice(0, need).map((r) => r.id);
    fbMore = rows.length > need;
  }

  const order: { id: number; src: string; score: number | null }[] = [
    ...picks.map((p) => ({ id: p.c.post_id as number, src: primarySrc(p.c), score: Math.round(p.score * 1e4) / 1e4 })),
    ...fill.map((id) => ({ id, src: "recent", score: null })),
  ];
  const hydrated = await hydrate(supabase, userId, order.map((o) => o.id), cdnBase);

  const items: any[] = [];
  order.forEach((o, i) => {
    const h = hydrated.get(o.id);
    if (!h) return; // vanished/restricted since ranking
    items.push({
      type: h.type, id: `${h.type}_${o.id}`, score: o.score, data: h.data,
      meta: { src: o.src, slot: Math.min(500, delivered.size + i) },
    });
  });

  if (hydrated.size) {
    const { error } = await supabase.rpc("discover_mark_delivered", { p_ids: [...hydrated.keys()] });
    if (error) console.error("discover_mark_delivered failed:", error.message);
  }

  for (const o of order) delivered.add(o.id);

  let seeds: any[] = [];
  if (!cursor.seeded) {
    if (lens === "trending") {
      const [hashtagResult, communities] = await Promise.all([
        getTrending(supabase),
        getSuggestedCommunities(supabase, userId, institutionId, 3),
      ]);
      seeds = [
        ...hashtagResult.hashtags.slice(0, 6).map((h: any) => ({ type: "trending", id: `trending_${h.id}`, score: h.posts_count, data: h })),
        ...communities.map((c: any) => ({ type: "community", id: `community_${c.id}`, score: null, data: c })),
      ];
    } else {
      seeds = await seedPeopleAndCommunities(supabase, userId, institutionId);
    }
  }

  const hasMore = (leftover > 0 || fbMore) && delivered.size < cap;
  return {
    items: weave(items, seeds),
    cursor: { s: seed, d: [...delivered], seeded: true } as DiscoverCursor,
    hasMore,
    sessionId: seed,
  };
}

// ─── nearby (real geo; only when the client sends coordinates) ─────────────────────────────────
async function nearbyGeo(
  supabase: SupabaseClient, userId: number, institutionId: number | null,
  cursor: DiscoverCursor, cdnBase: string, lat: number, lng: number,
) {
  const cursorId = cursor.n ?? Number.MAX_SAFE_INTEGER;
  const { data: geoRows, error } = await supabase.rpc("nearby_post_ids", {
    origin_lat: lat, origin_lng: lng, radius_km: NEARBY_RADIUS_KM, max_id: cursorId, result_limit: GEO_PAGE_SIZE + 1,
  });
  if (error) throw error;

  const hasMore = (geoRows?.length ?? 0) > GEO_PAGE_SIZE;
  const page = (geoRows ?? []).slice(0, GEO_PAGE_SIZE) as any[];
  const hydrated = await hydrate(supabase, userId, page.map((r) => r.id), cdnBase);

  const items = page.filter((r) => hydrated.has(r.id)).map((r, i) => {
    const h = hydrated.get(r.id)!;
    return { type: h.type, id: `${h.type}_${r.id}`, score: r.distance_km ?? null, data: h.data, meta: { src: "nearby", slot: i } };
  });

  let seeds: any[] = [];
  if (!cursor.seeded) seeds = await seedPeopleAndCommunities(supabase, userId, institutionId);
  const nextN = hasMore && page.length ? page[page.length - 1].id : undefined;
  return { items: weave(items, seeds), cursor: { n: nextN, seeded: true } as DiscoverCursor, hasMore, sessionId: null };
}

// ─── people ─────────────────────────────────────────────────────────────────────────────────────
async function people(supabase: SupabaseClient, userId: number, institutionId: number | null, cursor: DiscoverCursor) {
  const scope = cursor.all ? null : institutionId;
  let all = !!cursor.all;
  let users = await getSuggestedPeople(supabase, userId, scope, PEOPLE_PAGE_SIZE + 1, cursor.u);
  if (!users.length && scope && cursor.u === undefined) {
    users = await getSuggestedPeople(supabase, userId, null, PEOPLE_PAGE_SIZE + 1);
    all = true;
  }
  const hasMore = users.length > PEOPLE_PAGE_SIZE;
  const page = users.slice(0, PEOPLE_PAGE_SIZE);
  const items = page.map((u: any) => ({ type: "person", id: `person_${u.id}`, score: null, data: u }));
  const nextU = hasMore && page.length ? page[page.length - 1].id : undefined;
  return { items, cursor: { u: nextU, all, seeded: true } as DiscoverCursor, hasMore, sessionId: null };
}

// ─── marketplace ────────────────────────────────────────────────────────────────────────────────
async function marketplace(supabase: SupabaseClient, userId: number, institutionId: number | null, cursor: DiscoverCursor, cdnBase: string) {
  const cursorL = cursor.l ?? Number.MAX_SAFE_INTEGER;
  const data = await getMarketplaceFeed(supabase, userId, cdnBase, {
    institutionId: institutionId ?? undefined,
    cursor: cursorL < Number.MAX_SAFE_INTEGER ? btoa(String(cursorL)) : null,
    sort: "relevance",
  });
  const items = data.listings.map((l: any, i: number) => ({
    type: "listing", id: `listing_${l.id}`, score: null, data: l, meta: { src: "marketplace", slot: i },
  }));
  const nextL = data.next_cursor ? parseInt(atob(data.next_cursor), 10) : undefined;
  return { items, cursor: { l: nextL, seeded: true } as DiscoverCursor, hasMore: !!data.has_more, sessionId: null };
}

// ─── entry point ────────────────────────────────────────────────────────────────────────────────
export async function getDiscoverFeed(
  supabase: SupabaseClient,
  userId: number,
  cdnBase: string,
  opts: { lens: DiscoverLens; cursor: string | null; lat?: number; lng?: number },
) {
  const { data: user } = await supabase.from("users").select("institution_id").eq("id", userId).single();
  const institutionId: number | null = user?.institution_id ?? null;
  const cursor = decodeCursor(opts.cursor);
  const hasGeo = Number.isFinite(opts.lat) && Number.isFinite(opts.lng);

  let r: { items: any[]; cursor: DiscoverCursor; hasMore: boolean; sessionId: string | null };
  switch (opts.lens) {
    case "people": r = await people(supabase, userId, institutionId, cursor); break;
    case "marketplace": r = await marketplace(supabase, userId, institutionId, cursor, cdnBase); break;
    case "nearby":
      r = hasGeo
        ? await nearbyGeo(supabase, userId, institutionId, cursor, cdnBase, opts.lat!, opts.lng!)
        : await pooled(supabase, userId, institutionId, "campus", cursor, cdnBase);
      break;
    case "trending": r = await pooled(supabase, userId, institutionId, "trending", cursor, cdnBase); break;
    default: r = await pooled(supabase, userId, institutionId, "for_you", cursor, cdnBase);
  }

  return {
    items: r.items,
    next_cursor: r.hasMore ? encodeCursor(r.cursor) : null,
    has_more: r.hasMore,
    session_id: r.sessionId,
  };
}
