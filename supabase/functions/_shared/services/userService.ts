import type { SupabaseClient } from "../auth.ts";
import { createNotification, TYPE_FOLLOW } from "./notificationService.ts";

const PAGE_SIZE = 20;
const FOLLOW_PAGE_SIZE = 30;

const STORAGE_BUCKET = Deno.env.get("STORAGE_BUCKET") ?? "media";

async function avatarUrl(supabase: SupabaseClient, avatarKey: string | null): Promise<string | null> {
  if (!avatarKey) return null;
  if (avatarKey.startsWith("http")) return avatarKey;
  const { data } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(avatarKey, 3600);
  return data?.signedUrl ?? null;
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

  const [{ count: postsCount }, { count: listingsCount }, { count: followersCount }, { count: followingCount }] = await Promise.all([
    supabase.from("posts").select("*", { count: "exact", head: true }).eq("user_id", profile.id).eq("type", "post").eq("is_active", true),
    supabase.from("posts").select("*", { count: "exact", head: true }).eq("user_id", profile.id).eq("type", "listing").eq("is_active", true),
    supabase.from("follows").select("*", { count: "exact", head: true }).eq("following_id", profile.id),
    supabase.from("follows").select("*", { count: "exact", head: true }).eq("follower_id", profile.id),
  ]);

  return {
    profile: {
      id: profile.id,
      name: profile.name,
      username: profile.username,
      bio: profile.bio,
      avatar: await avatarUrl(supabase, profile.avatar_key ?? profile.avatar),
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
      },
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

  const { data: posts, error } = await supabase
    .from("posts")
    .select("*, user:users(id, name, username, avatar_key), media:post_media(*)")
    .eq("user_id", profile.id)
    .eq("type", "post")
    .eq("processing_status", "ready")
    .eq("is_active", true)
    .lt("id", cursorId)
    .order("id", { ascending: false })
    .limit(PAGE_SIZE + 1);

  if (error) throw error;

  const hasMore = (posts?.length ?? 0) > PAGE_SIZE;
  const page = (posts ?? []).slice(0, PAGE_SIZE);

  return { page, hasMore };
}

export async function getUserListings(supabase: SupabaseClient, username: string, cursor: string | null) {
  const { data: profile } = await supabase.from("users").select("id").eq("username", username).eq("is_active", true).maybeSingle();
  if (!profile) return { notFound: true as const };

  const cursorId = cursor ? parseInt(atob(cursor), 10) : Number.MAX_SAFE_INTEGER;

  const { data: listings, error } = await supabase
    .from("posts")
    .select("*, user:users(id, name, username, avatar_key), media:post_media(*), listingDetail:listing_details(*)")
    .eq("user_id", profile.id)
    .eq("type", "listing")
    .eq("is_active", true)
    .lt("id", cursorId)
    .order("id", { ascending: false })
    .limit(PAGE_SIZE + 1);

  if (error) throw error;

  const hasMore = (listings?.length ?? 0) > PAGE_SIZE;
  const page = (listings ?? []).map((p: any) => ({ ...p, listingDetail: p.listingDetail?.[0] ?? p.listingDetail })).slice(0, PAGE_SIZE);

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

  return { stories: withViews };
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

  await createNotification(supabase, {
    userId: targetUserId, actorId: followerId, type: TYPE_FOLLOW,
    body: `${followerName} started following you.`,
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

async function formatFollowUser(supabase: SupabaseClient, u: any, followingSet: Set<number>, cdnBase: string) {
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    avatar: await avatarUrl(supabase, u.avatar_key ?? u.avatar),
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
    .range(from, from + FOLLOW_PAGE_SIZE); // +1 row to detect has_more

  if (error) throw error;

  const hasMore = (rows?.length ?? 0) > FOLLOW_PAGE_SIZE;
  const page_ = (rows ?? []).slice(0, FOLLOW_PAGE_SIZE).map((r: any) => r.follower);
  const followingSet = await followingSetFor(supabase, viewerId, page_.map((u: any) => u.id));

  return { data: await Promise.all(page_.map((u: any) => formatFollowUser(supabase, u, followingSet, cdnBase))), hasMore };
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

  return { data: await Promise.all(page_.map((u: any) => formatFollowUser(supabase, u, followingSet, cdnBase))), hasMore };
}