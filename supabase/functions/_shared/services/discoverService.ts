// supabase/functions/_shared/services/discoverService.ts
import type { SupabaseClient } from "../auth.ts";
import { formatPost, formatListing, getLikedIds, getBookmarkedIds, getMarketplaceFeed } from "./feedService.ts";
import { getTrending } from "./hashtagService.ts";
import { getSuggestedCommunities } from "./communityService.ts";
import { resolveAvatarUrl } from "../avatar.ts";

const PAGE_SIZE = 24;
const NEARBY_RADIUS_KM = 25;
const TRENDING_WINDOW_DAYS = 7;

export type DiscoverLens = "for_you" | "trending" | "nearby" | "people" | "marketplace";

interface DiscoverCursor {
  p?: number; // posts/feed cursor id
  l?: number; // marketplace listing cursor id
  n?: number; // nearby geo cursor id (post id)
  u?: number; // people cursor id (user id)
  all?: boolean; // people lens fell back to all campuses
  seeded?: boolean; // whether people/communities/hashtags were already sent
}

function decodeCursor(raw: string | null): DiscoverCursor {
  if (!raw) return {};
  try {
    return JSON.parse(atob(raw));
  } catch {
    return {};
  }
}

function encodeCursor(c: DiscoverCursor): string {
  return btoa(JSON.stringify(c));
}

/// Suggested people — NOT a ranking model. Same-institution users the
/// viewer doesn't already follow, most-recent-first. Flagged in the item
/// as a coarse heuristic, same honesty level as before this was backend.
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

  // Follower counts for the person cards (head-only count per user).
  const counts = new Map<number, number>();
  await Promise.all((data ?? []).map(async (u: any) => {
    const { count } = await supabase.from("follows").select("*", { count: "exact", head: true }).eq("following_id", u.id);
    counts.set(u.id, count ?? 0);
  }));

  return (data ?? []).map((u: any) => ({
    id: u.id,
    name: u.name,
    username: u.username,
    avatar: resolveAvatarUrl(u.avatar_key ?? u.avatar),
    is_verified: u.is_verified,
    campus_verified: u.campus_verified,
    followers_count: counts.get(u.id) ?? 0,
  }));
}

/// Client-side-visible diversity pass, run server-side now — greedy
/// round-robin across types so the frontend receives an already-mixed
/// feed rather than doing this itself. The frontend keeps a lightweight
/// version of this as defense-in-depth only.
function diversify(items: any[]): any[] {
  const buckets = new Map<string, any[]>();
  for (const item of items) {
    if (!buckets.has(item.type)) buckets.set(item.type, []);
    buckets.get(item.type)!.push(item);
  }
  const types = [...buckets.keys()];
  const result: any[] = [];
  let i = 0;
  while ([...buckets.values()].some((b) => b.length)) {
    const type = types[i % types.length];
    const bucket = buckets.get(type)!;
    if (bucket.length) result.push(bucket.shift());
    i++;
  }
  return result;
}

async function seedPeopleAndCommunities(supabase: SupabaseClient, userId: number, institutionId: number | null) {
  const [people, communities] = await Promise.all([
    getSuggestedPeople(supabase, userId, institutionId, 4),
    getSuggestedCommunities(supabase, userId, institutionId, 3),
  ]);

  return [
    ...people.map((u) => ({ type: "person", id: `person_${u.id}`, score: null, data: u })),
    ...communities.map((c) => ({ type: "community", id: `community_${c.id}`, score: null, data: c })),
  ];
}

// ─── For You ────────────────────────────────────────────────────────────────

