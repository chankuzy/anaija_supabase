import type { SupabaseClient } from "../auth.ts";
import { createNotification, notifyAggregated, TYPE_FOLLOW } from "./notificationService.ts";
import { batchAttachAudio } from "./audioAssetService.ts";
import { resolveAvatarUrl } from "../avatar.ts";
import { formatMedia } from "./feedService.ts";

const PAGE_SIZE = 20;
const FOLLOW_PAGE_SIZE = 30;
const MAX_PINNED = 3;

function avatarUrl(avatarKey: string | null | undefined): string | null {
  return resolveAvatarUrl(avatarKey);
}

// Cover photos live in the same R2 bucket as avatars — same resolver works
// unchanged (it just needs *a* key/URL, doesn't care which field it came from).
function coverUrl(coverKey: string | null | undefined, coverUrlFallback: string | null | undefined): string | null {
  return resolveAvatarUrl(coverKey ?? coverUrlFallback ?? null);
}

// ─── Profile ────────────────────────────────────────────────────────────────

export async function getProfile(supabase: SupabaseClient, username: string, viewerId: number | null, cdnBase: string) {
  const { data: profile, error } = await supabase
    .from("users")
    .select("*, institution:institutions(id, name, short_name, slug)")
    .eq("username", username)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;
  if (!profile) return { notFound: true as const };

  const isFollowing = viewerId
    ? await hasFollow(supabase, viewerId, profile.id)
    : false;

  const [
    { count: postsCount },
    { count: listingsCount },
    { count: followersCount },
    { count: followingCount },
    { count: communitiesCount },
    highlights,
  ] = await Promise.all([
    supabase.from("posts").select("*", { count: "exact", head: true }).eq("user_id", profile.id).eq("type", "post").eq("is_active", true),
    supabase.from("posts").select("*", { count: "exact", head: true }).eq("user_id", profile.id).eq("type", "listing").eq("is_active", true),
    supabase.from("follows").select("*", { count: "exact", head: true }).eq("following_id", profile.id),
    supabase.from("follows").select("*", { count: "exact", head: true }).eq("follower_id", profile.id),
    // ASSUMPTION: join table is `community_members(user_id, community_id)`,
    // inferred from the `communities-join` function name — confirm/correct.
    supabase.from("community_members").select("*", { count: "exact", head: true }).eq("user_id", profile.id),
    getUserHighlights(supabase, profile.id),
  ]);

  return {
    profile: {
      id: profile.id,
      name: profile.name,
      username: profile.username,
      bio: profile.bio,
      tagline: profile.tagline ?? null,
      avatar: avatarUrl(profile.avatar_key ?? profile.avatar),
      cover: coverUrl(profile.cover_key, profile.cover_url),
      is_verified: profile.is_verified,
      campus_verified: profile.campus_verified,
      campus_role: profile.campus_role,
      location: profile.location,
      links: profile.links ?? [],
      institution: profile.institution ? {
        id: profile.institution.id, name: profile.institution.name, short_name: profile.institution.short_name,
      } : null,
      counts: {
        posts: postsCount ?? 0,
        listings: listingsCount ?? 0,
        followers: followersCount ?? 0,
        following: followingCount ?? 0,
        communities: communitiesCount ?? 0,
      },
      highlights,
      is_following: isFollowing,
      is_own_profile: viewerId === profile.id,
    },
  };
}

async function hasFollow(supabase: SupabaseClient, followerId: number, followingId: number): Promise<boolean> {
  const { count } = await supabase.from("follows").select("*", { count: "exact", head: true })
    .eq("follower_id", followerId).eq("following_id", followingId);
  return (count ?? 0) > 0;
}

// ─── Profile content tabs ───────────────────────────────────────────────────

export async function getUserPosts(supabase: SupabaseClient, username: string, cursor: string | null) {
  const { data: profile } = await supabase.from("users").select("id").eq("username", username).eq("is_active", true).maybeSingle();
  if (!profile) return { notFound: true as const };

  const cursorId = cursor ? parseInt(atob(cursor), 10) : Number.MAX_SAFE_INTEGER;

  const SEL = "*, user:users(id, name, username, avatar_key, avatar), media:post_media(*)";

  // First page only: pinned posts lead, most recently pinned first. They are
  // excluded from the paginated list below so nothing appears twice.
  let pinned: any[] = [];
  if (!cursor) {
    const { data: pinnedRows, error: pinErr } = await supabase
      .from("posts")
      .select(SEL)
      .eq("user_id", profile.id)
      .eq("type", "post")
      .eq("processing_status", "ready")
      .eq("is_active", true)
      .not("pinned_at", "is", null)
      .order("pinned_at", { ascending: false });
    if (pinErr) throw pinErr;
    pinned = pinnedRows ?? [];
  }

  const { data: posts, error } = await supabase
    .from("posts")
    .select(SEL)
    .eq("user_id", profile.id)
    .eq("type", "post")
    .eq("processing_status", "ready")
    .eq("is_active", true)
    .is("pinned_at", null)
    .lt("id", cursorId)
    .order("id", { ascending: false })
    .limit(PAGE_SIZE + 1);

  if (error) throw error;

  const hasMore = (posts?.length ?? 0) > PAGE_SIZE;
  const page = [...pinned, ...(posts ?? []).slice(0, PAGE_SIZE)];

  await batchAttachAudio(supabase, page);

  return { page, hasMore };
}

