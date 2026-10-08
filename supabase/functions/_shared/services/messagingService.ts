import type { SupabaseClient } from "../auth.ts";
import { broadcastToConversation, broadcastToUser } from "./realtimeService.ts";
import { resolveAvatarUrl } from "../avatar.ts";
import { notifyMessage } from "./notificationService.ts";
import { isBlockedEitherWay, getFollowStatus } from "./blockService.ts";

const PAGE_SIZE = 30;

// ─── Inbox ──────────────────────────────────────────────────────────────

export async function getInbox(supabase: SupabaseClient, userId: number) {
  const { data: myRows, error: myErr } = await supabase
    .from("conversation_participants")
    .select("conversation_id, unread_count, is_muted, request_status")
    .eq("user_id", userId);
  if (myErr) throw myErr;

  const visible = (myRows ?? []).filter((r: any) => r.request_status !== "declined");
  const convIds = visible.map((r: any) => r.conversation_id);
  if (!convIds.length) return { data: [], has_more: false };

  const { data: conversations, error } = await supabase
    .from("conversations")
    .select("*")
    .in("id", convIds)
    .eq("is_active", true)
    .order("last_message_at", { ascending: false })
    .limit(PAGE_SIZE);

  if (error) throw error;

  const myMeta = new Map(visible.map((r: any) => [r.conversation_id, r]));

  const { data: allParticipants } = await supabase
    .from("conversation_participants")
    .select("conversation_id, user_id, request_status, user:users(id, name, username, avatar_key, avatar)")
    .in("conversation_id", (conversations ?? []).map((c: any) => c.id));

  const participantsByConv = new Map<number, any[]>();
  for (const p of allParticipants ?? []) {
    if (!participantsByConv.has(p.conversation_id)) participantsByConv.set(p.conversation_id, []);
    participantsByConv.get(p.conversation_id)!.push(p);
  }

  const data = (conversations ?? []).map((c: any) => {
    const participants = participantsByConv.get(c.id) ?? [];
    const otherRow = participants.find((p: any) => p.user_id !== userId);
    const other = otherRow?.user;
    const mine = myMeta.get(c.id);
    const otherAvatar = other ? resolveAvatarUrl(other.avatar_key ?? other.avatar) : null;

    return {
      id: c.id,
      type: c.type,
      title: c.title ?? other?.name ?? null,
      avatar: otherAvatar,
      last_message_body: c.last_message_body,
      last_message_at: c.last_message_at,
      unread_count: mine?.unread_count ?? 0,
      is_muted: mine?.is_muted ?? false,
      request_status: mine?.request_status ?? "accepted",
      other_user: other ? {
        id: other.id, name: other.name, username: other.username,
        avatar: otherAvatar,
        request_status: otherRow?.request_status ?? "accepted",
      } : null,
    };
  });

  return { data, has_more: (conversations?.length ?? 0) === PAGE_SIZE };
}

// ─── Open direct conversation ────────────────────────────────────────────

export async function openDirect(supabase: SupabaseClient, myId: number, otherId: number) {
  if (myId === otherId) return { selfConversation: true as const };

  const { data: other } = await supabase.from("users").select("id").eq("id", otherId).maybeSingle();
  if (!other) return { notFound: true as const };

  if (await isBlockedEitherWay(supabase, myId, otherId)) return { blocked: true as const };

  const existing = await findConversationBetween(supabase, myId, otherId);
  if (existing) return { conversation_id: existing, existing: true };

  const { mutual } = await getFollowStatus(supabase, myId, otherId);

  const { data: conv, error: convErr } = await supabase
    .from("conversations")
    .insert({ type: "direct", is_active: true })
    .select("id").single();
  if (convErr) throw convErr;

  await supabase.from("conversation_participants").insert([
    { conversation_id: conv.id, user_id: myId, role: "member", unread_count: 0, request_status: "accepted" },
    {
      conversation_id: conv.id, user_id: otherId, role: "member", unread_count: 0,
      request_status: mutual ? "accepted" : "pending",
      requested_at: mutual ? null : new Date().toISOString(),
    },
  ]);

  return { conversation_id: conv.id, existing: false };
}

