import type { SupabaseClient } from "../auth.ts";
import { can, loadAccess } from "./communityAccess.ts";
import { canViewPost } from "./contentAccess.ts";
import { broadcastBatch } from "./realtimeService.ts";

/** Send gate for a community's chat: membership, ban, mute, archive state and the community's `chat` permission. */
export async function assertCanSendCommunity(supabase: SupabaseClient, communityId: number, userId: number) {
  const a = await loadAccess(supabase, communityId, userId);
  if (!a || !a.role || a.banned) return { unauthorized: true as const };
  if (a.community.status !== "active") return { forbidden: "This community is read-only." };
  if (!can(a, "chat")) return { forbidden: "Only some members can send messages in this chat." };
  const { data: m } = await supabase.from("community_members").select("muted_until")
    .eq("community_id", communityId).eq("user_id", userId).maybeSingle();
  if (m?.muted_until && new Date(m.muted_until) > new Date()) return { forbidden: "You're muted in this community right now." };
  return { ok: true as const, others: [] as { id: number; user_id: number; unread_count: number }[] };
}

/** A shared post must be visible to the sender, and a community's posts only travel inside that community's chat. */
export async function checkShareTarget(
  supabase: SupabaseClient, userId: number, communityId: number | null, postId: number,
): Promise<string | null> {
  const { data: post } = await supabase.from("posts")
    .select("id, user_id, visibility, institution_id, context, community_id, community_feed, is_active, deleted_at")
    .eq("id", postId).maybeSingle();
  if (!post || !post.is_active || post.deleted_at) return "That post isn't available.";
  if (post.community_id && post.community_id !== communityId) return "Posts from a community can only be shared inside that community.";
  if (!(await canViewPost(supabase, userId, post))) return "That post isn't available.";
  return null;
}

/** One bulk unread bump + batched inbox pulses (REST, 100 per request) instead of a loop of per-member writes. */
export async function fanoutCommunityMessage(
  supabase: SupabaseClient, conversationId: number, senderId: number, preview: string, at: string,
) {
  try {
    await supabase.rpc("community_chat_bump", { p_conversation: conversationId, p_sender: senderId });
    const { data } = await supabase.from("conversation_participants").select("user_id, unread_count")
      .eq("conversation_id", conversationId).neq("user_id", senderId).limit(2000);
    await broadcastBatch((data ?? []).map((p: any) => ({
      topic: `user:${p.user_id}`, event: "inbox_update",
      payload: { conversation_id: conversationId, last_message_body: preview, last_message_at: at, unread_count: p.unread_count },
    })));
  } catch (e) {
    console.error("community chat fan-out failed", e);
  }
}
