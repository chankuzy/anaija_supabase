import type { SupabaseClient } from "../auth.ts";
import { findConversationBetween, assertCanSend } from "./messagingService.ts";
import { getFollowStatus, isBlockedEitherWay } from "./blockService.ts";
import { broadcastToConversation, broadcastToUser, broadcastBatch } from "./realtimeService.ts";
import { notifyMessage } from "./notificationService.ts";

// Story likes deliberately have no code here: a story is a `posts` row, so
// likes go through interactionService.toggleLike (posts-like), which
// already handles the count, the post_likes row, and the "liked your
// story" notification.

// Tells everyone who can see this author's stories — their followers plus
// the author's own other devices — that the story set changed, so their
// stories row refreshes without an app restart. One shared event, one
// batched request; clients respond by refetching /stories-index.
//
// Followers beyond FANOUT_LIMIT simply don't get the push and pick the
// change up on their next resume/refetch — better than making one story
// upload wait on tens of thousands of messages.
const STORY_FANOUT_LIMIT = 1000;

export async function broadcastStoryChange(
  supabase: SupabaseClient,
  authorId: number,
  event: "created" | "deleted",
  storyId: number,
) {
  try {
    const { data: followers } = await supabase
      .from("follows")
      .select("follower_id")
      .eq("following_id", authorId)
      .limit(STORY_FANOUT_LIMIT);

    const audience = new Set<number>([authorId]);
    for (const f of followers ?? []) audience.add(f.follower_id);

    await broadcastBatch(
      [...audience].map((userId) => ({
        topic: `stories:${userId}`,
        event: "stories_update",
        payload: { author_id: authorId, story_id: storyId, event },
      })),
    );
  } catch (err) {
    console.error("Story change broadcast failed:", err);
  }
}

export async function markStoryViewed(supabase: SupabaseClient, postId: number, userId: number) {
  const { data: post } = await supabase.from("posts").select("id, type, expires_at").eq("id", postId).maybeSingle();
  if (!post) return { notFound: true as const };
  if (post.type !== "story") return { notAStory: true as const };
  if (post.expires_at && new Date(post.expires_at) < new Date()) return { expired: true as const };

  await supabase.from("story_views").upsert(
    { post_id: postId, user_id: userId, viewed_at: new Date().toISOString() },
    { onConflict: "post_id,user_id" },
  );

  return { ok: true as const };
}

export async function getStoryViewers(supabase: SupabaseClient, postId: number, userId: number, cdnBase: string) {
  const { data: post } = await supabase.from("posts").select("id, user_id").eq("id", postId).maybeSingle();
  if (!post) return { notFound: true as const };
  if (post.user_id !== userId) return { unauthorized: true as const };

  const { data, error } = await supabase
    .from("story_views")
    .select("viewed_at, user:users(id, name, username, avatar_key)")
    .eq("post_id", postId)
    .order("viewed_at", { ascending: false })
    .limit(50);

  if (error) throw error;

  return {
    data: (data ?? []).map((v: any) => ({
      viewed_at: v.viewed_at,
      user: v.user ? {
        id: v.user.id, name: v.user.name, username: v.user.username,
        avatar: v.user.avatar_key ? `${cdnBase}/${v.user.avatar_key}` : null,
      } : null,
    })),
  };
}

// FIX: now goes through the exact same gate sendMessage does — a blocked
// user, or a stranger past their 3-message cap, can no longer route
// around the message-request system just by replying to a story instead
// of DMing directly. Also now fires the same realtime/unread/notify
// fan-out sendMessage does, which this was silently skipping entirely
// before (recipient got a DB row with no push, no inbox update, no
// realtime event).
export async function replyToStory(supabase: SupabaseClient, postId: number, viewerId: number, message: string | null) {
  const { data: post } = await supabase.from("posts").select("id, type, user_id, expires_at").eq("id", postId).maybeSingle();
  if (!post) return { notFound: true as const };
  if (post.type !== "story") return { notAStory: true as const };
  if (post.expires_at && new Date(post.expires_at) < new Date()) return { expired: true as const };

  const authorId = post.user_id;
  if (viewerId === authorId) return { ownStory: true as const };

  if (await isBlockedEitherWay(supabase, viewerId, authorId)) return { blocked: true as const };

  let conversationId = await findConversationBetween(supabase, viewerId, authorId);

  if (!conversationId) {
    const { mutual } = await getFollowStatus(supabase, viewerId, authorId);

    const { data: conv, error: convErr } = await supabase
      .from("conversations").insert({ type: "direct", is_active: true }).select("id").single();
    if (convErr) throw convErr;
    conversationId = conv.id;

    await supabase.from("conversation_participants").insert([
      { conversation_id: conversationId, user_id: viewerId, role: "member", unread_count: 0, request_status: "accepted" },
      {
        conversation_id: conversationId, user_id: authorId, role: "member", unread_count: 0,
        request_status: mutual ? "accepted" : "pending",
        requested_at: mutual ? null : new Date().toISOString(),
      },
    ]);
  }

  const gate = await assertCanSend(supabase, conversationId, viewerId);
  if ("unauthorized" in gate) return { unauthorized: true as const };
  if ("blocked" in gate) return { blocked: true as const };
  if ("requestLimitReached" in gate) return { requestLimitReached: true as const };

  const body = message ?? "Replied to your story";

  const { data: msg, error: msgErr } = await supabase
    .from("messages")
    .insert({ conversation_id: conversationId, sender_id: viewerId, type: "post_share", body, shared_post_id: postId })
    .select("id, created_at").single();
  if (msgErr) throw msgErr;

  const lastMessageAt = new Date().toISOString();

  await supabase.from("conversations").update({
    last_message_body: body, last_message_at: lastMessageAt, last_message_by: viewerId,
  }).eq("id", conversationId);

  for (const other of gate.others) {
    const newUnreadCount = (other.unread_count ?? 0) + 1;
    await supabase.from("conversation_participants").update({ unread_count: newUnreadCount }).eq("id", other.id);

    await broadcastToUser(supabase, other.user_id, "inbox_update", {
      conversation_id: conversationId,
      last_message_body: body,
      last_message_at: lastMessageAt,
      unread_count: newUnreadCount,
    });

    if (!other.is_muted) {
      await notifyMessage(supabase, {
        conversationId,
        senderId: viewerId,
        senderName: "Someone",
        recipientId: other.user_id,
        message: { body, type: "post_share" },
        conversationTitle: null,
      });
    }
  }

  await broadcastToConversation(supabase, conversationId, "new_message", {
    id: msg.id,
    conversation_id: conversationId,
    type: "post_share",
    body,
    media_url: null,
    media_type: null,
    reactions: {},
    reply_to: null,
    shared_post: null,
    sender: null,
    created_at: msg.created_at,
  });

  return { conversation_id: conversationId, message_id: msg.id };
}