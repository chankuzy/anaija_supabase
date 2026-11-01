import type { SupabaseClient } from "../auth.ts";
import { resolveAvatarUrl } from "../avatar.ts";

export interface Face { id: number; name: string | null; username: string | null; avatar: string | null }

const USER = "id, name, username, avatar_key, avatar, institution_id, is_verified, campus_verified";
const SEL = `user_id, role, joined_at, user:users!community_members_user_id_fkey(${USER})`;
const ROLE_BONUS: Record<string, number> = { owner: 12, admin: 10, moderator: 8 };

/** A handful of faces for the header. Cheap on huge communities: a bounded candidate pool, then a score. */
export async function getFacePile(supabase: SupabaseClient, communityId: number, viewerId: number | null, limit = 5): Promise<Face[]> {
  const members = () => supabase.from("community_members").select(SEL).eq("community_id", communityId);
  const [recent, staff, me] = await Promise.all([
    members().order("joined_at", { ascending: false }).limit(120),
    members().neq("role", "member").limit(12),
    viewerId ? supabase.from("users").select("institution_id").eq("id", viewerId).maybeSingle() : Promise.resolve({ data: null as any }),
  ]);

  const pool = new Map<number, any>();
  for (const r of [...(staff.data ?? []), ...(recent.data ?? [])]) if (r.user) pool.set(r.user.id, r);

  const following = new Set<number>();
  const followers = new Set<number>();
  if (viewerId) {
    const { data: fol } = await supabase.from("follows").select("following_id").eq("follower_id", viewerId).limit(500);
    const ids = (fol ?? []).map((f: any) => f.following_id as number);
    ids.forEach((i) => following.add(i));
    if (ids.length) {
      // People you follow who are in this community, even if they joined long ago.
      const { data: fm } = await members().in("user_id", ids).limit(30);
      for (const r of fm ?? []) if (r.user) pool.set(r.user.id, r);
    }
    const pooled = [...pool.keys()];
    if (pooled.length) {
      const { data: back } = await supabase.from("follows").select("follower_id")
        .eq("following_id", viewerId).in("follower_id", pooled);
      for (const b of back ?? []) followers.add(b.follower_id);
    }
  }

  const campus = (me.data as any)?.institution_id ?? null;
  const scored = [...pool.values()]
    .filter((r) => r.user.id !== viewerId)
    .map((r, i) => {
      const u = r.user;
      const score =
        (following.has(u.id) ? 60 : 0) + (followers.has(u.id) ? 25 : 0) +
        (campus && u.institution_id === campus ? 15 : 0) +
        (ROLE_BONUS[r.role] ?? 0) + (u.is_verified || u.campus_verified ? 4 : 0) +
        (u.avatar_key ?? u.avatar ? 30 : -100) - i * 0.01;
      return { u, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(({ u }) => ({ id: u.id, name: u.name, username: u.username, avatar: resolveAvatarUrl(u.avatar_key ?? u.avatar) }));
}