async function forYou(supabase: SupabaseClient, userId: number, institutionId: number | null, cursor: DiscoverCursor, cdnBase: string) {
  const cursorId = cursor.p ?? Number.MAX_SAFE_INTEGER;

  const { data: follows } = await supabase.from("follows").select("following_id").eq("follower_id", userId);
  const followingIds = (follows ?? []).map((f: any) => f.following_id);
  const followingSet = new Set<number>(followingIds);
  const visibleUserIds = [...new Set([userId, ...followingIds])];

  let query = supabase
    .from("posts")
    .select("*, user:users!posts_user_id_foreign(id, name, username, avatar_key, avatar), media:post_media(*), listingDetail:listing_details(*)")
    .eq("processing_status", "ready")
    .eq("is_active", true)
    .in("type", ["post", "listing"])
    .lt("id", cursorId)
    .limit(PAGE_SIZE + 1);

  query = followingIds.length
    ? query.in("user_id", visibleUserIds).order("id", { ascending: false })
    : query.order("engagement_score", { ascending: false }).order("id", { ascending: false });

  const { data: rows, error } = await query;
  if (error) throw error;

  const hasMore = (rows?.length ?? 0) > PAGE_SIZE;
  const page = (rows ?? []).slice(0, PAGE_SIZE).map((p: any) => ({
    ...p, listingDetail: Array.isArray(p.listingDetail) ? p.listingDetail[0] : p.listingDetail,
  }));

  const postIds = page.map((p: any) => p.id);
  const [likedSet, bookmarkedSet] = await Promise.all([
    getLikedIds(supabase, userId, postIds),
    getBookmarkedIds(supabase, userId, postIds),
  ]);

  const items = await Promise.all(page.map(async (p: any) => {
    const data = p.type === "listing"
      ? await formatListing(supabase, p, cdnBase, followingSet.has(p.user_id), likedSet.has(p.id), bookmarkedSet.has(p.id))
      : await formatPost(supabase, p, cdnBase, likedSet.has(p.id), bookmarkedSet.has(p.id), followingSet.has(p.user_id));
    return { type: p.type, id: `${p.type}_${p.id}`, score: null, data };
  }));

  const nextP = hasMore && page.length ? page[page.length - 1].id : undefined;

  let seed: any[] = [];
  if (!cursor.seeded) seed = await seedPeopleAndCommunities(supabase, userId, institutionId);

  return { items: [...items, ...seed], cursor: { p: nextP, seeded: true }, hasMore };
}

// ─── Trending ───────────────────────────────────────────────────────────────

async function trending(supabase: SupabaseClient, userId: number, institutionId: number | null, cursor: DiscoverCursor, cdnBase: string) {
  const cursorL = cursor.l ?? Number.MAX_SAFE_INTEGER;

  const sinceIso = new Date(Date.now() - TRENDING_WINDOW_DAYS * 86_400_000).toISOString();

  // Genuine (if coarse) trending signal: recent posts ranked by
  // engagement_score, NOT recency — the exact thing the product spec
  // said not to fake. `engagement_score` is the same column the default
  // marketplace sort already trusts.
  const { data: postRows, error: postErr } = await supabase
    .from("posts")
    .select("*, user:users!posts_user_id_foreign(id, name, username, avatar_key, avatar), media:post_media(*), listingDetail:listing_details(*)")
    .in("type", ["post", "listing"])
    .eq("is_active", true)
    .eq("processing_status", "ready")
    .gte("created_at", sinceIso)
    .order("engagement_score", { ascending: false })
    .limit(PAGE_SIZE);
  if (postErr) throw postErr;

  const normalizedPosts = (postRows ?? []).map((p: any) => ({
    ...p, listingDetail: Array.isArray(p.listingDetail) ? p.listingDetail[0] : p.listingDetail,
  }));
  const postIds = normalizedPosts.map((p: any) => p.id);
  const [likedSet, bookmarkedSet] = await Promise.all([
    getLikedIds(supabase, userId, postIds),
    getBookmarkedIds(supabase, userId, postIds),
  ]);

  const postItems = await Promise.all(normalizedPosts.map(async (p: any) => {
    const data = p.type === "listing"
      ? await formatListing(supabase, p, cdnBase, false, likedSet.has(p.id), bookmarkedSet.has(p.id))
      : await formatPost(supabase, p, cdnBase, likedSet.has(p.id), bookmarkedSet.has(p.id));
    return { type: p.type, id: `${p.type}_${p.id}`, score: p.engagement_score ?? null, data };
  }));

  // Marketplace paginates independently (relevance sort — real inventory).
  const marketData = await getMarketplaceFeed(supabase, userId, cdnBase, {
    institutionId: institutionId ?? undefined,
    cursor: cursorL < Number.MAX_SAFE_INTEGER ? btoa(String(cursorL)) : null,
    sort: "relevance",
  });
  const listingItems = marketData.listings.map((l: any) => ({
    type: "listing", id: `listing_${l.id}`, score: null, data: l,
  }));

  let seed: any[] = [];
  if (!cursor.seeded) {
    const [hashtagResult, communityItems] = await Promise.all([
      getTrending(supabase),
      getSuggestedCommunities(supabase, userId, institutionId, 3),
    ]);
    seed = [
      ...hashtagResult.hashtags.slice(0, 6).map((h: any) => ({
        type: "trending", id: `trending_${h.id}`, score: h.posts_count, data: h,
      })),
      ...communityItems.map((c) => ({ type: "community", id: `community_${c.id}`, score: null, data: c })),
    ];
  }

  const nextCursorL = marketData.next_cursor ? parseInt(atob(marketData.next_cursor), 10) : undefined;

  return {
    items: [...postItems, ...listingItems, ...seed],
    cursor: { l: nextCursorL, seeded: true },
    hasMore: marketData.has_more || postItems.length >= PAGE_SIZE,
  };
}

