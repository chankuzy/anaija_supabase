import type { SupabaseClient } from "../auth.ts";
import { broadcastToConversation, broadcastToUser } from "./realtimeService.ts";
import { resolveAvatarUrl } from "../avatar.ts";
import { isBlockedEitherWay, getFollowStatus } from "./blockService.ts";

const PAGE_SIZE = 30;

// ─── Inbox ──────────────────────────────────────────────────────────────

export async function getInbox(supabase: SupabaseClient, userId: number) {
  const { data: myRows, error: myErr } = await supabase
    .from("conversation_participants")
    .select("conversation_id, unread_count, is_muted, request_status, cleared_at")
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
      last_message_body: isCleared(mine?.cleared_at, c.last_message_at) ? null : c.last_message_body,
      last_message_at: c.last_message_at,
      unread_count: isCleared(mine?.cleared_at, c.last_message_at) ? 0 : (mine?.unread_count ?? 0),
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
      sharedPost:posts(*, user:users!posts_user_id_foreign(id, name, username, avatar_key, avatar), listingDetail:listing_details(*), media:post_media(*))
    `)
    .eq("conversation_id", conversationId)
    .lt("id", cursorId)
    .gt("created_at", participant.cleared_at ?? "1970-01-01T00:00:00Z")
    .order("id", { ascending: false })
    .limit(PAGE_SIZE);

  if (error) throw error;

  const msgIds = (rows ?? []).map((m: any) => m.id);
  const deletedForMe = new Set<number>();
  if (msgIds.length) {
    const { data: myDeletions } = await supabase
      .from("message_deletions")
      .select("message_id")
      .eq("user_id", userId)
      .in("message_id", msgIds);
    for (const d of myDeletions ?? []) deletedForMe.add(d.message_id);
  }

  const messages = (rows ?? [])
    .filter((m: any) => !deletedForMe.has(m.id) && !(m.deleted_for_sender && m.sender_id === userId))
    .slice()
    .reverse();
  const hasMore = messages.length === PAGE_SIZE;

  const replyToIds = [...new Set(messages.filter((m: any) => m.reply_to_id).map((m: any) => m.reply_to_id))];
  const replyToMap = new Map<number, any>();
  if (replyToIds.length) {
    const { data: replies } = await supabase.from("messages").select("id, body, sender_id, type, deleted_at").in("id", replyToIds);
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

  const isMediaType = ["image", "video", "file", "audio"].includes(input.type ?? "");
  if (
    isMediaType !== !!input.media_key ||
    (input.media_key && (!input.media_key.startsWith(`${userId}/`) || input.media_key.includes("..")))
  ) {
    return { invalidMedia: true as const };
  }

  const selectClause = `*, sender:users!messages_sender_id_foreign(id, name, username, avatar_key, avatar), sharedPost:posts(*, user:users!posts_user_id_foreign(id, name, username, avatar_key, avatar), listingDetail:listing_details(*), media:post_media(*))`;

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
  const previewBody = message.type === "file" ? "Sent a file" : message.body ?? (message.type === "post_share"
    ? (message.sharedPost?.type === "listing" ? "Shared a listing" : "Shared a post")
    : message.type === "audio"
    ? "🎵 Voice message"
    : `[${message.type}]`);

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
    .select("id, body, sender_id, type, deleted_at")
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
      body: null, media_key: null, shared_post_id: null, deleted_at: new Date().toISOString(),
    }).eq("id", messageId);

    const { data: conv } = await supabase.from("conversations").select("last_message_at").eq("id", conversationId).single();
    if (conv && conv.last_message_at === message.created_at) {
      await supabase.from("conversations").update({ last_message_body: "This message was deleted" }).eq("id", conversationId);
    }

    await broadcastToConversation(supabase, conversationId, "message_deleted", { message_id: messageId });

    return { everyone: true as const };
  }

  // Delete for me: record per-user deletion
  if (message.sender_id === userId) {
    await supabase.from("messages").update({ deleted_for_sender: true }).eq("id", messageId);
  }
  await supabase.from("message_deletions").upsert(
    { message_id: messageId, user_id: userId, created_at: new Date().toISOString() },
    { onConflict: "message_id,user_id" },
  );

  return { me: true as const };
}

// ─── Edit message ─────────────────────────────────────────────────────────

export async function updateMessage(
  supabase: SupabaseClient,
  conversationId: number,
  messageId: number,
  userId: number,
  input: { body: string },
) {
  const { data: participant } = await supabase
    .from("conversation_participants").select("id").eq("conversation_id", conversationId).eq("user_id", userId).maybeSingle();
  if (!participant) return { unauthorized: true as const };

  const { data: message, error } = await supabase.from("messages").select("*").eq("id", messageId).eq("conversation_id", conversationId).maybeSingle();
  if (error) throw error;
  if (!message) return { notFound: true as const };

  if (message.sender_id !== userId) return { notOwner: true as const };
  if (message.deleted_at) return { deleted: true as const };
  if (message.type !== "text") return { notEditable: true as const };

  const ageMinutes = (Date.now() - new Date(message.created_at).getTime()) / 60_000;
  if (ageMinutes > 15) return { tooLate: true as const };

  const newBody = input.body?.trim();
  if (!newBody) return { invalidBody: true as const };

  const now = new Date().toISOString();
  const selectClause = `*, sender:users!messages_sender_id_foreign(id, name, username, avatar_key, avatar), sharedPost:posts(*, user:users!posts_user_id_foreign(id, name, username, avatar_key, avatar), listingDetail:listing_details(*), media:post_media(*))`;

  const { data: updated, error: updateErr } = await supabase
    .from("messages")
    .update({ body: newBody, updated_at: now })
    .eq("id", messageId)
    .select(selectClause)
    .single();
  if (updateErr) throw updateErr;

  const { data: conv } = await supabase.from("conversations").select("last_message_at").eq("id", conversationId).single();
  if (conv && conv.last_message_at === message.created_at) {
    await supabase.from("conversations").update({ last_message_body: newBody }).eq("id", conversationId);
  }

  const formatted = formatMessage(await withReplyTo(supabase, updated));
  await broadcastToConversation(supabase, conversationId, "message_edited", {
    message_id: messageId,
    body: newBody,
    updated_at: now,
    message: formatted,
  });

  return { message: formatted };
}

// ─── Format helpers ────────────────────────────────────────────────────────

// Media originals have no body; give the reply chip a readable label.
function replyBodyFor(r: any): string | null {
  if (r.deleted_at) return "Message deleted";
  if (r.body) return r.body;
  switch (r.type) {
    case "image": return "Photo";
    case "video": return "Video";
    case "audio": return "Voice message";
    case "file": return "File";
    case "post_share": return "Shared a post";
    case "listing_share": return "Shared a listing";
    default: return null;
  }
}

function formatMessage(m: any) {
  return {
    id: m.id,
    conversation_id: m.conversation_id,
    type: m.type,
    body: m.body,
    is_deleted: !!m.deleted_at,
    is_edited: !!(m.updated_at && m.updated_at !== m.created_at),
    edited_at: m.updated_at ?? null,
    client_temp_id: m.client_temp_id ?? null,
    media_url: resolveAvatarUrl(m.media_key),
    media_type: m.media_type,
    reactions: m.reactions ?? {},
    reply_to: m.replyTo ? { id: m.replyTo.id, body: replyBodyFor(m.replyTo) } : null,
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
  const media = (post.media ?? []).slice().sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const visual = media.filter((med: any) => med.media_type === "image" || med.media_type === "video");
  const first = visual[0];
  const isVideo = first?.media_type === "video";

  const imageKey = first
    ? (first.thumbnail_key || (first.media_type === "image" ? first.storage_key : null))
    : null;
  const image = resolveAvatarUrl(imageKey || post.thumbnail_key || null);

  return {
    id: post.id,
    type: post.type,
    subtype: post.subtype ?? null,
    caption: post.caption,
    image,
    is_video: isVideo,
    media_count: visual.length,
    unavailable: !post.is_active || !!post.deleted_at,
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

// ─── Clear chat / info / shared media ──────────────────────────────────────

function asUtcMs(v: string | null | undefined): number {
  if (!v) return 0;
  return new Date(/[zZ]$|[+-]\d\d(:?\d\d)?$/.test(v) ? v : `${v}Z`).getTime();
}

function isCleared(clearedAt: string | null | undefined, lastAt: string | null | undefined): boolean {
  return !!clearedAt && asUtcMs(clearedAt) >= asUtcMs(lastAt);
}

export async function clearConversation(supabase: SupabaseClient, conversationId: number, userId: number) {
  const { data: p } = await supabase
    .from("conversation_participants").select("id")
    .eq("conversation_id", conversationId).eq("user_id", userId).maybeSingle();
  if (!p) return { unauthorized: true as const };

  const { error } = await supabase.from("conversation_participants")
    .update({ cleared_at: new Date().toISOString(), unread_count: 0 })
    .eq("id", p.id);
  if (error) throw error;
  return { ok: true as const };
}

export async function getConversationInfo(
  supabase: SupabaseClient, conversationId: number, userId: number, withMedia: boolean,
) {
  const { data: me } = await supabase
    .from("conversation_participants").select("is_muted, cleared_at")

    .eq("conversation_id", conversationId).eq("user_id", userId).maybeSingle();
  if (!me) return { unauthorized: true as const };

  const { data: others } = await supabase
    .from("conversation_participants").select("user_id")
    .eq("conversation_id", conversationId).neq("user_id", userId);
  const peerId: number | null = others?.[0]?.user_id ?? null;

  let lastSeen: string | null = null;
  if (peerId && !(await isBlockedEitherWay(supabase, userId, peerId))) {
    const { data: pr } = await supabase
      .from("user_presence").select("updated_at").eq("user_id", peerId).maybeSingle();
    if (pr?.updated_at) lastSeen = new Date(asUtcMs(pr.updated_at)).toISOString();
  }

  const out: any = { is_muted: me.is_muted ?? false, peer_last_seen_at: lastSeen };

  if (withMedia) {
    const { data: rows, error } = await supabase
      .from("messages")
      .select(`id, type, body, media_key, media_type, created_at, sender_id, deleted_for_sender,
        sharedPost:posts(*, user:users!posts_user_id_foreign(id, name, username, avatar_key, avatar), listingDetail:listing_details(*), media:post_media(*))`)
      .eq("conversation_id", conversationId)
      .gt("created_at", me.cleared_at ?? "1970-01-01T00:00:00Z")
      .is("deleted_at", null)
      .or("media_key.not.is.null,shared_post_id.not.is.null")
      .order("id", { ascending: false })
      .limit(120);
    if (error) throw error;

    out.items = (rows ?? [])
      .filter((r: any) => !(r.deleted_for_sender && r.sender_id === userId))

      .map((r: any) => {
        if (r.media_key) {
          const kind = r.type === "video" ? "video" : r.type === "file" ? "file" : "image";
          return { message_id: r.id, kind, url: resolveAvatarUrl(r.media_key), name: r.body ?? null, created_at: r.created_at };
        }
        const sp = r.sharedPost;
        if (!sp || sp.type === "story" || !sp.is_active || sp.deleted_at) return null;
        return { message_id: r.id, kind: "post", created_at: r.created_at, post: formatSharedPost(sp) };
      })
      .filter(Boolean);
  }

  return out;
}