export async function getUserListings(supabase: SupabaseClient, username: string, cursor: string | null) {
  const { data: profile } = await supabase.from("users").select("id").eq("username", username).eq("is_active", true).maybeSingle();
  if (!profile) return { notFound: true as const };

  const cursorId = cursor ? parseInt(atob(cursor), 10) : Number.MAX_SAFE_INTEGER;

  const { data: listings, error } = await supabase
    .from("posts")
    .select("*, user:users(id, name, username, avatar_key, avatar), media:post_media(*), listingDetail:listing_details(*)")
    .eq("user_id", profile.id)
    .eq("type", "listing")
    .eq("is_active", true)
    .lt("id", cursorId)
    .order("id", { ascending: false })
    .limit(PAGE_SIZE + 1);

  if (error) throw error;

  const hasMore = (listings?.length ?? 0) > PAGE_SIZE;
  const page = (listings ?? []).map((p: any) => ({ ...p, listingDetail: p.listingDetail?.[0] ?? p.listingDetail })).slice(0, PAGE_SIZE);

  await batchAttachAudio(supabase, page);
  return { page, hasMore };
}

export async function getUserStories(supabase: SupabaseClient, username: string, viewerId: number) {
  const { data: profile } = await supabase.from("users").select("id").eq("username", username).eq("is_active", true).maybeSingle();
  if (!profile) return { notFound: true as const };

  const { data: stories, error } = await supabase
    .from("posts")
    .select("*, media:post_media(*), storyViews:story_views(user_id)")
    .eq("user_id", profile.id)
    .eq("type", "story")
    .eq("is_active", true)
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false });

  if (error) throw error;

  const withViews = (stories ?? []).map((s: any) => ({
    ...s,
    storyViews: (s.storyViews ?? []).filter((v: any) => v.user_id === viewerId),
  }));

  await batchAttachAudio(supabase, withViews);
  return { stories: withViews };
}

/// Posts this user has liked. Private by design (own-only) — the caller
/// (posts-liked/index.ts) should reject viewerId !== the profile owner
/// before calling this, same as bookmarks.
export async function getUserLikedPosts(supabase: SupabaseClient, userId: number, cursor: string | null) {
  const cursorId = cursor ? parseInt(atob(cursor), 10) : Number.MAX_SAFE_INTEGER;

  const { data: likeRows, error } = await supabase
    .from("post_likes")
    .select("post_id, created_at, post:posts(*, user:users(id, name, username, avatar_key, avatar), media:post_media(*), listingDetail:listing_details(*))")
    .eq("user_id", userId)
    .lt("post_id", cursorId)
    .order("post_id", { ascending: false })
    .limit(PAGE_SIZE + 1);

  if (error) throw error;

  const hasMore = (likeRows?.length ?? 0) > PAGE_SIZE;
  const page = (likeRows ?? [])
    .slice(0, PAGE_SIZE)
    .map((r: any) => ({ ...r.post, listingDetail: r.post?.listingDetail?.[0] ?? r.post?.listingDetail }))
    .filter((p: any) => p && p.is_active && p.type !== "story");

  await batchAttachAudio(supabase, page);
  return { page, hasMore };
}

// ─── Pinned posts ─────────────────────────────────────────────────────────

export async function togglePinned(supabase: SupabaseClient, postId: number, userId: number) {
  const { data: post, error } = await supabase.from("posts").select("id, user_id, pinned_at").eq("id", postId).maybeSingle();
  if (error) throw error;
  if (!post) return { notFound: true as const };
  if (post.user_id !== userId) return { unauthorized: true as const };

  if (post.pinned_at) {
    await supabase.from("posts").update({ pinned_at: null }).eq("id", postId);
    return { pinned: false };
  }

  const { count } = await supabase.from("posts").select("*", { count: "exact", head: true })
    .eq("user_id", userId).not("pinned_at", "is", null);
  if ((count ?? 0) >= MAX_PINNED) return { limitReached: true as const, max: MAX_PINNED };

  await supabase.from("posts").update({ pinned_at: new Date().toISOString() }).eq("id", postId);
  return { pinned: true };
}