export async function findConversationBetween(supabase: SupabaseClient, userA: number, userB: number): Promise<number | null> {
  const { data: aRows } = await supabase.from("conversation_participants").select("conversation_id").eq("user_id", userA);
  const aIds = (aRows ?? []).map((r: any) => r.conversation_id);
  if (!aIds.length) return null;

  const { data: bRows } = await supabase.from("conversation_participants").select("conversation_id").eq("user_id", userB).in("conversation_id", aIds);
  const sharedIds = (bRows ?? []).map((r: any) => r.conversation_id);
  if (!sharedIds.length) return null;

  const { data: conv } = await supabase.from("conversations").select("id").in("id", sharedIds).in("type", ["direct", "listing_inquiry"]).limit(1).maybeSingle();
  return conv?.id ?? null;
}

// ─── Send gate ─────────────────────────────────────────────────────────────
//
// Shared by sendMessage AND storyService.replyToStory — anything that can
// insert a row into `messages` must pass through here first. Auto-accepts
// MY pending row (sending is an implicit accept), then checks the OTHER
// side: if they're still pending, I'm the initiator and capped at 3
// messages until they respond. Returns `others` so callers that need the
// participant list right after (unread bump, broadcast fan-out) don't
// have to re-query it.

export async function assertCanSend(supabase: SupabaseClient, conversationId: number, userId: number) {
  const { data: participant } = await supabase
    .from("conversation_participants").select("*").eq("conversation_id", conversationId).eq("user_id", userId).maybeSingle();
  if (!participant) return { unauthorized: true as const };

  const { data: others } = await supabase
    .from("conversation_participants")
    .select("id, user_id, unread_count, is_muted, request_status")
    .eq("conversation_id", conversationId)
    .neq("user_id", userId);

  for (const other of others ?? []) {
    if (await isBlockedEitherWay(supabase, userId, other.user_id)) return { blocked: true as const };
  }

  if (participant.request_status === "pending") {
    await supabase.from("conversation_participants").update({ request_status: "accepted" }).eq("id", participant.id);
  }

  const pendingOther = (others ?? []).find((o: any) => o.request_status === "pending");
  if (pendingOther) {
    const { count } = await supabase
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conversationId)
      .eq("sender_id", userId);
    if ((count ?? 0) >= 3) return { requestLimitReached: true as const };
  }

  return { ok: true as const, others: others ?? [] };
}

// ─── Messages list ────────────────────────────────────────────────────────

export async function listMessages(supabase: SupabaseClient, conversationId: number, userId: number, cursor: string | null) {
  const { data: participant } = await supabase
    .from("conversation_participants").select("*").eq("conversation_id", conversationId).eq("user_id", userId).maybeSingle();
  if (!participant) return { unauthorized: true as const };

  const cursorId = cursor ? parseInt(atob(cursor), 10) : Number.MAX_SAFE_INTEGER;

  const { data: rows, error } = await supabase
    .from("messages")
    .select(`
      *,
      sender:users!messages_sender_id_foreign(id, name, username, avatar_key, avatar),
      sharedPost:posts(*, user:users(id, name, username, avatar_key, avatar), listingDetail:listing_details(*), media:post_media(*))
    `)
    .eq("conversation_id", conversationId)
    .lt("id", cursorId)
    .order("id", { ascending: false })
    .limit(PAGE_SIZE);

  if (error) throw error;

  const messages = (rows ?? []).slice().reverse();
  const hasMore = messages.length === PAGE_SIZE;

  const replyToIds = [...new Set(messages.filter((m: any) => m.reply_to_id).map((m: any) => m.reply_to_id))];
  const replyToMap = new Map<number, any>();
  if (replyToIds.length) {
    const { data: replies } = await supabase.from("messages").select("id, body, sender_id").in("id", replyToIds);
    for (const r of replies ?? []) replyToMap.set(r.id, r);
  }

  await supabase.from("conversation_participants").update({ unread_count: 0, last_read_at: new Date().toISOString() })
    .eq("conversation_id", conversationId).eq("user_id", userId);

  const formattedMessages = messages.map((m: any) =>
    formatMessage({ ...m, replyTo: m.reply_to_id ? replyToMap.get(m.reply_to_id) : null })
  );

  return {
    messages: formattedMessages,
    next_cursor: hasMore ? btoa(String(messages[0].id)) : null,
    has_more: hasMore,
  };
}

