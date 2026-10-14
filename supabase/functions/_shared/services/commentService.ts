import type { SupabaseClient } from "../auth.ts";

const PAGE_SIZE = 20;

function truncate(text: string, length = 60): string {
  return text.length > length ? text.slice(0, length) + "…" : text;
}

function formatComment(c: any, cdnBase: string, likedIds: Set<number>) {
  return {
    id: c.id,
    body: c.body,
    likes_count: c.likes_count,
    replies_count: c.replies_count ?? 0,
    is_liked: likedIds.has(c.id),
    created_at: c.created_at,
    author: {
      id: c.user.id,
      name: c.user.name,
      username: c.user.username,
      avatar: c.user.avatar_key ? `${cdnBase}/${c.user.avatar_key}` : null,
    },
  };
}

async function getLikedCommentIds(supabase: SupabaseClient, viewerId: number, commentIds: number[]): Promise<Set<number>> {
  if (!commentIds.length) return new Set();
  const { data } = await supabase.from("comment_likes").select("comment_id")
    .eq("user_id", viewerId).in("comment_id", commentIds);
  return new Set((data ?? []).map((r: any) => r.comment_id));
}

// ─── List top-level comments ─────────────────────────────────────────────

export async function listComments(supabase: SupabaseClient, postId: number, viewerId: number, cursor: string | null, cdnBase: string) {
  const { data: post } = await supabase.from("posts").select("allow_comments").eq("id", postId).maybeSingle();
  if (!post) return { notFound: true as const };
  if (!post.allow_comments) return { disabled: true as const };

  const cursorId = cursor ? parseInt(atob(cursor), 10) : Number.MAX_SAFE_INTEGER;

  const { data: comments, error } = await supabase
    .from("comments")
    .select("*, user:users(id, name, username, avatar_key), replies:comments!parent_id(count)")
    .eq("post_id", postId)
    .is("parent_id", null)
    .lt("id", cursorId)
    .order("likes_count", { ascending: false })
    .order("id", { ascending: false })
    .limit(PAGE_SIZE);

  if (error) throw error;

  const rows = (comments ?? []).map((c: any) => ({ ...c, replies_count: c.replies?.[0]?.count ?? 0 }));
  const hasMore = rows.length === PAGE_SIZE;
  const likedIds = await getLikedCommentIds(supabase, viewerId, rows.map((c: any) => c.id));

  return {
    data: rows.map((c: any) => formatComment(c, cdnBase, likedIds)),
    next_cursor: hasMore ? btoa(String(rows[rows.length - 1].id)) : null,
    has_more: hasMore,
  };
}

// ─── Create comment / reply ──────────────────────────────────────────────


export async function createComment(
  supabase: SupabaseClient,
  postId: number,
  userId: number,
  userName: string,
  body: string,
  parentId: number | null,
  cdnBase: string,
) {
  const { data: post, error: postErr } = await supabase
    .from("posts").select("id, user_id, type, allow_comments, comments_count").eq("id", postId).maybeSingle();
  if (postErr) throw postErr;
  if (!post) return { notFound: true as const };
  if (post.type === "story") return { storiesNotAllowed: true as const };
  if (!post.allow_comments) return { disabled: true as const };

  let parent = null;
  if (parentId) {
    const { data: p } = await supabase.from("comments").select("id, user_id")
      .eq("id", parentId).eq("post_id", postId).is("parent_id", null).maybeSingle();
    if (!p) return { parentNotFound: true as const };
    parent = p;
  }

  const { data: comment, error } = await supabase
    .from("comments")
    .insert({ user_id: userId, post_id: postId, parent_id: parentId, body })
    .select("*, user:users(id, name, username, avatar_key)")
    .single();
  if (error) throw error;

  if (!parentId) {
    await supabase.from("posts").update({ comments_count: (post.comments_count ?? 0) + 1 }).eq("id", postId);
  }

  // Comment / reply / mention notifications are produced by the comments trigger (activity_events).

  return { comment: formatComment(comment, cdnBase, new Set()) };
}

// ─── Replies ──────────────────────────────────────────────────────────────