// ─── Highlights ─────────────────────────────────────────────────────────────

// First usable cover for a highlight without its own cover_url: the first
// active post (by sort_order); image -> its image, video -> its thumbnail.
// URLs go through formatMedia so they match what feeds return.
async function firstPostCover(supabase: SupabaseClient, rows: any[]): Promise<string | null> {
  const byOrder = (a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0);
  for (const row of [...rows].sort(byOrder)) {
    const post = row.post;
    if (!post || !post.is_active) continue;
    const first = [...(post.media ?? [])].sort(byOrder)[0];
    if (!first) continue;
    const m = await formatMedia(supabase, first);
    const url = m.type === "video"
      ? (m.thumbnail ?? resolveAvatarUrl(post.thumbnail_key))
      : (m.url ?? m.thumbnail);
    if (url) return url;
  }
  return null;
}

export async function getUserHighlights(supabase: SupabaseClient, userId: number) {
  // One query: highlights + first 5 posts each (ordered) + their media.
  // `foreignTable` is the supabase-js v2 name for embedded order/limit.
  const { data, error } = await supabase
    .from("user_highlights")
    .select(`
      id, title, icon_key, cover_url, sort_order,
      user_highlight_posts(
        sort_order,
        post:posts(
          id, is_active, thumbnail_key,
          media:post_media(media_type, storage_key, thumbnail_key, sort_order)
        )
      )
    `)
    .eq("user_id", userId)
    .order("sort_order", { ascending: true })
    .order("sort_order", { foreignTable: "user_highlight_posts", ascending: true })
    .limit(5, { foreignTable: "user_highlight_posts" });

  if (error) throw error;

  const out = [];
  for (const h of (data ?? []) as any[]) {
    out.push({
      id: h.id,
      title: h.title,
      icon_key: h.icon_key,
      cover_url: h.cover_url || (await firstPostCover(supabase, h.user_highlight_posts ?? [])),
    });
  }
  return out;
}

export async function createHighlight(supabase: SupabaseClient, userId: number, title: string, coverUrl: string | null) {
  if (!title.trim()) throw new Error("Title is required.");

  const { count } = await supabase.from("user_highlights").select("*", { count: "exact", head: true }).eq("user_id", userId);

  const { data, error } = await supabase
    .from("user_highlights")
    .insert({ user_id: userId, title: title.trim(), cover_url: coverUrl, sort_order: count ?? 0 })
    .select("id, title, icon_key, cover_url")
    .single();

  if (error) throw error;
  return data;
}

export async function addPostToHighlight(
  supabase: SupabaseClient,
  userId: number,
  highlightId: number,
  postId: number,
) {
  const { data: highlight } = await supabase
    .from("user_highlights").select("id, user_id").eq("id", highlightId).maybeSingle();
  if (!highlight) return { notFound: true as const };
  if (highlight.user_id !== userId) return { unauthorized: true as const };

  const { data: post } = await supabase.from("posts").select("id, user_id").eq("id", postId).maybeSingle();
  if (!post) return { postNotFound: true as const };
  if (post.user_id !== userId) return { unauthorized: true as const };

  const { count } = await supabase.from("user_highlight_posts")
    .select("*", { count: "exact", head: true }).eq("highlight_id", highlightId);

  const { error } = await supabase.from("user_highlight_posts")
    .upsert(
      { highlight_id: highlightId, post_id: postId, sort_order: count ?? 0 },
      { onConflict: "highlight_id,post_id" },
    );
  if (error) throw error;

  return { ok: true as const };
}

export async function removePostFromHighlight(
  supabase: SupabaseClient,
  userId: number,
  highlightId: number,

  postId: number,
) {
  const { data: highlight } = await supabase
    .from("user_highlights").select("id, user_id").eq("id", highlightId).maybeSingle();
  if (!highlight) return { notFound: true as const };
  if (highlight.user_id !== userId) return { unauthorized: true as const };

  await supabase.from("user_highlight_posts").delete()
    .eq("highlight_id", highlightId).eq("post_id", postId);

  return { ok: true as const };
}