// ─── Send message ─────────────────────────────────────────────────────────
//
// Idempotency: the client generates a `client_temp_id` once, when the
// optimistic local row is first created, and re-sends that SAME id on
// every retry — whether the retry is manual (user taps the failed bubble)
// or automatic (OfflineQueueService.flush() on reconnect). Both paths can
// race the same row, so the guarantee that only one message ever lands
// has to live here, not on the client: we check for an existing row by
// (conversation_id, sender_id, client_temp_id) before inserting, and fall
// back to fetching the winner on a unique-constraint race. See
// migrations/add_client_temp_id.sql for the backing column + index.
//
// reply_to: resolved here via withReplyTo() (mirrors listMessages' own
// replyToMap lookup) so both the HTTP response AND the realtime broadcast
// carry the real reply_to payload instead of always sending null — this
// is what fixes the reply chip disappearing on the sender's own device.

export async function sendMessage(
  supabase: SupabaseClient,
  conversationId: number,
  userId: number,
  input: { body?: string; type?: string; shared_post_id?: number; reply_to_id?: number; media_key?: string; media_type?: string; client_temp_id?: string },
) {
  const gate = await assertCanSend(supabase, conversationId, userId);
  if ("unauthorized" in gate) return { unauthorized: true as const };
  if ("blocked" in gate) return { blocked: true as const };
  if ("requestLimitReached" in gate) return { requestLimitReached: true as const };

  const selectClause = `*, sender:users!messages_sender_id_foreign(id, name, username, avatar_key, avatar)`;

  if (input.client_temp_id) {
    const { data: existing } = await supabase
      .from("messages")
      .select(selectClause)
      .eq("conversation_id", conversationId)
      .eq("sender_id", userId)
      .eq("client_temp_id", input.client_temp_id)
      .maybeSingle();
    if (existing) return { message: formatMessage(await withReplyTo(supabase, existing)) };
  }

  const type = input.type ?? "text";

  const { data: message, error } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      sender_id: userId,
      type,
      body: input.body ?? null,
      shared_post_id: input.shared_post_id ?? null,
      reply_to_id: input.reply_to_id ?? null,
      media_key: input.media_key ?? null,
      media_type: input.media_type ?? null,
      client_temp_id: input.client_temp_id ?? null,
    })
    .select(selectClause)
    .single();

  if (error) {
    // Unique-violation race: two concurrent requests with the same
    // client_temp_id both missed the pre-check above (manual retry firing
    // the same instant as an offline-queue flush). Whoever loses the race
    // just fetches the winner's row instead of surfacing a 500.
    if ((error as any).code === "23505" && input.client_temp_id) {
      const { data: winner } = await supabase
        .from("messages")
        .select(selectClause)
        .eq("conversation_id", conversationId)
        .eq("sender_id", userId)
        .eq("client_temp_id", input.client_temp_id)
        .single();
      if (winner) return { message: formatMessage(await withReplyTo(supabase, winner)) };
    }
    throw error;
  }

  const { data: conv } = await supabase
    .from("conversations")
    .select("messages_count, type, title")
    .eq("id", conversationId)
    .single();

  const lastMessageAt = new Date().toISOString();
  const previewBody = message.body ?? `[${message.type}]`;

  await supabase.from("conversations").update({
    last_message_body: previewBody,
    last_message_at: lastMessageAt,
    last_message_by: userId,
    messages_count: (conv?.messages_count ?? 0) + 1,
  }).eq("id", conversationId);

  for (const p of gate.others) {
    const newUnreadCount = (p.unread_count ?? 0) + 1;

    await supabase.from("conversation_participants")
      .update({ unread_count: newUnreadCount })
      .eq("id", p.id);

    await broadcastToUser(supabase, p.user_id, "inbox_update", {
      conversation_id: conversationId,
      last_message_body: previewBody,
      last_message_at: lastMessageAt,
      unread_count: newUnreadCount,
    });

    if (!p.is_muted) {
      await notifyMessage(supabase, {
        conversationId,
        senderId: userId,
        senderName: message.sender?.name ?? "Someone",
        recipientId: p.user_id,
        message: { body: message.body, type: message.type },
        conversationTitle: conv?.type !== "direct" ? conv?.title ?? null : null,
      });
    }
  }

  const formatted = formatMessage(await withReplyTo(supabase, message));
  await broadcastToConversation(supabase, conversationId, "new_message", formatted);

  return { message: formatted };
}

