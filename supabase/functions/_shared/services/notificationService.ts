import type { SupabaseClient } from "../auth.ts";

export const TYPE_LIKE = "like";
export const TYPE_REPOST = "repost";
export const TYPE_COMMENT = "comment";
export const TYPE_FOLLOW = "follow";
export const TYPE_MESSAGE = "message";

interface CreateNotificationInput {
  userId: number;
  actorId?: number | null;
  type: string;
  notifiableType?: string | null;
  notifiableId?: number | null;
  body?: string | null;
  commentId?: number | null;
}

// Fire-and-forget: logs failures but never throws, so a notification
// hiccup can't break the like/comment/follow/repost action itself.
// Dedup: skip if an identical notification (same user/type/actor/target)
// was already created in the last 5 minutes. Used for one-off events
// (comments, replies) that shouldn't be rolled up like likes/follows/reposts.
export async function createNotification(supabase: SupabaseClient, input: CreateNotificationInput) {
  if (input.actorId && input.actorId === input.userId) return; // never notify yourself

  if (input.notifiableId && input.actorId) {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const { data: recent } = await supabase
      .from("notifications")
      .select("id")
      .eq("user_id", input.userId)
      .eq("type", input.type)
      .eq("actor_id", input.actorId)
      .eq("notifiable_type", input.notifiableType ?? "")
      .eq("notifiable_id", input.notifiableId)
      .gte("created_at", fiveMinAgo)
      .maybeSingle();

    if (recent) return; // duplicate within the window — skip
  }

  const { error } = await supabase.from("notifications").insert({
    id: crypto.randomUUID(),
    user_id: input.userId,
    actor_id: input.actorId ?? null,
    actor_ids: input.actorId ? [input.actorId] : [],
    type: input.type,
    notifiable_type: input.notifiableType ?? null,
    notifiable_id: input.notifiableId ?? null,
    body: input.body ?? null,
    comment_id: input.commentId ?? null,
  });

  if (error) console.error("Failed to create notification:", error);
}

// ─── Generic aggregation ────────────────────────────────────────────────────
// Rolls consecutive UNREAD notifications of the same (user, type, target)
// into a single row — "Sarah and 12 others liked your post" instead of 13
// rows, "Ada and 4 others started following you" instead of 5 separate ones.
// Once the row is marked read, the next event starts a fresh row, so
// aggregation only ever bundles what the user hasn't seen yet.
// `notifiableId: null` (follow — the target IS the user, there's no post)
// aggregates per (user, type) instead of per (user, type, target).
interface AggregateInput {
  userId: number;
  actorId: number;
  actorName: string;
  type: string;
  notifiableType?: string | null;
  notifiableId?: number | null;
  // othersCount is 0 for the very first (solo) notification and the count
  // of *other* actors beyond the named one for every aggregated update —
  // callers own the full sentence so copy can shift tone as a crowd grows,
  // not just splice a number into a fixed template.
  renderBody: (othersCount: number, actorName: string) => string;
}

export async function notifyAggregated(supabase: SupabaseClient, input: AggregateInput) {
  const { userId, actorId, actorName, type, notifiableType, notifiableId, renderBody } = input;
  if (actorId === userId) return;

  let query = supabase
    .from("notifications")
    .select("id, actor_ids, aggregate_count")
    .eq("user_id", userId)
    .eq("type", type)
    .is("read_at", null);

  query = notifiableId != null
    ? query.eq("notifiable_type", notifiableType ?? "").eq("notifiable_id", notifiableId)
    : query.is("notifiable_id", null);

  const { data: existing, error: findErr } = await query.maybeSingle();
  if (findErr) {
    console.error(`Failed to look up existing ${type} notification:`, findErr);
    return;
  }

  if (existing) {
    const actorIds: number[] = existing.actor_ids ?? [];
    if (actorIds.includes(actorId)) return; // e.g. unlike+relike / unfollow+refollow race
    const updatedActorIds = [actorId, ...actorIds].slice(0, 50); // cap unbounded growth
    const newCount = (existing.aggregate_count ?? 1) + 1;
    const body = renderBody(newCount - 1, actorName);

    const { error } = await supabase.from("notifications").update({
      actor_id: actorId,
      actor_ids: updatedActorIds,
      aggregate_count: newCount,
      body,
      read_at: null,
      created_at: new Date().toISOString(),
    }).eq("id", existing.id);
    if (error) console.error(`Failed to aggregate ${type} notification:`, error);
    return;
  }

  const { error } = await supabase.from("notifications").insert({
    id: crypto.randomUUID(),
    user_id: userId,
    actor_id: actorId,
    actor_ids: [actorId],
    aggregate_count: 1,
    type,
    notifiable_type: notifiableType ?? null,
    notifiable_id: notifiableId ?? null,
    body: renderBody(0, actorName),
  });
  if (error) console.error(`Failed to create ${type} notification:`, error);
}

// ─── Like aggregation (thin wrapper over notifyAggregated) ─────────────────
// Copy shifts tone as the crowd grows — a single like reads as a plain
// fact, a real crowd reads like something's actually happening, matching
// how Threads' "Your post is getting attention" framing behaves.
export async function notifyLike(supabase: SupabaseClient, input: {
  userId: number; actorId: number; postId: number; actorName: string; label: string;
}) {
  const { userId, actorId, postId, actorName, label } = input;
  return notifyAggregated(supabase, {
    userId, actorId, actorName,
    type: TYPE_LIKE,
    notifiableType: "posts",
    notifiableId: postId,
    renderBody: (others, name) => {
      if (others === 0) return `${name} liked your ${label}.`;
      if (others >= 10) {
        return `🔥 ${name} and ${others} others liked your ${label} — it's getting attention.`;
      }
      return `${name} and ${others} other${others === 1 ? "" : "s"} liked your ${label}.`;
    },
  });
}

