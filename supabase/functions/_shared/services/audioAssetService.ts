import type { SupabaseClient } from "../auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
// Same fallback order as feedService.ts's R2_PUBLIC_URL/CDN_BASE_URL — and
// now also matches feedService.ts's behavior of falling back to Supabase's
// own storage URL when neither is set, instead of silently returning null.
// A null url here is exactly what made My Sounds / creation preview go
// silent even though the file was actually sitting in R2 the whole time.
const CDN_BASE = Deno.env.get("R2_PUBLIC_URL") ?? Deno.env.get("CDN_BASE_URL") ?? "";
const STORAGE_BUCKET = Deno.env.get("STORAGE_BUCKET") ?? "media";

export class AudioValidationError extends Error {
  errors: Record<string, string>;
  constructor(errors: Record<string, string>) {
    super("Validation failed.");
    this.errors = errors;
  }
}

function publicUrl(key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.startsWith("http://") || key.startsWith("https://")) return key;
  const cleanKey = key.replace(/^\/+/, "");
  if (CDN_BASE) {
    return `${CDN_BASE.replace(/\/+$/, "")}/${cleanKey}`;
  }
  if (!SUPABASE_URL) return null;
  return `${SUPABASE_URL.replace(/\/+$/, "")}/storage/v1/object/public/${STORAGE_BUCKET}/${cleanKey}`;
}

export async function createAudioAsset(
  supabase: SupabaseClient,
  userId: number,
  input: {
    name: string;
    storage_key: string;
    mime_type?: string;
    // Length of the CROPPED CLIP the user intends to reuse — not the
    // length of the uploaded source file. The uploaded file is never
    // physically trimmed; this plus source_start_ms is the trim window.
    duration_ms: number;
    // Offset in ms into the uploaded source file where the clip begins.
    // Defaults to 0 (start of file) for callers that don't crop.
    source_start_ms?: number;
    file_size?: number;
  }
) {
  if (!input.storage_key.startsWith(`${userId}/`)) {
    throw new AudioValidationError({ storage_key: "File does not belong to this user." });
  }

  const rawName = input.name?.trim() ?? "";
  const finalName = rawName.length > 0 ? rawName : "Untitled Audio";

  if (input.duration_ms <= 0) {
    throw new AudioValidationError({ duration_ms: "Duration must be positive." });
  }

  const sourceStartMs = input.source_start_ms ?? 0;
  if (sourceStartMs < 0) {
    throw new AudioValidationError({ source_start_ms: "Must not be negative." });
  }

  const { data, error } = await supabase
    .from("audio_assets")
    .insert({
      user_id: userId,
      name: finalName,
      storage_key: input.storage_key,
      mime_type: input.mime_type ?? null,
      duration_ms: input.duration_ms,
      source_start_ms: sourceStartMs,
      file_size: input.file_size ?? null,
    })
    .select()
    .single();

  if (error) throw error;
  return { asset: formatAudioAsset(data) };
}

export async function listAudioAssets(supabase: SupabaseClient, userId: number) {
  const { data, error } = await supabase
    .from("audio_assets")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return { assets: (data ?? []).map(formatAudioAsset) };
}

export async function deleteAudioAsset(supabase: SupabaseClient, userId: number, assetId: number) {
  const { data: asset, error } = await supabase
    .from("audio_assets")
    .select("id, user_id, storage_key")
    .eq("id", assetId)
    .maybeSingle();

  if (error) throw error;
  if (!asset) return { notFound: true as const };
  if (asset.user_id !== userId) return { unauthorized: true as const };

  const { count } = await supabase
    .from("posts")
    .select("*", { count: "exact", head: true })
    .eq("audio_asset_id", assetId);

  if (count && count > 0) {
    throw new AudioValidationError({ asset: "Cannot delete audio attached to published content." });
  }

  await supabase.from("audio_assets").delete().eq("id", assetId);
  return { ok: true as const };
}

export async function verifyAudioAssetOwnership(
  supabase: SupabaseClient,
  userId: number,
  assetId: number
): Promise<boolean> {
  const { data, error } = await supabase
    .from("audio_assets")
    .select("id, user_id")
    .eq("id", assetId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return false;
  return data.user_id === userId;
}

export function formatAudioAsset(asset: any) {
  return {
    id: asset.id,
    user_id: asset.user_id,
    name: asset.name,
    url: publicUrl(asset.storage_key),
    storage_key: asset.storage_key,
    mime_type: asset.mime_type,
    duration_ms: asset.duration_ms,
    source_start_ms: asset.source_start_ms ?? 0,
    file_size: asset.file_size,
    created_at: asset.created_at,
  };
}

export async function batchAttachAudio(supabase: SupabaseClient, posts: any[]) {
  const ids = [...new Set(posts.map((p: any) => p.audio_asset_id).filter(Boolean))];
  if (!ids.length) return;
  const { data } = await supabase.from("audio_assets").select("*").in("id", ids);
  const map = new Map((data ?? []).map((a: any) => [a.id, a]));
  for (const p of posts) p._audioAsset = map.get(p.audio_asset_id) ?? null;
}