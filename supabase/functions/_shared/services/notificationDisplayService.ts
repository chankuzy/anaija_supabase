import type { SupabaseClient } from "../auth.ts";

const PAGE_SIZE = 30;

const STORAGE_BUCKET = Deno.env.get("STORAGE_BUCKET") ?? "media";

async function signedUrl(supabase: SupabaseClient, key: string | null): Promise<string | null> {
  if (!key) return null;
  if (key.startsWith("http")) return key;
  const { data } = await supabase.storage.from(STORAGE_BUCKET).createSignedUrl(key, 3600);
  return data?.signedUrl ?? null;
}

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

  // Batch follow-back check
  const actorIds = [...new Set(page_.filter((n: any) => n.actor_id).map((n: any) => n.actor_id))];
  const followingBackSet = new Set<number>();
  if (actorIds.length) {
    const { data: follows } = await supabase.from("follows").select("following_id")
      .eq("follower_id", userId).in("following_id", actorIds);
    for (const f of follows ?? []) followingBackSet.add(f.following_id);
  }

  const { count: unreadCount } = await supabase
    .from("notifications").select("*", { count: "exact", head: true })
    .eq("user_id", userId).is("read_at", null);

 return {
    data: await Promise.all(page_.map((n: any) => formatNotification(supabase, n, postsById, followingBackSet))),
    unread_count: unreadCount ?? 0,
    has_more: hasMore,
  };
}

async function formatNotification(supabase: SupabaseClient, n: any, postsById: Map<number, any>, followingBackSet: Set<number>) {
  let listing = null;

  if (n.notifiable_type === "posts" && n.notifiable_id && postsById.has(n.notifiable_id)) {
    const post = postsById.get(n.notifiable_id);
    const images = (post.media ?? []).filter((m: any) => m.media_type === "image");
    const first = images[0];

    let image: string | null = null;
    if (first) {
      const key = first.thumbnail_key || first.storage_key;
      image = await signedUrl(supabase, key);
    }

    const detail = post.listingDetail?.[0] ?? post.listingDetail;

    listing = {
      post_id: post.id,
      caption: post.caption,
      image,
      image_count: images.length,
      formatted_price: detail ? (detail.price_minor / 100).toLocaleString() : null,
    };
  }

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
      avatar: await signedUrl(supabase, n.actor.avatar_key),
    } : null,
    is_following_back: n.actor_id ? followingBackSet.has(n.actor_id) : false,
    listing,
    notifiable_type: n.notifiable_type,
    notifiable_id: n.notifiable_id,
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