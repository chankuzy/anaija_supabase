import type { SupabaseClient } from "../auth.ts";
import { syncHashtags } from "./hashtagService.ts";

export const TYPE_POST = "post";
export const TYPE_STORY = "story";
export const TYPE_LISTING = "listing";

const LISTING_TYPES = ["product", "service", "business", "rental", "wanted"];
const CONDITION_TYPES = ["new", "like_new", "good", "fair", "poor"];

// R2's public dev URL — same value as CDN_BASE_URL, kept as its own env
// var here so this ownership check doesn't depend on feedService's export
// shape and can be reasoned about on its own.
const R2_PUBLIC_URL = Deno.env.get("R2_PUBLIC_URL") ?? Deno.env.get("CDN_BASE_URL") ?? "";

export class ValidationError extends Error {
  errors: Record<string, string>;
  constructor(errors: Record<string, string>) {
    super("Validation failed.");
    this.errors = errors;
  }
}

interface MediaInput {
  type: "video" | "image" | "audio";
  storage_key: string;
  thumbnail_key?: string;
  width?: number;
  height?: number;
  duration_seconds?: number;
  size_bytes?: number;
  mime_type?: string;
  blurhash?: string;
  dominant_color?: string;
  aspect_ratio?: number;
}

interface CreatePostInput {
  type?: string;
  subtype?: string;
  caption?: string;
  visibility?: string;
  hashtags?: string[];
  category_ids?: number[];
  expires_hours?: number;
  listing_type?: string;
  price?: number;
  currency?: string;
  price_type?: string;
  condition?: string;
  contact_preference?: string;
  contact_phone?: string;
  pickup_info?: string;
  quantity?: number;
  business_name?: string;
  business_description?: string;
  fulfillment_type?: string;
  accepting_orders?: boolean;
  delivery_available?: boolean;
  opening_hours?: Record<string, { open: string; close: string; closed: boolean }>;
  estimated_delivery?: number;
  service_radius_km?: number;
  minimum_order_price?: number;
  institution_id?: number;
  faculty?: string;
  level?: string;
  latitude?: number;
  longitude?: number;
  media?: MediaInput[];
  slideshow?: { enabled: boolean; interval_ms: number; transition: string };
  audio?: { enabled: boolean; title?: string; artist?: string; start_ms?: number; playback_duration_ms?: number };
}

// ─── Storage ownership check ────────────────────────────────────────────────
// Every uploaded path is namespaced "{userId}/{uuid}.ext" by storage-sign-upload,
// so ownership is provable from the path prefix alone. We additionally confirm
// the object was actually uploaded (not just a guessed/forged path) via a HEAD
// request against R2's public URL. R2 is a public bucket (same as the read
// path), so no signing is needed here, just a cheap existence check.
//
// Previously this ran one HEAD request at a time in a nested for-loop — for a
// 5-image gallery that's up to 10 sequential round-trips serialized into
// publish latency for no reason, since none of these checks depend on each
// other. Now every key across every media item is checked in parallel.
async function verifyMediaOwnership(supabase: SupabaseClient, userId: number, media: MediaInput[]) {
  if (!R2_PUBLIC_URL) {
    throw new Error("R2_PUBLIC_URL is not configured — cannot verify media ownership.");
  }

  const keysToCheck: string[] = [];
  for (const m of media) {
    if (!m.storage_key.startsWith(`${userId}/`)) {
      throw new ValidationError({ media: `File does not belong to this user: ${m.storage_key}` });
    }
    if (m.thumbnail_key && !m.thumbnail_key.startsWith(`${userId}/`)) {
      throw new ValidationError({ media: `Thumbnail does not belong to this user: ${m.thumbnail_key}` });
    }
    keysToCheck.push(m.storage_key);
    if (m.thumbnail_key) keysToCheck.push(m.thumbnail_key);
  }

  const results = await Promise.all(
    keysToCheck.map(async (key) => {
      const cleanKey = key.replace(/^\/+/, "");
      const headRes = await fetch(`${R2_PUBLIC_URL.replace(/\/+$/, "")}/${cleanKey}`, { method: "HEAD" });
      return { key, ok: headRes.ok };
    }),
  );

  const missing = results.find((r) => !r.ok);
  if (missing) {
    throw new ValidationError({ media: `File not found in storage: ${missing.key}` });
  }
}

