import type { SupabaseClient } from "../auth.ts";
import { canRead, loadAccess } from "./communityAccess.ts";

export interface Publisher { id: number; name: string; type: string; institution_id: number | null }

/** Same audiences as the feed: public / followers / campus / private (author only). */
export async function canViewPost(
  supabase: SupabaseClient,
  viewerId: number,
  post: { user_id: number; visibility: string; institution_id?: number | null; community_id?: number | null; community_feed?: boolean | null; context?: { institution_id?: number | null } | null },
): Promise<boolean> {
  if (post.user_id === viewerId) return true;
  if (post.community_id) {
    const a = await loadAccess(supabase, post.community_id, viewerId);
    if (!a || a.banned) return false;
    return post.community_feed === false ? !!a.role : canRead(a);
  }
  switch (post.visibility) {
    case "public":
      return true;
    case "followers": {
      const { count } = await supabase.from("follows").select("*", { count: "exact", head: true })
        .eq("follower_id", viewerId).eq("following_id", post.user_id);
      return (count ?? 0) > 0;
    }
    case "campus": {
      const { data: v } = await supabase.from("users").select("institution_id").eq("id", viewerId).maybeSingle();
      const inst = post.institution_id ?? post.context?.institution_id ?? null;
      return !!v?.institution_id && inst != null && Number(v.institution_id) === Number(inst);
    }
    default:
      return false;
  }
}

const COLS = "id, display_name, publisher_type, institution_id";
const shape = (r: any): Publisher => ({ id: r.id, name: r.display_name, type: r.publisher_type, institution_id: r.institution_id ?? null });

export async function listPublishers(supabase: SupabaseClient, userId: number): Promise<Publisher[]> {
  const { data, error } = await supabase.from("publisher_grants").select(COLS)
    .eq("user_id", userId).eq("can_announce", true).is("revoked_at", null).order("id");
  if (error) throw error;
  return (data ?? []).map(shape);
}

/** The identity, only if this user holds an active announce grant for it. */
export async function resolvePublisher(supabase: SupabaseClient, userId: number, publisherId: number | null): Promise<Publisher | null> {
  if (!publisherId) return null;
  const { data, error } = await supabase.from("publisher_grants").select(COLS)
    .eq("id", publisherId).eq("user_id", userId).eq("can_announce", true).is("revoked_at", null).maybeSingle();
  if (error) throw error;
  return data ? shape(data) : null;
}