export async function listReplies(supabase: SupabaseClient, commentId: number, viewerId: number, cursor: string | null, cdnBase: string) {
  const cursorId = cursor ? parseInt(atob(cursor), 10) : 0;

  const { data: replies, error } = await supabase
    .from("comments")
    .select("*, user:users(id, name, username, avatar_key)")
    .eq("parent_id", commentId)
    .gt("id", cursorId)
    .order("id", { ascending: true })
    .limit(PAGE_SIZE);

  if (error) throw error;

  const hasMore = (replies?.length ?? 0) === PAGE_SIZE;
  const likedIds = await getLikedCommentIds(supabase, viewerId, (replies ?? []).map((r: any) => r.id));

  return {
    data: (replies ?? []).map((r: any) => formatComment(r, cdnBase, likedIds)),
    next_cursor: hasMore ? btoa(String(replies![replies!.length - 1].id)) : null,
    has_more: hasMore,
  };
}

// ─── Delete ───────────────────────────────────────────────────────────────

export async function deleteComment(supabase: SupabaseClient, commentId: number, userId: number) {
  const { data: comment, error } = await supabase
    .from("comments").select("id, user_id, post_id, parent_id").eq("id", commentId).maybeSingle();
  if (error) throw error;
  if (!comment) return { notFound: true as const };

  const { data: post } = await supabase.from("posts").select("user_id, comments_count").eq("id", comment.post_id).maybeSingle();

  if (comment.user_id !== userId && post?.user_id !== userId) {
    return { unauthorized: true as const };
  }

  if (!comment.parent_id && post) {
    await supabase.from("posts").update({ comments_count: Math.max(0, (post.comments_count ?? 1) - 1) }).eq("id", comment.post_id);
  }

  await supabase.from("comments").update({ deleted_at: new Date().toISOString() }).eq("id", commentId);
  return { ok: true as const };
}

// ─── Like ─────────────────────────────────────────────────────────────────

export async function toggleCommentLike(supabase: SupabaseClient, userId: number, commentId: number) {
  const { data: comment, error } = await supabase.from("comments").select("id, likes_count").eq("id", commentId).maybeSingle();
  if (error) throw error;
  if (!comment) return { notFound: true as const };

  const { data: existing } = await supabase.from("comment_likes").select("id")
    .eq("user_id", userId).eq("comment_id", commentId).maybeSingle();

  if (existing) {
    await supabase.from("comment_likes").delete().eq("id", existing.id);
    const newCount = Math.max(0, (comment.likes_count ?? 1) - 1);
    await supabase.from("comments").update({ likes_count: newCount }).eq("id", commentId);
    return { liked: false, likes_count: newCount };
  }

  await supabase.from("comment_likes").insert({ user_id: userId, comment_id: commentId });
  const newCount = (comment.likes_count ?? 0) + 1;
  await supabase.from("comments").update({ likes_count: newCount }).eq("id", commentId);
  return { liked: true, likes_count: newCount };
}

// ─── Locate ───────────────────────────────────────────────────────────────
// Given any comment id (top-level or a reply), resolves which top-level
// comment should be scrolled-to/highlighted in the sheet (a reply resolves
// to its parent, since the sheet only renders top-level comments), and its
// 0-indexed rank in the sheet's actual sort order (likes_count desc, id
// desc) so the client knows how many pages to fetch before it's loaded.
export async function locateComment(supabase: SupabaseClient, postId: number, commentId: number) {
  const { data: target, error } = await supabase
    .from("comments").select("id, parent_id, likes_count").eq("id", commentId).maybeSingle();
  if (error) throw error;
  if (!target) return { notFound: true as const };

  let topLevel = target;
  if (target.parent_id) {
    const { data: parent, error: pErr } = await supabase
      .from("comments").select("id, likes_count").eq("id", target.parent_id).maybeSingle();
    if (pErr) throw pErr;
    if (!parent) return { notFound: true as const };
    topLevel = parent;
  }

  const { count, error: cErr } = await supabase
    .from("comments")
    .select("*", { count: "exact", head: true })

    .eq("post_id", postId)
    .is("parent_id", null)
    .or(`likes_count.gt.${topLevel.likes_count},and(likes_count.eq.${topLevel.likes_count},id.gt.${topLevel.id})`);
  if (cErr) throw cErr;

  return { top_level_id: topLevel.id, position: count ?? 0, is_reply: !!target.parent_id };
}
