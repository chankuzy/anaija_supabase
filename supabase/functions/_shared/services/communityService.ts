// supabase/functions/_shared/services/communityService.ts
import type { SupabaseClient } from "../auth.ts";
import { resolveAvatarUrl } from "../avatar.ts";
import { formatPost } from "./feedService.ts";
import { batchAttachAudio } from "./audioAssetService.ts";

const PAGE_SIZE = 20;

async function isMember(supabase: SupabaseClient, communityId: number, userId: number | null): Promise<boolean> {
  if (!userId) return false;
  const { count } = await supabase
    .from("community_members")
    .select("*", { count: "exact", head: true })
    .eq("community_id", communityId)
    .eq("user_id", userId);
  return (count ?? 0) > 0;
}

export async function formatCommunity(supabase: SupabaseClient, c: any, viewerId: number | null) {
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    description: c.description,
    avatar: resolveAvatarUrl(c.avatar_key),
    institution_id: c.institution_id,
    members_count: c.members_count ?? 0,
    posts_count: c.posts_count ?? 0,
    is_member: await isMember(supabase, c.id, viewerId),
  };
}

// ─── List (search + discovery fold-in share this) ──────────────────────────

export async function listCommunities(
  supabase: SupabaseClient,
  opts: { viewerId: number | null; institutionId?: number | null; search?: string | null; page?: number },
) {
  const page = opts.page ?? 1;
  const from = (page - 1) * PAGE_SIZE;

  let query = supabase.from("communities").select("*").eq("is_active", true);

  if (opts.search) query = query.ilike("name", `%${opts.search}%`);
  if (opts.institutionId) query = query.eq("institution_id", opts.institutionId);

  const { data, error } = await query
    .order("members_count", { ascending: false })
    .order("id", { ascending: false })
    .range(from, from + PAGE_SIZE);

  if (error) throw error;

  const hasMore = (data?.length ?? 0) > PAGE_SIZE;
  const page_ = (data ?? []).slice(0, PAGE_SIZE);
  const formatted = await Promise.all(page_.map((c: any) => formatCommunity(supabase, c, opts.viewerId)));

  return { data: formatted, has_more: hasMore };
}

/// Used only by the Discover fold-in — small set of communities the viewer
/// hasn't joined yet, biased to their institution. Not a ranking model,
/// just "haven't joined + popular", same honesty level as getSuggestedPeople.
export async function getSuggestedCommunities(
  supabase: SupabaseClient,
  viewerId: number,
  institutionId: number | null,
  limit: number,
) {
  const { data: memberships } = await supabase
    .from("community_members").select("community_id").eq("user_id", viewerId);
  const joinedIds = (memberships ?? []).map((m: any) => m.community_id);

  let query = supabase.from("communities").select("*").eq("is_active", true);
  if (joinedIds.length) query = query.not("id", "in", `(${joinedIds.join(",")})`);
  if (institutionId) query = query.eq("institution_id", institutionId);

  const { data, error } = await query
    .order("members_count", { ascending: false })
    .limit(limit);
  if (error) throw error;

  return Promise.all((data ?? []).map((c: any) => formatCommunity(supabase, c, viewerId)));
}

// ─── Show ─────────────────────────────────────────────────────────────────

export async function getCommunity(supabase: SupabaseClient, slugOrId: string, viewerId: number | null) {
  const isNumeric = /^\d+$/.test(slugOrId);
  const { data: c, error } = await supabase
    .from("communities")
    .select("*")
    .eq(isNumeric ? "id" : "slug", isNumeric ? Number(slugOrId) : slugOrId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;
  if (!c) return { notFound: true as const };

  return { community: await formatCommunity(supabase, c, viewerId) };
}

// ─── Join / leave ───────────────────────────────────────────────────────────

export async function toggleMembership(supabase: SupabaseClient, communityId: number, userId: number) {
  const { data: community } = await supabase
    .from("communities").select("id, members_count").eq("id", communityId).eq("is_active", true).maybeSingle();
  if (!community) return { notFound: true as const };

  const { data: existing } = await supabase
    .from("community_members").select("*").eq("community_id", communityId).eq("user_id", userId).maybeSingle();

  if (existing) {
    await supabase.from("community_members").delete().eq("community_id", communityId).eq("user_id", userId);
    const newCount = Math.max(0, (community.members_count ?? 1) - 1);
    await supabase.from("communities").update({ members_count: newCount }).eq("id", communityId);
    return { is_member: false, members_count: newCount };
  }

  await supabase.from("community_members").insert({ community_id: communityId, user_id: userId, role: "member" });
  const newCount = (community.members_count ?? 0) + 1;
  await supabase.from("communities").update({ members_count: newCount }).eq("id", communityId);
  return { is_member: true, members_count: newCount };
}

// ─── Community posts feed ──────────────────────────────────────────────────

export async function getCommunityPosts(
  supabase: SupabaseClient,
  communityId: number,
  userId: number,
  cursor: string | null,
  cdnBase: string,
) {
  const cursorId = cursor ? parseInt(atob(cursor), 10) : Number.MAX_SAFE_INTEGER;

  const { data: rows, error } = await supabase
    .from("posts")
    .select("*, user:users(id, name, username, avatar_key, avatar), media:post_media(*)")
    .eq("community_id", communityId)
    .in("type", ["post", "listing"])
    .eq("is_active", true)
    .eq("processing_status", "ready")
    .lt("id", cursorId)
    .order("id", { ascending: false })
    .limit(PAGE_SIZE + 1);

  if (error) throw error;

  const hasMore = (rows?.length ?? 0) > PAGE_SIZE;
  const page = (rows ?? []).slice(0, PAGE_SIZE);
  await batchAttachAudio(supabase, page);

  const { data: liked } = await supabase
    .from("post_likes").select("post_id").eq("user_id", userId).in("post_id", page.map((p: any) => p.id));
  const likedSet = new Set((liked ?? []).map((r: any) => r.post_id));

  const posts = await Promise.all(page.map((p: any) => formatPost(supabase, p, cdnBase, likedSet.has(p.id))));

  return {
    posts,
    next_cursor: hasMore && page.length ? btoa(String(page[page.length - 1].id)) : null,
    has_more: hasMore,
  };
}