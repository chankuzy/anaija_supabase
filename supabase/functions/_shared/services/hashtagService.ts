import type { SupabaseClient } from "../auth.ts";
import { formatPost, formatListing } from "./feedService.ts";

const PAGE_SIZE = 20;

function normalizeTag(raw: string): string {
  return raw.toLowerCase().replace(/^#/, "");
}

// Called from createPost — upserts each hashtag and bumps its posts_count.
// This is what makes /hashtags/trending meaningful; without it every new
// post's tags would be invisible to the trending list even though the tags
// themselves are already searchable via the posts.hashtags JSON column.
export async function syncHashtags(supabase: SupabaseClient, tags: string[]) {
  for (const raw of tags) {
    const tag = normalizeTag(raw);
    if (!tag) continue;

    const { data: existing } = await supabase.from("hashtags").select("id, posts_count").eq("tag", tag).maybeSingle();

    if (existing) {
      await supabase.from("hashtags").update({ posts_count: (existing.posts_count ?? 0) + 1 }).eq("id", existing.id);
    } else {
      await supabase.from("hashtags").insert({ tag, posts_count: 1 });
    }
  }
}

export async function getTrending(supabase: SupabaseClient) {
  const { data, error } = await supabase
    .from("hashtags").select("id, tag, posts_count")
    .gt("posts_count", 0)
    .order("posts_count", { ascending: false })
    .limit(20);

  if (error) throw error;
  return { hashtags: data ?? [] };
}

// Queries posts.hashtags (jsonb array) directly via the @> containment
// operator — no dependency on the post_hashtags pivot table.
export async function getPostsForTag(supabase: SupabaseClient, rawTag: string, userId: number, cursor: string | null, cdnBase: string) {
  const tag = normalizeTag(rawTag);
  const cursorId = cursor ? parseInt(atob(cursor), 10) : Number.MAX_SAFE_INTEGER;

  const { data: hashtagRow } = await supabase.from("hashtags").select("posts_count").eq("tag", tag).maybeSingle();

  // Fetch candidates and filter by hashtag membership in JS — avoids
  // PostgREST's limited support for filtering plain `json` columns.
  const { data: rows, error } = await supabase
    .from("posts")
    .select("*, user:users!posts_user_id_foreign(id, name, username, avatar_key), media:post_media(*)")
    .eq("type", "post")
    .eq("processing_status", "ready")
    .eq("is_active", true)
    .lt("id", cursorId)
    .order("engagement_score", { ascending: false })
    .order("id", { ascending: false })
    .limit(200); // candidate pool — filtered down below

  if (error) throw error;

  const matching = (rows ?? []).filter((p: any) => Array.isArray(p.hashtags) && p.hashtags.map((h: string) => h.toLowerCase()).includes(tag));

  const hasMore = matching.length > PAGE_SIZE;
  const page = matching.slice(0, PAGE_SIZE);

  const { data: liked } = await supabase.from("post_likes").select("post_id").eq("user_id", userId).in("post_id", page.map((p: any) => p.id));
  const likedSet = new Set((liked ?? []).map((r: any) => r.post_id));

  const posts = await Promise.all(page.map((p: any) => formatPost(supabase, p, cdnBase, likedSet.has(p.id))));

  return {
    tag,
    posts_count: hashtagRow?.posts_count ?? 0,
    data: posts,
    next_cursor: hasMore ? btoa(String(page[page.length - 1].id)) : null,
    has_more: hasMore,
  };
}

export async function getListingsForTag(supabase: SupabaseClient, rawTag: string, cursor: string | null, cdnBase: string) {
  const tag = normalizeTag(rawTag);
  const cursorId = cursor ? parseInt(atob(cursor), 10) : Number.MAX_SAFE_INTEGER;

  const { data: rows, error } = await supabase
    .from("posts")
    .select("*, user:users!posts_user_id_foreign(id, name, username, avatar_key), media:post_media(*), listingDetail:listing_details!inner(*)")
    .eq("type", "listing")
    .eq("is_active", true)
    .eq("listingDetail.status", "available")
    .lt("id", cursorId)
    .order("id", { ascending: false })
    .limit(200);

  if (error) throw error;

  const matching = (rows ?? [])
    .filter((p: any) => Array.isArray(p.hashtags) && p.hashtags.map((h: string) => h.toLowerCase()).includes(tag))
    .map((p: any) => ({ ...p, listingDetail: Array.isArray(p.listingDetail) ? p.listingDetail[0] : p.listingDetail }));

  const hasMore = matching.length > PAGE_SIZE;
  const page = matching.slice(0, PAGE_SIZE);

  const listings = await Promise.all(page.map((p: any) => formatListing(supabase, p, cdnBase)));

  return {
    data: listings,
    next_cursor: hasMore ? btoa(String(page[page.length - 1].id)) : null,
    has_more: hasMore,
  };
}