// ─── Nearby ─────────────────────────────────────────────────────────────────

async function nearby(
  supabase: SupabaseClient,
  userId: number,
  institutionId: number | null,
  cursor: DiscoverCursor,
  cdnBase: string,
  lat?: number,
  lng?: number,
) {
  // Real geo path — only taken when the client actually sends coordinates
  // this request. Never stored, never inferred.
  if (lat !== undefined && lng !== undefined) {
    const cursorId = cursor.n ?? Number.MAX_SAFE_INTEGER;
    const { data: geoRows, error: geoErr } = await supabase.rpc("nearby_post_ids", {
      origin_lat: lat, origin_lng: lng, radius_km: NEARBY_RADIUS_KM, max_id: cursorId, result_limit: PAGE_SIZE + 1,
    });
    if (geoErr) throw geoErr;

    const hasMore = (geoRows?.length ?? 0) > PAGE_SIZE;
    const page = (geoRows ?? []).slice(0, PAGE_SIZE);
    const ids = page.map((r: any) => r.id);
    const distanceById = new Map(page.map((r: any) => [r.id, r.distance_km]));

    if (!ids.length) {
      let seed: any[] = [];
      if (!cursor.seeded) seed = await seedPeopleAndCommunities(supabase, userId, institutionId);
      return { items: seed, cursor: { seeded: true }, hasMore: false };
    }

    const { data: postRows, error } = await supabase
      .from("posts")
      .select("*, user:users!posts_user_id_foreign(id, name, username, avatar_key, avatar), media:post_media(*), listingDetail:listing_details(*)")
      .in("id", ids)
      .eq("is_active", true)
      .eq("processing_status", "ready")
      .is("expires_at", null)
      .in("type", ["post", "listing"]);
    if (error) throw error;

    const normalized = (postRows ?? []).map((p: any) => ({
      ...p, listingDetail: Array.isArray(p.listingDetail) ? p.listingDetail[0] : p.listingDetail,
    }));
    const postIds = normalized.map((p: any) => p.id);
    const [likedSet, bookmarkedSet] = await Promise.all([
      getLikedIds(supabase, userId, postIds),
      getBookmarkedIds(supabase, userId, postIds),
    ]);

    const items = await Promise.all(normalized.map(async (p: any) => {
      const data = p.type === "listing"
        ? await formatListing(supabase, p, cdnBase, false, likedSet.has(p.id), bookmarkedSet.has(p.id))
        : await formatPost(supabase, p, cdnBase, likedSet.has(p.id), bookmarkedSet.has(p.id));
      return { type: p.type, id: `${p.type}_${p.id}`, score: distanceById.get(p.id) ?? null, data };
    }));
    // Sort by distance again — the `in (...)` fetch above doesn't preserve order.
    items.sort((a, b) => (a.score ?? 0) - (b.score ?? 0));

    let seed: any[] = [];
    if (!cursor.seeded) seed = await seedPeopleAndCommunities(supabase, userId, institutionId);

    const nextN = hasMore && page.length ? page[page.length - 1].id : undefined;
    return { items: [...items, ...seed], cursor: { n: nextN, seeded: true }, hasMore };
  }

  // Fallback: institution scope, same as the old campus-feed-backed
  // "Nearby" — kept explicit rather than silently pretending it's geo.
  const cursorId = cursor.p ?? Number.MAX_SAFE_INTEGER;
  let query = supabase
    .from("posts")
    .select("*, user:users!posts_user_id_foreign(id, name, username, avatar_key, avatar), media:post_media(*)")
    .eq("type", "post")
    .eq("processing_status", "ready")
    .eq("is_active", true)
    .lt("id", cursorId)
    .order("is_featured", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE + 1);

  if (institutionId) query = query.or(`context->>institution_id.eq.${institutionId},visibility.eq.public`);

  const { data: rows, error } = await query;
  if (error) throw error;

  const hasMore = (rows?.length ?? 0) > PAGE_SIZE;
  const page = (rows ?? []).slice(0, PAGE_SIZE);
  const postIds = page.map((p: any) => p.id);
  const likedSet = await getLikedIds(supabase, userId, postIds);

  const items = await Promise.all(page.map(async (p: any) => ({
    type: "post", id: `post_${p.id}`, score: null, data: await formatPost(supabase, p, cdnBase, likedSet.has(p.id)),
  })));

  let seed: any[] = [];
  if (!cursor.seeded) seed = await seedPeopleAndCommunities(supabase, userId, institutionId);

  const nextP = hasMore && page.length ? page[page.length - 1].id : undefined;
  return { items: [...items, ...seed], cursor: { p: nextP, seeded: true }, hasMore };
}