/// Returns full post rows (not just ids) so the manage screen can render
/// them directly with ProfileMasonryGrid — same shape getUserPosts already
/// returns, just filtered through the join table instead of user_id.
export async function getHighlightPosts(supabase: SupabaseClient, highlightId: number) {
  const { data, error } = await supabase
    .from("user_highlight_posts")
    .select(`
      sort_order,
      post:posts(*, user:users(id, name, username, avatar_key, avatar), media:post_media(*), listingDetail:listing_details(*))
    `)
    .eq("highlight_id", highlightId)
    .order("sort_order", { ascending: true });

  if (error) throw error;

  return (data ?? [])
    .map((r: any) => ({ ...r.post, listingDetail: r.post?.listingDetail?.[0] ?? r.post?.listingDetail }))
    .filter((p: any) => p && p.is_active);
}

// ─── Follow ─────────────────────────────────────────────────────────────────

export async function toggleFollow(supabase: SupabaseClient, followerId: number, followerName: string, targetUserId: number) {
  if (followerId === targetUserId) return { selfFollow: true as const };

  const { data: target } = await supabase.from("users").select("id").eq("id", targetUserId).maybeSingle();
  if (!target) return { notFound: true as const };

  const { data: existing } = await supabase
    .from("follows").select("*").eq("follower_id", followerId).eq("following_id", targetUserId).maybeSingle();

  if (existing) {
    await supabase.from("follows").delete().eq("follower_id", followerId).eq("following_id", targetUserId);
    return { following: false };
  }

  await supabase.from("follows").insert({ follower_id: followerId, following_id: targetUserId });

  await notifyAggregated(supabase, {
    userId: targetUserId, actorId: followerId, actorName: followerName,
    type: TYPE_FOLLOW, notifiableType: null, notifiableId: null,
    singular: "started following you.",
    plural: (n) => `and ${n} other${n === 1 ? "" : "s"} started following you.`,
  });

  return { following: true };
}

// ─── Followers / Following lists ────────────────────────────────────────────

async function followingSetFor(supabase: SupabaseClient, viewerId: number | null, candidateIds: number[]): Promise<Set<number>> {
  if (!viewerId || !candidateIds.length) return new Set();
  const { data } = await supabase.from("follows").select("following_id")
    .eq("follower_id", viewerId).in("following_id", candidateIds);
  return new Set((data ?? []).map((r: any) => r.following_id));
}

function formatFollowUser(u: any, followingSet: Set<number>) {
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    avatar: avatarUrl(u.avatar_key ?? u.avatar),
    is_verified: u.is_verified,
    is_following: followingSet.has(u.id),
  };
}

export async function getFollowers(supabase: SupabaseClient, username: string, viewerId: number | null, page: number, cdnBase: string) {
  const { data: profile } = await supabase.from("users").select("id").eq("username", username).maybeSingle();
  if (!profile) return { notFound: true as const };

  const from = (page - 1) * FOLLOW_PAGE_SIZE;
  const { data: rows, error } = await supabase
    .from("follows")
    .select("follower_id, follower:users!follows_follower_id_foreign(id, name, username, avatar, avatar_key, is_verified)")
    .eq("following_id", profile.id)
    .order("follower_id", { ascending: false })
    .range(from, from + FOLLOW_PAGE_SIZE);

  if (error) throw error;

  const hasMore = (rows?.length ?? 0) > FOLLOW_PAGE_SIZE;
  const page_ = (rows ?? []).slice(0, FOLLOW_PAGE_SIZE).map((r: any) => r.follower);
  const followingSet = await followingSetFor(supabase, viewerId, page_.map((u: any) => u.id));

  return { data: page_.map((u: any) => formatFollowUser(u, followingSet)), hasMore };
}

export async function getFollowing(supabase: SupabaseClient, username: string, viewerId: number | null, page: number, cdnBase: string) {
  const { data: profile } = await supabase.from("users").select("id").eq("username", username).maybeSingle();
  if (!profile) return { notFound: true as const };

  const from = (page - 1) * FOLLOW_PAGE_SIZE;
  const { data: rows, error } = await supabase
    .from("follows")
    .select("following_id, followee:users!follows_following_id_foreign(id, name, username, avatar, avatar_key, is_verified)")
    .eq("follower_id", profile.id)
    .order("following_id", { ascending: false })
    .range(from, from + FOLLOW_PAGE_SIZE);

  if (error) throw error;

  const hasMore = (rows?.length ?? 0) > FOLLOW_PAGE_SIZE;
  const page_ = (rows ?? []).slice(0, FOLLOW_PAGE_SIZE).map((r: any) => r.followee);
  const followingSet = await followingSetFor(supabase, viewerId, page_.map((u: any) => u.id));

  return { data: page_.map((u: any) => formatFollowUser(u, followingSet)), hasMore };
}