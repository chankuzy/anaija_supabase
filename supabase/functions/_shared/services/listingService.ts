import type { SupabaseClient } from "../auth.ts";
import { formatListing, getLikedIds, getBookmarkedIds } from "./feedService.ts";
import { resolveAvatarUrl } from "../avatar.ts";

export const TYPE_LISTING_INQUIRY = "listing_inquiry";

// ─── Inquire ──────────────────────────────────────────────────────────────

export async function createInquiry(
  supabase: SupabaseClient,
  buyerId: number,
  buyerName: string,
  postId: number,
  message: string | null,
) {
  const { data: post, error: postErr } = await supabase
    .from("posts").select("id, user_id, type, listing_type, caption").eq("id", postId).maybeSingle();
  if (postErr) throw postErr;
  if (!post) return { notFound: true as const };
  if (post.type !== "listing") return { notAListing: true as const };
  if (post.user_id === buyerId) return { ownListing: true as const };

  const { data: detail, error: detailErr } = await supabase
    .from("listing_details").select("*").eq("post_id", postId).maybeSingle();
  if (detailErr) throw detailErr;
  if (!detail || detail.status !== "available") return { unavailable: true as const };
  if (post.listing_type === "business" && detail.accepting_orders === false) return { notAcceptingOrders: true as const };

  const { data: existing } = await supabase
    .from("listing_inquiries").select("id, conversation_id").eq("post_id", postId).eq("buyer_id", buyerId).maybeSingle();
  if (existing) return { duplicate: true as const, inquiry_id: existing.id, conversation_id: existing.conversation_id };

  const sellerId = post.user_id;

  // Find an existing direct conversation between buyer & seller (any listing).
  const { data: participantRows } = await supabase
    .from("conversation_participants").select("conversation_id").eq("user_id", buyerId);
  const buyerConvIds = (participantRows ?? []).map((r: any) => r.conversation_id);

  let conversationId: number | null = null;
  let conversationExisted = false;

  if (buyerConvIds.length) {
    const { data: sharedRows } = await supabase
      .from("conversation_participants").select("conversation_id")
      .eq("user_id", sellerId).in("conversation_id", buyerConvIds);
    if (sharedRows?.length) {
      conversationId = sharedRows[0].conversation_id;
      conversationExisted = true;
    }
  }

  if (!conversationId) {
    const { data: conv, error: convErr } = await supabase
      .from("conversations")
      .insert({ type: "listing_inquiry", last_message_at: new Date().toISOString(), last_message_by: buyerId })
      .select("id").single();
    if (convErr) throw convErr;
    conversationId = conv.id;

    await supabase.from("conversation_participants").insert([
      { conversation_id: conversationId, user_id: buyerId, role: "member", unread_count: 0 },
      { conversation_id: conversationId, user_id: sellerId, role: "member", unread_count: 0 },
    ]);
  }

  const { data: inquiry, error: inqErr } = await supabase
    .from("listing_inquiries")
    .insert({ post_id: postId, buyer_id: buyerId, seller_id: sellerId, status: "pending", message, conversation_id: conversationId })
    .select("id").single();
  if (inqErr) throw inqErr;

  const openingBody = message ?? `Hi, I'm interested in your listing: ${post.caption ?? ""}`;

  await supabase.from("messages").insert({
    conversation_id: conversationId, sender_id: buyerId, type: "listing_share", body: openingBody, shared_post_id: postId,
  });

  await supabase.from("conversations").update({
    last_message_body: openingBody, last_message_at: new Date().toISOString(), last_message_by: buyerId,
    messages_count: undefined, // bumped below via increment call
  }).eq("id", conversationId);

  const { data: conv } = await supabase.from("conversations").select("messages_count").eq("id", conversationId).single();
  await supabase.from("conversations").update({ messages_count: (conv?.messages_count ?? 0) + 1 }).eq("id", conversationId);

  const { data: participant } = await supabase.from("conversation_participants").select("unread_count")
    .eq("conversation_id", conversationId).eq("user_id", sellerId).single();
  await supabase.from("conversation_participants").update({ unread_count: (participant?.unread_count ?? 0) + 1 })
    .eq("conversation_id", conversationId).eq("user_id", sellerId);

  await supabase.from("listing_details").update({ inquiries_count: (detail.inquiries_count ?? 0) + 1 }).eq("post_id", postId);

  return {
    inquiry_id: inquiry.id,
    conversation_id: conversationId,
    existing_conversation: conversationExisted,
  };
}

// ─── Status transitions ────────────────────────────────────────────────────