// ─── People ─────────────────────────────────────────────────────────────────

async function people(supabase: SupabaseClient, userId: number, institutionId: number | null, cursor: DiscoverCursor) {
  const scope = cursor.all ? null : institutionId;
  let all = !!cursor.all;
  let users = await getSuggestedPeople(supabase, userId, scope, PAGE_SIZE + 1, cursor.u);
  // Small campus? Fall back to everyone instead of an empty tab.
  if (!users.length && scope && cursor.u === undefined) {
    users = await getSuggestedPeople(supabase, userId, null, PAGE_SIZE + 1);
    all = true;
  }
  const hasMore = users.length > PAGE_SIZE;
  const page = users.slice(0, PAGE_SIZE);
  const items = page.map((u) => ({ type: "person", id: `person_${u.id}`, score: null, data: u }));
  const nextU = hasMore && page.length ? page[page.length - 1].id : undefined;
  return { items, cursor: { u: nextU, all, seeded: true } as DiscoverCursor, hasMore };
}

// ─── Marketplace ────────────────────────────────────────────────────────────

async function marketplace(supabase: SupabaseClient, userId: number, institutionId: number | null, cursor: DiscoverCursor, cdnBase: string) {
  const cursorL = cursor.l ?? Number.MAX_SAFE_INTEGER;
  const data = await getMarketplaceFeed(supabase, userId, cdnBase, {
    institutionId: institutionId ?? undefined,
    cursor: cursorL < Number.MAX_SAFE_INTEGER ? btoa(String(cursorL)) : null,
    sort: "relevance",
  });
  const items = data.listings.map((l: any) => ({ type: "listing", id: `listing_${l.id}`, score: null, data: l }));
  const nextL = data.next_cursor ? parseInt(atob(data.next_cursor), 10) : undefined;
  return { items, cursor: { l: nextL, seeded: true } as DiscoverCursor, hasMore: !!data.has_more };
}

// ─── Entry point ────────────────────────────────────────────────────────────

export async function getDiscoverFeed(
  supabase: SupabaseClient,
  userId: number,
  cdnBase: string,
  opts: { lens: DiscoverLens; cursor: string | null; lat?: number; lng?: number },
) {
  const { data: user } = await supabase.from("users").select("institution_id").eq("id", userId).single();
  const institutionId = user?.institution_id ?? null;
  const decodedCursor = decodeCursor(opts.cursor);

  const result = await (opts.lens === "people"
    ? people(supabase, userId, institutionId, decodedCursor)
    : opts.lens === "marketplace"
      ? marketplace(supabase, userId, institutionId, decodedCursor, cdnBase)
      : opts.lens === "trending"
    ? trending(supabase, userId, institutionId, decodedCursor, cdnBase)
    : opts.lens === "nearby"
      ? nearby(supabase, userId, institutionId, decodedCursor, cdnBase, opts.lat, opts.lng)
      : forYou(supabase, userId, institutionId, decodedCursor, cdnBase));

  return {
    items: diversify(result.items),
    next_cursor: result.hasMore ? encodeCursor(result.cursor) : null,
    has_more: result.hasMore,
  };
}