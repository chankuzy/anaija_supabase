import type { SupabaseClient } from "../auth.ts";
import { canViewPost } from "./contentAccess.ts";

const COLS = "id, user_id, visibility, institution_id, context, community_id, community_feed";

/** ok=false means "treat as not found". A missing post stays ok so the handler keeps its own 404. */
export async function postGate(supabase: SupabaseClient, viewerId: number, postId: number): Promise<{ ok: boolean; community: boolean }> {
  const { data, error } = await supabase.from("posts").select(COLS).eq("id", postId).maybeSingle();
  if (error) throw error;
  if (!data) return { ok: true, community: false };
  return { ok: await canViewPost(supabase, viewerId, data), community: !!data.community_id };
}

/** Drops community posts the viewer is no longer a member of (bookmarks / liked lists). */
export async function keepAccessible<T>(
  supabase: SupabaseClient, viewerId: number, items: T[], postOf: (t: T) => any,
): Promise<T[]> {
  const ids = [...new Set(items.map(postOf).filter((p) => p?.community_id).map((p) => p.community_id as number))];
  if (!ids.length) return items;
  const { data } = await supabase.from("community_members").select("community_id").eq("user_id", viewerId).in("community_id", ids);
  const mine = new Set((data ?? []).map((m: any) => m.community_id));
  return items.filter((t) => {
    const p = postOf(t);
    return !p?.community_id || mine.has(p.community_id);
  });
}
