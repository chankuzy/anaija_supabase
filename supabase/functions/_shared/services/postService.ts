import type { SupabaseClient } from "../auth.ts";
import { syncHashtags } from "./hashtagService.ts";
import { batchAttachAudio } from "./audioAssetService.ts";

export const TYPE_POST = "post";
export const TYPE_STORY = "story";
export const TYPE_LISTING = "listing";

const LISTING_TYPES = ["product", "service", "business", "rental", "wanted"];
const CONDITION_TYPES = ["new", "like_new", "good", "fair", "poor"];

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
  audio_asset_id?: number;
  audio?: { enabled: boolean; start_ms?: number; playback_duration_ms?: number };
}

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

  // ── AUDIO ASSET OWNERSHIP ENFORCEMENT ──
  if (input.audio_asset_id) {
    const { data: asset, error: assetErr } = await supabase
      .from("audio_assets")
      .select("id, user_id")
      .eq("id", input.audio_asset_id)
      .maybeSingle();
    if (assetErr) throw assetErr;
    if (!asset) throw new ValidationError({ audio_asset_id: "Audio asset not found." });
    if (asset.user_id !== userId) throw new ValidationError({ audio_asset_id: "You do not own this audio asset." });
  }

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
    processing_status: "ready",
    video_key: "",
    slideshow_config: input.slideshow ?? null,
    audio_asset_id: input.audio_asset_id ?? null,
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

export async function getPost(supabase: SupabaseClient, postId: number, viewerId: number) {
  // FIX: added `avatar` — was avatar_key only, so a single-post view
  // (share links, notifications deep-link, etc) came back with no
  // author avatar for anyone who hasn't uploaded a custom one.
  const { data: post, error } = await supabase
    .from("posts")
    .select("*, user:users(id, name, username, avatar_key, avatar), media:post_media(*)")
    .eq("id", postId)
    .maybeSingle();

  if (error) throw error;
  if (!post || !post.is_active || post.processing_status !== "ready") return { notFound: true as const };

  // FIX: the inline audioAsset:audio_assets(*) join that used to live in
  // the .select() above did not reliably resolve (no auto-detectable FK
  // relationship) and silently returned nothing rather than erroring —
  // every post came back with audio.enabled=false regardless of whether
  // it actually had audio attached. batchAttachAudio is the same helper
  // every list endpoint (feed, users-posts, etc) already uses; a
  // single-element array is just this endpoint's equivalent of that.
  await batchAttachAudio(supabase, [post]);

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

  // ── AUDIO ASSET OWNERSHIP ON UPDATE ──
  if (input.audio_asset_id !== undefined) {
    if (input.audio_asset_id !== null) {
      const { data: asset } = await supabase
        .from("audio_assets")
        .select("user_id")
        .eq("id", input.audio_asset_id as number)
        .maybeSingle();
      if (!asset) throw new ValidationError({ audio_asset_id: "Audio asset not found." });
      if (asset.user_id !== userId) throw new ValidationError({ audio_asset_id: "Unauthorized." });
    }
    updates.audio_asset_id = input.audio_asset_id;
  }
  if (input.audio !== undefined) updates.audio_config = input.audio;

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