export async function createPost(supabase: SupabaseClient, userId: number, user: any, input: CreatePostInput) {
  const type = input.type ?? TYPE_POST;
  if (![TYPE_POST, TYPE_STORY, TYPE_LISTING].includes(type)) {
    throw new ValidationError({ type: "Invalid content type." });
  }
  if (type === TYPE_LISTING) validateListing(input);
  if (input.media?.length) await verifyMediaOwnership(supabase, userId, input.media);

  const postData: Record<string, unknown> = {
    user_id: userId,
    type,
    subtype: input.subtype ?? null,
    listing_type: type === TYPE_LISTING ? (input.listing_type ?? "product") : null,
    caption: input.caption ?? null,
    allow_comments: true,
    allow_duet: type === TYPE_POST,
    hashtags: input.hashtags ?? [],
    visibility: input.visibility ?? "public",
    is_active: true,
    // Nothing async happens server-side anymore — client hands us finished media.
    processing_status: "ready",
    video_key: "",
    slideshow_config: input.slideshow ?? null,
    audio_config: input.audio ?? null,
  };

  if (type === TYPE_STORY) {
    const hours = input.expires_hours ?? 24;
    postData.expires_at = new Date(Date.now() + hours * 3600_000).toISOString();
    postData.allow_duet = false;
  }

  const institutionId = input.institution_id ?? user.institution_id;
  if (institutionId) {
    postData.context = {
      institution_id: institutionId,
      faculty: input.faculty ?? user.faculty ?? null,
      level: input.level ?? null,
    };
  }

  if (input.latitude !== undefined) {
    postData.latitude = input.latitude;
    postData.longitude = input.longitude;
  }

  const { data: post, error } = await supabase.from("posts").insert(postData).select().single();
  if (error) throw error;

  if (input.category_ids?.length) {
    await supabase.from("post_categories").insert(
      input.category_ids.map((id) => ({ post_id: post.id, category_id: id })),
    );
  }

  if (input.media?.length) {
    const { error: mediaError } = await supabase.from("post_media").insert(
      input.media.map((m, i) => ({
        post_id: post.id,
        media_type: m.type,
        storage_key: m.storage_key,
        thumbnail_key: m.thumbnail_key ?? null,
        width: m.width ?? null,
        height: m.height ?? null,
        duration_seconds: m.duration_seconds ?? null,
        size_bytes: m.size_bytes ?? null,
        mime_type: m.mime_type ?? null,
        blurhash: m.blurhash ?? null,
        dominant_color: m.dominant_color ?? null,
        aspect_ratio: m.aspect_ratio ?? null,
        // Already final — client did the processing. No pipeline to wait on.
        processing_status: "ready",
        optimized: true,
        sort_order: i,
      })),
    );
    if (mediaError) throw mediaError;
  }

  if (type === TYPE_LISTING) {
    await createListingDetail(supabase, post.id, input);
  }

  // Extension point: fan-out to followers' feeds, search indexing, etc.
  // Deliberately not built yet — see earlier note on deferred Redis/queue work.
  if (input.hashtags?.length) {
    await syncHashtags(supabase, input.hashtags);
  }

  return post;
}

function validateListing(input: CreatePostInput) {
  const errors: Record<string, string> = {};
  const listingType = input.listing_type ?? "product";

  if (input.listing_type && !LISTING_TYPES.includes(input.listing_type)) {
    errors.listing_type = "Invalid listing type.";
  }
  if (["product", "rental"].includes(listingType) && input.condition && !CONDITION_TYPES.includes(input.condition)) {
    errors.condition = "Invalid condition.";
  }
  if (Object.keys(errors).length) throw new ValidationError(errors);
}

