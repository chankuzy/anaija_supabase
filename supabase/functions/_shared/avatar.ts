import type { SupabaseClient } from "./auth.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";
const R2_PUBLIC_URL = Deno.env.get("R2_PUBLIC_URL") ?? CDN_BASE;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const STORAGE_BUCKET = Deno.env.get("STORAGE_BUCKET") ?? "media";

/**
 * Resolves a user's stored avatar into a URL the client can load
 * directly. Single source of truth for this — every place that used to
 * roll its own avatar-URL logic (userService, profile-get,
 * profile-update, feedService) now calls this instead.
 *
 * - A raw http(s) URL (Google/social-auth avatar, or any legacy full
 *   URL sitting in the `avatar` column) passes through unchanged.
 * - An R2 storage key ("{userId}/{uuid}.ext", same convention
 *   storage-sign-upload hands out and postService.verifyMediaOwnership
 *   checks) resolves to the CDN URL — no signing needed, R2 objects
 *   here are public-read behind the CDN, exactly like post media.
 * - Falls back to a direct Supabase Storage public URL only if
 *   CDN_BASE isn't configured — a local-dev safety net, not the normal
 *   path in any deployed environment.
 *
 * Callers should pass `avatar_key ?? avatar` (avatar_key wins when
 * both are present — it's the deliberately-uploaded one) so rows from
 * before avatar_key existed still resolve correctly.
 */
export function resolveAvatarUrl(rawKey: string | null | undefined): string | null {
  if (!rawKey) return null;
  if (rawKey.startsWith("http://") || rawKey.startsWith("https://")) return rawKey;

  const cleanKey = rawKey.replace(/^\/+/, "");
  if (CDN_BASE) return `${CDN_BASE.replace(/\/+$/, "")}/${cleanKey}`;
  if (!SUPABASE_URL) return null;
  return `${SUPABASE_URL.replace(/\/+$/, "")}/storage/v1/object/public/${STORAGE_BUCKET}/${cleanKey}`;
}

/**
 * HEAD-checks that an object actually exists in R2 — same pattern
 * postService.verifyMediaOwnership() uses for post media uploads.
 * profile-avatar uses this instead of the old (wrong-backend)
 * supabase.storage.list() call.
 */
export async function r2ObjectExists(key: string): Promise<boolean> {
  if (!R2_PUBLIC_URL) {
    throw new Error("R2_PUBLIC_URL (or CDN_BASE_URL) is not configured — cannot verify avatar upload.");
  }
  const cleanKey = key.replace(/^\/+/, "");
  const res = await fetch(`${R2_PUBLIC_URL.replace(/\/+$/, "")}/${cleanKey}`, { method: "HEAD" });
  return res.ok;
}