// Resolves { id, body, sender_id } for a message's reply_to_id, the same
// way listMessages' replyToMap does — used so sendMessage's HTTP response
// and its realtime broadcast both carry real reply data instead of null.
async function withReplyTo(supabase: SupabaseClient, m: any) {
  if (!m.reply_to_id) return m;
  const { data: reply } = await supabase
    .from("messages")
    .select("id, body, sender_id")
    .eq("id", m.reply_to_id)
    .maybeSingle();
  return { ...m, replyTo: reply ?? null };
}

// ─── Respond to a message request ─────────────────────────────────────────

export async function respondToRequest(
  supabase: SupabaseClient,
  conversationId: number,
  userId: number,
  action: "accept" | "decline" | "block",
) {
  const { data: participant } = await supabase
    .from("conversation_participants").select("*").eq("conversation_id", conversationId).eq("user_id", userId).maybeSingle();
  if (!participant) return { unauthorized: true as const };

  if (action === "accept") {
    await supabase.from("conversation_participants").update({ request_status: "accepted" }).eq("id", participant.id);
    return { status: "accepted" as const };
  }

  if (action === "decline") {
    await supabase.from("conversation_participants").update({ request_status: "declined" }).eq("id", participant.id);
    return { status: "declined" as const };
  }

  const { data: others } = await supabase
    .from("conversation_participants").select("user_id").eq("conversation_id", conversationId).neq("user_id", userId);

  for (const other of others ?? []) {
    const { toggleBlock } = await import("./blockService.ts");
    await toggleBlock(supabase, userId, other.user_id);
  }

  return { status: "blocked" as const };
}

// ─── React ─────────────────────────────────────────────────────────────────

export async function toggleReaction(supabase: SupabaseClient, conversationId: number, messageId: number, userId: number, emoji: string) {
  const { data: participant } = await supabase
    .from("conversation_participants").select("id").eq("conversation_id", conversationId).eq("user_id", userId).maybeSingle();
  if (!participant) return { unauthorized: true as const };

  const { data: message, error } = await supabase.from("messages").select("reactions").eq("id", messageId).eq("conversation_id", conversationId).maybeSingle();
  if (error) throw error;
  if (!message) return { notFound: true as const };

  const reactions: Record<string, number[]> = message.reactions ?? {};
  const users = reactions[emoji] ?? [];

  if (users.includes(userId)) {
    reactions[emoji] = users.filter((id) => id !== userId);
    if (reactions[emoji].length === 0) delete reactions[emoji];
  } else {
    reactions[emoji] = [...users, userId];
  }

  await supabase.from("messages").update({ reactions }).eq("id", messageId);
  await broadcastToConversation(supabase, conversationId, "reaction_updated", { message_id: messageId, reactions });

  return { reactions };
}

// ─── Read receipts ───────────────────────────────────────────────────────

export async function markMessagesRead(
  supabase: SupabaseClient,
  conversationId: number,
  userId: number,
  messageIds: number[] | null,
  upToMessageId: number | null,
) {
  const { data: participant } = await supabase
    .from("conversation_participants").select("id").eq("conversation_id", conversationId).eq("user_id", userId).maybeSingle();
  if (!participant) return { unauthorized: true as const };

  let ids: number[] = [];

  if (upToMessageId) {
    const { data } = await supabase.from("messages").select("id")
      .eq("conversation_id", conversationId).lte("id", upToMessageId).neq("sender_id", userId);
    ids = (data ?? []).map((m: any) => m.id);
  } else if (messageIds?.length) {
    ids = messageIds;
  }

  if (ids.length) {
    await supabase.from("message_receipts").upsert(
      ids.map((id) => ({ message_id: id, user_id: userId, read_at: new Date().toISOString() })),
      { onConflict: "message_id,user_id" },
    );
  }

  await supabase.from("conversation_participants").update({ unread_count: 0, last_read_at: new Date().toISOString() }).eq("id", participant.id);

  return { ok: true as const };
}