async function createListingDetail(supabase: SupabaseClient, postId: number, input: CreatePostInput) {
  const listingType = input.listing_type ?? "product";
  const requiresCondition = ["product", "rental"].includes(listingType);

  const data: Record<string, unknown> = {
    post_id: postId,
    price_minor: Math.round((input.price ?? 0) * 100),
    currency: input.currency ?? "NGN",
    price_type: input.price_type ?? "negotiable",
    contact_preference: input.contact_preference ?? "chat",
    contact_phone: input.contact_phone ?? null,
    pickup_info: input.pickup_info ?? null,
    quantity: input.quantity ?? 1,
    business_name: input.business_name ?? null,
    business_description: input.business_description ?? null,
    fulfillment_type: input.fulfillment_type ?? null,
    accepting_orders: input.accepting_orders ?? null,
    delivery_available: input.delivery_available ?? false,
    opening_hours: input.opening_hours ?? null,
    estimated_delivery: input.estimated_delivery ?? null,
    service_radius_km: input.service_radius_km ?? null,
    minimum_order_price: input.minimum_order_price !== undefined
      ? Math.round(input.minimum_order_price * 100) : null,
  };

  if (requiresCondition && input.condition) data.condition = input.condition;

  const { error } = await supabase.from("listing_details").insert(data);
  if (error) throw error;
}

// ─── show / update / delete: unchanged from before ──────────────────────────

export async function getPost(supabase: SupabaseClient, postId: number, viewerId: number) {
  const { data: post, error } = await supabase
    .from("posts")
    .select("*, user:users(id, name, username, avatar_key), media:post_media(*)")
    .eq("id", postId)
    .maybeSingle();

  if (error) throw error;
  if (!post || !post.is_active || post.processing_status !== "ready") return { notFound: true as const };

  if (post.type === TYPE_STORY && post.expires_at && new Date(post.expires_at) < new Date()) {
    return { expired: true as const };
  }

  if (post.type === TYPE_LISTING) {
    const { data: detail } = await supabase.from("listing_details").select("*").eq("post_id", post.id).maybeSingle();
    post.listingDetail = detail;
  }

  const { count: likeCount } = await supabase.from("post_likes").select("*", { count: "exact", head: true })
    .eq("user_id", viewerId).eq("post_id", post.id);
  const { count: bmCount } = await supabase.from("bookmarks").select("*", { count: "exact", head: true })
    .eq("user_id", viewerId).eq("post_id", post.id);

  return { post, isLiked: (likeCount ?? 0) > 0, isBookmarked: (bmCount ?? 0) > 0 };
}

export async function updatePost(supabase: SupabaseClient, postId: number, userId: number, input: Record<string, unknown>) {
  const { data: post, error } = await supabase.from("posts").select("*").eq("id", postId).maybeSingle();
  if (error) throw error;
  if (!post) return { notFound: true as const };
  if (post.user_id !== userId) return { unauthorized: true as const };

  const updates: Record<string, unknown> = {};
  for (const field of ["caption", "allow_comments", "visibility", "hashtags"]) {
    if (input[field] !== undefined) updates[field] = input[field];
  }
  if (Object.keys(updates).length) await supabase.from("posts").update(updates).eq("id", postId);

  if (post.type === TYPE_LISTING) {
    const listingUpdates: Record<string, unknown> = {};
    if (input.price !== undefined) listingUpdates.price_minor = Math.round(Number(input.price) * 100);
    for (const field of ["price_type", "condition", "pickup_info", "contact_phone"]) {
      if (input[field] !== undefined) listingUpdates[field] = input[field];
    }
    if (Object.keys(listingUpdates).length) {
      await supabase.from("listing_details").update(listingUpdates).eq("post_id", postId);
    }
  }

  return { ok: true as const };
}

export async function deletePost(supabase: SupabaseClient, postId: number, userId: number) {
  const { data: post, error } = await supabase.from("posts").select("id, user_id").eq("id", postId).maybeSingle();
  if (error) throw error;
  if (!post) return { notFound: true as const };
  if (post.user_id !== userId) return { unauthorized: true as const };

  await supabase.from("posts").update({ is_active: false, deleted_at: new Date().toISOString() }).eq("id", postId);
  return { ok: true as const };
}