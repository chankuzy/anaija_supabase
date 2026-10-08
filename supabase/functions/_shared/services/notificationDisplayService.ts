import type { SupabaseClient } from "../auth.ts";
import { resolveAvatarUrl } from "../avatar.ts";

const PAGE_SIZE = 30;

export async function listNotifications(supabase: SupabaseClient, userId: number, page: number) {
  const from = (page - 1) * PAGE_SIZE;

  const { data: items, error } = await supabase
    .from("notifications")
    .select("*, actor:users!notifications_actor_id_foreign(id, name, username, avatar_key)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .range(from, from + PAGE_SIZE); // +1 to detect has_more

  if (error) throw error;

  const hasMore = (items?.length ?? 0) > PAGE_SIZE;
  const page_ = (items ?? []).slice(0, PAGE_SIZE);

  // Batch-fetch posts referenced by these notifications (avoid N+1)
  const postIds = [...new Set(
    page_.filter((n: any) => n.notifiable_type === "posts" && n.notifiable_id).map((n: any) => n.notifiable_id)
  )];

  const postsById = new Map<number, any>();
  if (postIds.length) {
    const { data: posts } = await supabase
      .from("posts")
      .select("*, media:post_media(*), listingDetail:listing_details(*)")
      .in("id", postIds);
    for (const p of posts ?? []) postsById.set(p.id, p);
  }

  // Batch-fetch comments referenced by these notifications (comment +
  // reply notifications carry a comment_id so the client can deep-link
  // straight to the exact comment, not just the post).
  const commentIds = [...new Set(
    page_.filter((n: any) => n.comment_id).map((n: any) => n.comment_id)
  )];
  const commentsById = new Map<number, any>();
  if (commentIds.length) {
    const { data: comments } = await supabase
      .from("comments")
      .select("id, body, post_id")
      .in("id", commentIds);
    for (const c of comments ?? []) commentsById.set(c.id, c);
  }

  // Batch follow-back check
  const actorIds = [...new Set(page_.filter((n: any) => n.actor_id).map((n: any) => n.actor_id))];
  const followingBackSet = new Set<number>();
  if (actorIds.length) {
    const { data: follows } = await supabase.from("follows").select("following_id")
      .eq("follower_id", userId).in("following_id", actorIds);
    for (const f of follows ?? []) followingBackSet.add(f.following_id);
  }

  // Union of every actor_id across all aggregated rows on this page, so we
  // can show a small avatar stack + name list for "12 people liked this"
  // instead of just the single most-recent actor.
  const allActorIds = [...new Set(page_.flatMap((n: any) => (n.actor_ids ?? []) as number[]))];
  const actorsById = new Map<number, any>();
  if (allActorIds.length) {
    const { data: actorRows } = await supabase
      .from("users")
      .select("id, name, username, avatar_key")
      .in("id", allActorIds);
    for (const a of actorRows ?? []) actorsById.set(a.id, a);
  }

  const { count: unreadCount } = await supabase
    .from("notifications").select("*", { count: "exact", head: true })
    .eq("user_id", userId).is("read_at", null);

 return {
    data: page_.map((n: any) => formatNotification(n, postsById, commentsById, followingBackSet, actorsById)),
    unread_count: unreadCount ?? 0,
    has_more: hasMore,
  };
}

function formatNotification(n: any, postsById: Map<number, any>, commentsById: Map<number, any>, followingBackSet: Set<number>, actorsById: Map<number, any>) {
  let listing = null;

  if (n.notifiable_type === "posts" && n.notifiable_id && postsById.has(n.notifiable_id)) {
    const post = postsById.get(n.notifiable_id);
    const images = (post.media ?? []).filter((m: any) => m.media_type === "image");
    const first = images[0];

    // FIX: this used to call supabase.storage.createSignedUrl(), which only
    // resolves objects actually living in Supabase Storage. Post media
    // lives in R2 and is served via the CDN — resolveAvatarUrl (despite the
    // name, a plain storage-key -> CDN-URL resolver used everywhere else in
    // the app) is the correct resolver here, same as feedService.ts uses.
    const image = first ? resolveAvatarUrl(first.thumbnail_key || first.storage_key) : null;

    const detail = post.listingDetail?.[0] ?? post.listingDetail;

    listing = {
      post_id: post.id,
      post_type: post.type,
      caption: post.caption,
      image,
      image_count: images.length,
      formatted_price: detail ? (detail.price_minor / 100).toLocaleString() : null,
    };
  }

  const comment = n.comment_id ? commentsById.get(n.comment_id) : null;

  const otherActorsCount = Math.max(0, (n.aggregate_count ?? 1) - 1);

   const actors = (n.actor_ids ?? [])
    .slice(0, 5)
    .map((id: number) => actorsById.get(id))
    .filter(Boolean)
    .map((a: any) => ({
      id: a.id,
      name: a.name,
      username: a.username,
      avatar: resolveAvatarUrl(a.avatar_key),
    }));

  return {
    id: n.id,
    type: n.type,
    body: n.body,
    is_read: n.read_at !== null,
    created_at: n.created_at,
    actor: n.actor ? {
      id: n.actor.id,
      name: n.actor.name,
      username: n.actor.username,
      // Same fix as post images — avatars are public CDN assets, not
      // Supabase Storage objects, so resolveAvatarUrl is correct here too.
      avatar: resolveAvatarUrl(n.actor.avatar_key),
    } : null,
    is_following_back: n.actor_id ? followingBackSet.has(n.actor_id) : false,
    listing,
    notifiable_type: n.notifiable_type,
    notifiable_id: n.notifiable_id,
    comment_id: n.comment_id ?? null,
    comment_body: comment?.body ?? null,
    aggregate_count: n.aggregate_count ?? 1,
    other_actors_count: otherActorsCount,
    actors
  };
}

export async function markNotificationsRead(supabase: SupabaseClient, userId: number, all: boolean, id: string | null) {
  if (all) {
    await supabase.from("notifications").update({ read_at: new Date().toISOString() })
      .eq("user_id", userId).is("read_at", null);
    return { message: "All notifications marked as read." };
  }

  if (!id) return { message: "id is required." };

  await supabase.from("notifications").update({ read_at: new Date().toISOString() })
    .eq("id", id).eq("user_id", userId);
  return { message: "Notification marked as read." };
}

export async function getUnreadCount(supabase: SupabaseClient, userId: number) {
  const { count } = await supabase.from("notifications").select("*", { count: "exact", head: true })
    .eq("user_id", userId).is("read_at", null);
  return { count: count ?? 0 };
}