// ─── Follow aggregation (thin wrapper over notifyAggregated) ───────────────
// Follows have no notifiable_id, so createNotification's 5-min dedup never
// applied to them — every follow/unfollow/refollow (including rapid button
// abuse) was inserting a fresh row. This rolls consecutive unread follows
// into one, exactly like likes.
export async function notifyFollow(supabase: SupabaseClient, input: {
  userId: number; actorId: number; actorName: string;
}) {
  const { userId, actorId, actorName } = input;
  return notifyAggregated(supabase, {
    userId, actorId, actorName,
    type: TYPE_FOLLOW,
    notifiableType: null,
    notifiableId: null,
    renderBody: (others, name) => {
      if (others === 0) return `${name} started following you.`;
      if (others >= 5) {
        return `👋 ${name} and ${others} others started following you — say hi to your newest fans.`;
      }
      return `${name} and ${others} other${others === 1 ? "" : "s"} started following you.`;
    },
  });
}

// ─── Message notifications ──────────────────────────────────────────────────

function buildMessagePreview(msg: { body?: string | null; type?: string }): string {
  if (msg.body && msg.body.trim().length) {
    const trimmed = msg.body.trim();
    return trimmed.length > 80 ? `${trimmed.slice(0, 80).trimEnd()}…` : trimmed;
  }
  switch (msg.type) {
    case "image": return "📷 Photo";
    case "video": return "🎥 Video";
    case "audio": return "🎵 Audio";
    case "post_share": return "📎 Shared a post";
    case "listing_share": return "🛍️ Shared a listing";
    default: return "Sent a message";
  }
}

interface MessageNotifyInput {
  conversationId: number;
  senderId: number;
  senderName: string;
  recipientId: number;
  message: { body?: string | null; type?: string };
  // Only meaningful for group conversations — direct chats pass null and
  // fall back to the sender's name instead of a conversation title.
  conversationTitle?: string | null;
}

// Deliberately its own function rather than a call into notifyAggregated:
// likes/follows count *unique actors* (a repeat actor is a no-op), but
// messages count *unread messages* — three messages from the same person
// should read "sent you 3 messages", not collapse like a repeated like.
export async function notifyMessage(supabase: SupabaseClient, input: MessageNotifyInput) {
  const { conversationId, senderId, senderName, recipientId, message, conversationTitle } = input;
  if (senderId === recipientId) return;

  const { data: existing, error: findErr } = await supabase
    .from("notifications")
    .select("id, actor_ids, aggregate_count")
    .eq("user_id", recipientId)
    .eq("type", TYPE_MESSAGE)
    .eq("notifiable_type", "conversations")
    .eq("notifiable_id", conversationId)
    .is("read_at", null)
    .maybeSingle();

  if (findErr) {
    console.error("Failed to look up existing message notification:", findErr);
    return;
  }

  const actorIds: number[] = existing?.actor_ids ?? [];
  const updatedActorIds = actorIds.includes(senderId) ? actorIds : [senderId, ...actorIds].slice(0, 50);
  const messageCount = (existing?.aggregate_count ?? 0) + 1;
  const preview = buildMessagePreview(message);

  const body = updatedActorIds.length > 1
    ? (conversationTitle
        ? `${messageCount} new messages in ${conversationTitle}.`
        : `${messageCount} new messages from ${updatedActorIds.length} people.`)
    : messageCount === 1
      ? `${senderName}: ${preview}`
      : `${senderName} sent you ${messageCount} messages.`;

  if (existing) {
    const { error } = await supabase.from("notifications").update({
      actor_id: senderId,
      actor_ids: updatedActorIds,
      aggregate_count: messageCount,
      body,
      read_at: null,
      created_at: new Date().toISOString(),
    }).eq("id", existing.id);
    if (error) console.error("Failed to aggregate message notification:", error);
    return;
  }

  const { error } = await supabase.from("notifications").insert({
    id: crypto.randomUUID(),
    user_id: recipientId,
    actor_id: senderId,
    actor_ids: [senderId],
    aggregate_count: 1,
    type: TYPE_MESSAGE,
    notifiable_type: "conversations",
    notifiable_id: conversationId,
    body,
  });
  if (error) console.error("Failed to create message notification:", error);
}

// ─── New-post notifications (opt-in per followed account) ───────────────────
export const TYPE_POST = "post";
const POST_FANOUT_LIMIT = 500;

// Tells followers who turned on "notify me" for this author that a new post
// is live. Fire-and-forget: never throws, so it can't break publishing.
export async function notifyFollowersOfPost(supabase: SupabaseClient, input: {
  authorId: number; authorName: string; postId: number; label: string;
}) {
  const { authorId, authorName, postId, label } = input;
  try {
    const { data: rows, error } = await supabase
      .from("follows")
      .select("follower_id")
      .eq("following_id", authorId)
      .eq("notify_posts", true)
      .limit(POST_FANOUT_LIMIT);
    if (error) throw error;

    await Promise.allSettled((rows ?? []).map((r: any) =>
      createNotification(supabase, {
        userId: r.follower_id,
        actorId: authorId,
        type: TYPE_POST,
        notifiableType: "posts",
        notifiableId: postId,
        body: `${authorName} shared a new ${label}.`,
      })
    ));
  } catch (err) {
    console.error("notifyFollowersOfPost failed:", err);
  }
}
