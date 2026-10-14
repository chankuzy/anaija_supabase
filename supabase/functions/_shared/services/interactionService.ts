import type { SupabaseClient } from "../auth.ts";

const APP_URL = Deno.env.get("APP_URL") ?? "https://anaija.app";

// ─── Like ─────────────────────────────────────────────────────────────────

export async function toggleLike(supabase: SupabaseClient, userId: number, postId: number, actorName: string) {
  const { data: post, error: postErr } = await supabase
    .from("posts").select("id, user_id, type, likes_count").eq("id", postId).maybeSingle();
  if (postErr) throw postErr;
  if (!post) return { notFound: true as const };

  const { data: existing, error } = await supabase
    .from("post_likes").select("id").eq("user_id", userId).eq("post_id", postId).maybeSingle();
  if (error) throw error;

  if (existing) {
    await supabase.from("post_likes").delete().eq("id", existing.id);
    const newCount = Math.max(0, (post.likes_count ?? 1) - 1);
    await supabase.from("posts").update({ likes_count: newCount }).eq("id", postId);
    return { liked: false, likes_count: newCount };
  }

  await supabase.from("post_likes").insert({ user_id: userId, post_id: postId });
  const newCount = (post.likes_count ?? 0) + 1;
  await supabase.from("posts").update({ likes_count: newCount }).eq("id", postId);

  return { liked: true, likes_count: newCount };
}

// ─── Bookmark ─────────────────────────────────────────────────────────────

export async function toggleBookmark(supabase: SupabaseClient, userId: number, postId: number) {
  const { data: post, error: postErr } = await supabase
    .from("posts").select("id, bookmarks_count").eq("id", postId).maybeSingle();
  if (postErr) throw postErr;
  if (!post) return { notFound: true as const };

  const { data: existing, error } = await supabase
    .from("bookmarks").select("id").eq("user_id", userId).eq("post_id", postId).maybeSingle();
  if (error) throw error;

  if (existing) {
    await supabase.from("bookmarks").delete().eq("id", existing.id);
    const newCount = Math.max(0, (post.bookmarks_count ?? 1) - 1);
    await supabase.from("posts").update({ bookmarks_count: newCount }).eq("id", postId);
    return { bookmarked: false, bookmarks_count: newCount };
  }

  await supabase.from("bookmarks").insert({ user_id: userId, post_id: postId });
  const newCount = (post.bookmarks_count ?? 0) + 1;
  await supabase.from("posts").update({ bookmarks_count: newCount }).eq("id", postId);
  return { bookmarked: true, bookmarks_count: newCount };
}

export async function listBookmarks(supabase: SupabaseClient, userId: number, type: string | null, page: number, perPage = 20) {
  const from = (page - 1) * perPage;
  const to = from + perPage; // fetch one extra row to determine has_more

  const { data, error } = await supabase
    .from("bookmarks")
    .select("created_at, post:posts(*, user:users!posts_user_id_foreign(id, name, username, avatar_key), media:post_media(*))")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) throw error;

  const rows = (data ?? []).filter((b: any) => b.post?.is_active && b.post.type !== "story" && (!type || b.post.type === type));
  const hasMore = rows.length > perPage;

  return { rows: rows.slice(0, perPage), hasMore };
}

// ─── View ─────────────────────────────────────────────────────────────────
// Dedup via post_views' unique(post_id, user_id) — see note in chat re: this
// being a permanent dedup vs the original 24h-reset Redis window.

export async function recordView(supabase: SupabaseClient, userId: number, postId: number): Promise<boolean> {
  const { data: post, error: postErr } = await supabase
    .from("posts").select("id, is_active, processing_status, type, views_count").eq("id", postId).maybeSingle();
  if (postErr) throw postErr;
  if (!post || !post.is_active || post.processing_status !== "ready") return false;

  const { error: insertErr } = await supabase.from("post_views").insert({ post_id: postId, user_id: userId });
  if (insertErr) {
    if ((insertErr as any).code === "23505") return false; // already viewed — not an error
    throw insertErr;
  }

  await supabase.from("posts").update({ views_count: (post.views_count ?? 0) + 1 }).eq("id", postId);

  if (post.type === "listing") {
    const { data: detail } = await supabase.from("listing_details").select("views_count").eq("post_id", postId).maybeSingle();
    if (detail) {
      await supabase.from("listing_details").update({ views_count: (detail.views_count ?? 0) + 1 }).eq("post_id", postId);
    }
  }

  return true;
}

// ─── Share ────────────────────────────────────────────────────────────────
// No hourly dedup (no Redis) — every tap counts. See note in chat.

export async function recordShare(supabase: SupabaseClient, postId: number) {
  const { data: post, error } = await supabase
    .from("posts").select("id, type, is_active, shares_count").eq("id", postId).maybeSingle();
  if (error) throw error;
  if (!post || !post.is_active) return { notFound: true as const };

  if (post.type === "story") {
    return { shares_count: post.shares_count, share_url: null };
  }

  const newCount = (post.shares_count ?? 0) + 1;
  await supabase.from("posts").update({ shares_count: newCount }).eq("id", postId);

  const shareUrl = post.type === "listing" ? `${APP_URL}/marketplace/${postId}` : `${APP_URL}/posts/${postId}`;

  return { shares_count: newCount, share_url: shareUrl };
}

// ─── Repost ───────────────────────────────────────────────────────────────

export async function toggleRepost(supabase: SupabaseClient, userId: number, postId: number, actorName: string, quote?: string) {
  const { data: post, error: postErr } = await supabase
    .from("posts").select("id, user_id, type, reposts_count").eq("id", postId).maybeSingle();
  if (postErr) throw postErr;
  if (!post) return { notFound: true as const };
  if (post.type !== "post") return { invalidType: true as const };

  const { data: existing, error } = await supabase
    .from("reposts").select("id").eq("user_id", userId).eq("post_id", postId).maybeSingle();
  if (error) throw error;

  if (existing) {
    await supabase.from("reposts").delete().eq("id", existing.id);
    const newCount = Math.max(0, (post.reposts_count ?? 1) - 1);
    await supabase.from("posts").update({ reposts_count: newCount }).eq("id", postId);
    return { reposted: false, reposts_count: newCount };
  }

  await supabase.from("reposts").insert({ user_id: userId, post_id: postId, quote: quote ?? null });
  const newCount = (post.reposts_count ?? 0) + 1;
  await supabase.from("posts").update({ reposts_count: newCount }).eq("id", postId);

  return { reposted: true, reposts_count: newCount };
}