async function requireOwnedListing(supabase: SupabaseClient, postId: number, userId: number) {
  const { data: post, error } = await supabase.from("posts").select("id, user_id, type").eq("id", postId).maybeSingle();
  if (error) throw error;
  if (!post) return { notFound: true as const };
  if (post.user_id !== userId) return { unauthorized: true as const };
  return { post };
}

export async function markAsSold(supabase: SupabaseClient, postId: number, userId: number) {
  const check = await requireOwnedListing(supabase, postId, userId);
  if ("notFound" in check || "unauthorized" in check) return check;
  if (check.post.type !== "listing") return { notAListing: true as const };

  await supabase.from("listing_details").update({ status: "sold" }).eq("post_id", postId);
  return { ok: true as const };
}

export async function markAsAvailable(supabase: SupabaseClient, postId: number, userId: number) {
  const check = await requireOwnedListing(supabase, postId, userId);
  if ("notFound" in check || "unauthorized" in check) return check;

  await supabase.from("listing_details").update({ status: "available" }).eq("post_id", postId);
  return { ok: true as const };
}

export async function markAsReserved(supabase: SupabaseClient, postId: number, userId: number) {
  const check = await requireOwnedListing(supabase, postId, userId);
  if ("notFound" in check || "unauthorized" in check) return check;

  await supabase.from("listing_details").update({ status: "reserved" }).eq("post_id", postId);
  return { ok: true as const };
}

// ─── Inquiries list (seller inbox) ─────────────────────────────────────────

export async function listInquiries(supabase: SupabaseClient, postId: number, userId: number, cdnBase: string) {
  const check = await requireOwnedListing(supabase, postId, userId);
  if ("notFound" in check || "unauthorized" in check) return check;

  // FIX: added `avatar` to the buyer select, and the avatar below now
  // goes through resolveAvatarUrl() with the avatar_key ?? avatar
  // fallback like everywhere else — was avatar_key-only before, and
  // built the URL by hand (`${cdnBase}/${avatar_key}`) instead of using
  // the shared resolver, so it also couldn't handle a buyer whose
  // avatar_key happens to already be a full http URL.
  const { data, error } = await supabase
    .from("listing_inquiries")
    .select("*, buyer:users!listing_inquiries_buyer_id_foreign(id, name, username, avatar_key, avatar), conversation:conversations(*)")
    .eq("post_id", postId)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) throw error;

  return {
    data: (data ?? []).map((i: any) => ({
      id: i.id,
      status: i.status,
      message: i.message,
      created_at: i.created_at,
      conversation_id: i.conversation_id,
      buyer: i.buyer ? {
        id: i.buyer.id, name: i.buyer.name, username: i.buyer.username,
        avatar: resolveAvatarUrl(i.buyer.avatar_key ?? i.buyer.avatar),
      } : null,
    })),
  };
}

// ─── Show single listing ───────────────────────────────────────────────────

export async function getListing(supabase: SupabaseClient, postId: number, viewerId: number, cdnBase: string) {
  // FIX: added `avatar` — was avatar_key only, so opening a listing
  // detail page for any user without a custom-uploaded avatar showed no
  // seller avatar at all.
  const { data: post, error } = await supabase
    .from("posts")
    .select("*, user:users(id, name, username, avatar_key, avatar), media:post_media(*), listingDetail:listing_details(*)")
    .eq("id", postId).maybeSingle();

  if (error) throw error;
  if (!post || post.type !== "listing" || !post.is_active) return { notFound: true as const };

  post.listingDetail = Array.isArray(post.listingDetail) ? post.listingDetail[0] : post.listingDetail;

  if (post.listingDetail) {
    await supabase.from("listing_details").update({ views_count: (post.listingDetail.views_count ?? 0) + 1 }).eq("post_id", postId);
  }

  const [{ count: inquiredCount }, likedSet, bookmarkedSet, followRow] = await Promise.all([
    supabase.from("listing_inquiries").select("*", { count: "exact", head: true }).eq("post_id", postId).eq("buyer_id", viewerId),
    getLikedIds(supabase, viewerId, [postId]),
    getBookmarkedIds(supabase, viewerId, [postId]),
    supabase.from("follows").select("id").eq("follower_id", viewerId).eq("following_id", post.user_id).maybeSingle(),
  ]);

  const formatted = await formatListing(
    supabase,
    post,
    cdnBase,
    !!followRow.data,
    likedSet.has(post.id),
    bookmarkedSet.has(post.id),
  );

  return { listing: { ...formatted, has_inquired: (inquiredCount ?? 0) > 0 } };
}