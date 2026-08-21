import type { SupabaseClient } from "../auth.ts";
import { findConversationBetween } from "./messagingService.ts";

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

export async function replyToStory(supabase: SupabaseClient, postId: number, viewerId: number, message: string | null) {
  const { data: post } = await supabase.from("posts").select("id, type, user_id, expires_at").eq("id", postId).maybeSingle();
  if (!post) return { notFound: true as const };
  if (post.type !== "story") return { notAStory: true as const };
  if (post.expires_at && new Date(post.expires_at) < new Date()) return { expired: true as const };

  const authorId = post.user_id;
  if (viewerId === authorId) return { ownStory: true as const };

  let conversationId = await findConversationBetween(supabase, viewerId, authorId);

  if (!conversationId) {
    const { data: conv, error: convErr } = await supabase
      .from("conversations").insert({ type: "direct", is_active: true }).select("id").single();
    if (convErr) throw convErr;
    conversationId = conv.id;

    await supabase.from("conversation_participants").insert([
      { conversation_id: conversationId, user_id: viewerId, role: "member", unread_count: 0 },
      { conversation_id: conversationId, user_id: authorId, role: "member", unread_count: 1 },
    ]);
  } else {
    const { data: participant } = await supabase.from("conversation_participants").select("unread_count")
      .eq("conversation_id", conversationId).eq("user_id", authorId).single();
    await supabase.from("conversation_participants").update({ unread_count: (participant?.unread_count ?? 0) + 1 })
      .eq("conversation_id", conversationId).eq("user_id", authorId);
  }

  const body = message ?? "Replied to your story";

  const { data: msg, error: msgErr } = await supabase
    .from("messages")
    .insert({ conversation_id: conversationId, sender_id: viewerId, type: "post_share", body, shared_post_id: postId })
    .select("id").single();
  if (msgErr) throw msgErr;

  await supabase.from("conversations").update({
    last_message_body: body, last_message_at: new Date().toISOString(), last_message_by: viewerId,
  }).eq("id", conversationId);

  return { conversation_id: conversationId, message_id: msg.id };
}