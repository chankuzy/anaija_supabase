import type { SupabaseClient } from "../auth.ts";
import { syncHashtags } from "./hashtagService.ts";
import { batchAttachAudio } from "./audioAssetService.ts";
import { MEDIA_LIMITS } from "../mediaLimits.ts";

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
  allow_comments?: boolean;
  allow_story_sharing?: boolean;
  client_request_id?: string;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeRequestId(raw: unknown): string | null {
  return typeof raw === "string" && UUID_RE.test(raw) ? raw.toLowerCase() : null;
}

// Stories never play sound longer than the cap, whatever the client sends.
function clampAudioConfig(type: string, audio: CreatePostInput["audio"]) {
  if (!audio) return null;
  const startMs = Math.max(0, Math.round(Number(audio.start_ms) || 0));
  let playMs = Math.round(Number(audio.playback_duration_ms) || 0);
  if (type === TYPE_STORY) {
    const cap = MEDIA_LIMITS.maxStoryAudioSeconds * 1000;
    playMs = playMs > 0 ? Math.min(playMs, cap) : cap;
  }
  return {
    enabled: audio.enabled !== false,
    start_ms: startMs,
    ...(playMs > 0 ? { playback_duration_ms: playMs } : {}),
  };
}

// Removes a post a previous attempt left half-built. If a hard delete is
// blocked (FKs), the row is deactivated AND its request id is freed so the
// retry can create a clean one.
async function discardPost(supabase: SupabaseClient, postId: number) {
  try {
    await supabase.from("post_categories").delete().eq("post_id", postId);
    await supabase.from("post_media").delete().eq("post_id", postId);
    await supabase.from("listing_details").delete().eq("post_id", postId);
    const del = await supabase.from("posts").delete().eq("id", postId);
    if (del.error) {
      await supabase.from("posts")
        .update({ is_active: false, deleted_at: new Date().toISOString(), client_request_id: null })
        .eq("id", postId);
    }
  } catch (e) {
    console.error("discardPost failed", e);
  }
}

// The post an earlier attempt created for this request id, or null. An
// attempt that died half-way (row without its media / listing detail) is
// discarded so the retry builds it properly instead of "succeeding" broken.
async function findByRequestId(supabase: SupabaseClient, userId: number, requestId: string, expectedMedia: number) {
  const { data: existing, error } = await supabase
    .from("posts").select("*")
    .eq("user_id", userId).eq("client_request_id", requestId).maybeSingle();
  if (error) throw error;
  if (!existing) return null;

  let complete = true;
  if (expectedMedia > 0) {
    const { count, error: cErr } = await supabase
      .from("post_media").select("*", { count: "exact", head: true }).eq("post_id", existing.id);
    if (cErr) throw cErr;
    if ((count ?? 0) < expectedMedia) complete = false;
  }
  if (complete && existing.type === TYPE_LISTING) {
    const { count, error: lErr } = await supabase
      .from("listing_details").select("*", { count: "exact", head: true }).eq("post_id", existing.id);
    if (lErr) throw lErr;
    if ((count ?? 0) < 1) complete = false;
  }
  if (!complete) {
    await discardPost(supabase, existing.id);
    return null;
  }
  return existing;
}

export async function createPost(
  supabase: SupabaseClient,
  userId: number,
  user: any,
  input: CreatePostInput,
  opts: { trustedSource?: boolean } = {},
) {
  const type = input.type ?? TYPE_POST;
  if (![TYPE_POST, TYPE_STORY, TYPE_LISTING].includes(type)) {
    throw new ValidationError({ type: "Invalid content type." });
  }

  // A retry of a request that already created its post (lost response, app
  // restart) gets that post back instead of a duplicate.
  const requestId = normalizeRequestId(input.client_request_id);
  const mediaCount = input.media?.length ?? 0;
  if (requestId) {
    const existing = await findByRequestId(supabase, userId, requestId, mediaCount);
    if (existing) return Object.assign(existing, { duplicate: true });
  }

  if (type === TYPE_LISTING) validateListing(input);
  if (input.media?.length && !opts.trustedSource) await verifyMediaOwnership(supabase, userId, input.media);

  // ── AUDIO ASSET OWNERSHIP ENFORCEMENT ──
  if (input.audio_asset_id && !opts.trustedSource) {
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
    // Real now — this used to be hardcoded true whatever the client sent.
    allow_comments: typeof input.allow_comments === "boolean" ? input.allow_comments : true,
    // null = follow the author's account-wide setting (users.allow_story_sharing).
    allow_story_sharing: typeof input.allow_story_sharing === "boolean" ? input.allow_story_sharing : null,
    allow_duet: type === TYPE_POST,
    hashtags: input.hashtags ?? [],
    visibility: input.visibility ?? "public",
    is_active: true,
    processing_status: "ready",
    video_key: "",
    slideshow_config: input.slideshow ?? null,
    audio_asset_id: input.audio_asset_id ?? null,
    audio_config: clampAudioConfig(type, input.audio),
    client_request_id: requestId,
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
  if (error) {
    // Lost a race with a concurrent attempt carrying the same request id.
    if (requestId && (error as { code?: string }).code === "23505") {
      const existing = await findByRequestId(supabase, userId, requestId, mediaCount);
      if (existing) return Object.assign(existing, { duplicate: true });
    }
    throw error;
  }

  try {
    if (input.category_ids?.length) {
      const { error: catError } = await supabase.from("post_categories").insert(
        input.category_ids.map((id) => ({ post_id: post.id, category_id: id })),
      );
      if (catError) throw catError;
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
  } catch (e) {
    // Never leave a half-built post behind: the retry would otherwise get
    // a "duplicate" that has no media.
    await discardPost(supabase, post.id);
    throw e;
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
  for (const field of ["caption", "allow_comments", "allow_story_sharing", "visibility", "hashtags"]) {
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