// ─── Delete message ───────────────────────────────────────────────────────

export async function deleteMessage(supabase: SupabaseClient, conversationId: number, messageId: number, userId: number, scope: "me" | "everyone") {
  const { data: participant } = await supabase
    .from("conversation_participants").select("id").eq("conversation_id", conversationId).eq("user_id", userId).maybeSingle();
  if (!participant) return { unauthorized: true as const };

  const { data: message, error } = await supabase.from("messages").select("*").eq("id", messageId).eq("conversation_id", conversationId).maybeSingle();
  if (error) throw error;
  if (!message) return { notFound: true as const };

  if (scope === "everyone") {
    if (message.sender_id !== userId) return { notOwner: true as const };

    const ageMinutes = (Date.now() - new Date(message.created_at).getTime()) / 60_000;
    if (ageMinutes > 5) return { tooLate: true as const };

    await supabase.from("messages").update({
      body: null, media_key: null, deleted_at: new Date().toISOString(),
    }).eq("id", messageId);

    await broadcastToConversation(supabase, conversationId, "message_deleted", { message_id: messageId });

    return { everyone: true as const };
  }

  if (message.sender_id !== userId) return { cannotHide: true as const };

  await supabase.from("messages").update({ deleted_for_sender: true }).eq("id", messageId);
  return { me: true as const };
}

// ─── Format helpers ────────────────────────────────────────────────────────

function formatMessage(m: any) {
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    type: m.type,
    body: m.body,
    client_temp_id: m.client_temp_id ?? null,
    media_url: resolveAvatarUrl(m.media_key),
    media_type: m.media_type,
    reactions: m.reactions ?? {},
    reply_to: m.replyTo ? { id: m.replyTo.id, body: m.replyTo.body } : null,
    shared_post: m.sharedPost ? formatSharedPost(m.sharedPost) : null,
    sender: m.sender ? {
      id: m.sender.id, name: m.sender.name, username: m.sender.username,
      avatar: resolveAvatarUrl(m.sender.avatar_key ?? m.sender.avatar),
    } : null,
    created_at: m.created_at,
  };
}

function formatSharedPost(post: any) {
  const detail = Array.isArray(post.listingDetail) ? post.listingDetail[0] : post.listingDetail;
  const images = (post.media ?? []).filter((med: any) => med.media_type === "image");
  const first = images[0];

  const image = first ? resolveAvatarUrl(first.thumbnail_key || first.storage_key) : null;

  return {
    id: post.id,
    type: post.type,
    caption: post.caption,
    image,
    author: post.user ? {
      name: post.user.name,
      username: post.user.username,
      avatar: resolveAvatarUrl(post.user.avatar_key ?? post.user.avatar),
    } : null,
    listing: detail ? {
      price: detail.price_minor / 100,
      formatted_price: (detail.price_minor / 100).toLocaleString(),
      status: detail.status,
    } : null,
  };
}

export async function setConversationMuted(
  supabase: SupabaseClient,
  conversationId: number,
  userId: number,
  isMuted: boolean
) {
  const { data: participant, error: fetchErr } = await supabase
    .from("conversation_participants")
    .select("id, is_muted")
    .eq("conversation_id", conversationId)
    .eq("user_id", userId)
    .maybeSingle();

  if (fetchErr) throw fetchErr;
  if (!participant) return { unauthorized: true as const };

  const { error: updateErr } = await supabase
    .from("conversation_participants")
    .update({ is_muted: isMuted })
    .eq("id", participant.id);

  if (updateErr) throw updateErr;

  return { success: true, conversation_id: conversationId, is_muted: isMuted };
}