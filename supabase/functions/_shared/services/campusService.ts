import type { SupabaseClient } from "../auth.ts";
import { formatPost, batchAttachReposted } from "./feedService.ts";
import { batchAttachAudio } from "./audioAssetService.ts";

const PAGE_SIZE = 20;

export async function getCampusFeed(supabase: SupabaseClient, institutionId: number | null, userId: number, subtype: string | null, cursor: string | null, cdnBase: string) {
  if (!institutionId) return { posts: [], has_more: false, message: "No institution linked to your account." };

  const cursorId = cursor ? parseInt(atob(cursor), 10) : Number.MAX_SAFE_INTEGER;

  let query = supabase
    .from("posts")
    .select("*, user:users!posts_user_id_foreign(id, name, username, avatar_key), media:post_media(*)")
    .eq("type", "post")
    .eq("processing_status", "ready")
    .eq("is_active", true)
    .lt("id", cursorId)
    .or(`context->>institution_id.eq.${institutionId},visibility.eq.public`)
    .order("is_featured", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE + 1);

  if (subtype) query = query.eq("subtype", subtype);

  const { data: rows, error } = await query;
  if (error) throw error;

  const hasMore = (rows?.length ?? 0) > PAGE_SIZE;
  const page = (rows ?? []).slice(0, PAGE_SIZE);

  await batchAttachAudio(supabase, page);
  await batchAttachReposted(supabase, userId, page);
  const { data: liked } = await supabase.from("post_likes").select("post_id").eq("user_id", userId).in("post_id", page.map((p: any) => p.id));
  const likedSet = new Set((liked ?? []).map((r: any) => r.post_id));

  // Which of these authors does the viewer follow? Without this every author
  // came back is_following=false, so followed users showed a Follow button.
  const authorIds = [...new Set(page.map((p: any) => p.user?.id ?? p.user_id).filter(Boolean))];
  const followingSet = new Set<number>();
  if (authorIds.length > 0) {
    const { data: follows } = await supabase
      .from("follows")
      .select("following_id")
      .eq("follower_id", userId)
      .in("following_id", authorIds);
    for (const f of follows ?? []) followingSet.add(f.following_id);
  }

  const posts = await Promise.all(
    page.map((p: any) =>
      formatPost(supabase, p, cdnBase, likedSet.has(p.id), false, followingSet.has(p.user?.id ?? p.user_id)),
    ),
  );

  return {
    posts,
    next_cursor: hasMore ? btoa(String(page[page.length - 1].id)) : null,
    has_more: hasMore,
  };
}

export async function getEvents(supabase: SupabaseClient, institutionId: number | null, cdnBase: string) {
  let query = supabase
    .from("posts")
    .select("*, user:users!posts_user_id_foreign(id, name, username, avatar_key), media:post_media(*)")
    .eq("type", "post")
    .eq("subtype", "event")
    .eq("processing_status", "ready")
    .eq("is_active", true)
    .order("is_featured", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);

  query = institutionId
    ? query.or(`context->>institution_id.eq.${institutionId},visibility.eq.public`)
    : query.eq("visibility", "public");

  const { data, error } = await query;
  if (error) throw error;

  await batchAttachAudio(supabase, data ?? []);
  const posts = await Promise.all((data ?? []).map((p: any) => formatPost(supabase, p, cdnBase)));
  return { data: posts };
}

export async function getAnnouncements(supabase: SupabaseClient, institutionId: number | null, cdnBase: string) {
  let query = supabase
    .from("posts")
    .select("*, user:users!posts_user_id_foreign(id, name, username, avatar_key), media:post_media(*)")
    .eq("type", "post")
    .eq("subtype", "announcement")
    .eq("processing_status", "ready")
    .eq("is_active", true)
    .order("is_featured", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);

  if (institutionId) query = query.eq("context->>institution_id", String(institutionId));

  const { data, error } = await query;
  if (error) throw error;

  await batchAttachAudio(supabase, data ?? []);
  const posts = await Promise.all((data ?? []).map((p: any) => formatPost(supabase, p, cdnBase)));
  return { data: posts };
}

export async function listInstitutions(supabase: SupabaseClient, search: string | null, page: number) {
  const from = (page - 1) * 30;

  let query = supabase.from("institutions").select("*").eq("is_active", true).order("name").range(from, from + 30);

  if (search) query = query.or(`name.ilike.%${search}%,short_name.ilike.%${search}%`);

  const { data, error } = await query;
  if (error) throw error;

  const hasMore = (data?.length ?? 0) > 30;
  return { data: (data ?? []).slice(0, 30), has_more: hasMore };
}

export async function joinInstitution(supabase: SupabaseClient, userId: number, institutionId: number, faculty: string | null, level: string | null, campusRole: string) {
  const { data: inst } = await supabase.from("institutions").select("id").eq("id", institutionId).maybeSingle();
  if (!inst) return { notFound: true as const };

  await supabase.from("users").update({
    institution_id: institutionId, faculty, level, campus_role: campusRole,
  }).eq("id", userId);

  return { ok: true as const };
}