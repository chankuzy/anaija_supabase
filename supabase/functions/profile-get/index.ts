/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError, SupabaseClient } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { resolveAvatarUrl } from "../_shared/avatar.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);

    const { data: user, error } = await supabase
      .from("users")
      .select("*, institution:institutions(id, name, short_name, slug)")
      .eq("id", userId)
      .single();

    if (error) throw error;

    const { count: unreadCount, error: countError } = await supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .is("read_at", null);

    if (countError) throw countError;

    return json(await formatFullProfile(supabase, user, unreadCount ?? 0));
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});

async function formatFullProfile(supabase: SupabaseClient, user: any, unreadCount: number) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    phone: user.phone,
    bio: user.bio,
    tagline: user.tagline ?? null, // NEW
    avatar: resolveAvatarUrl(user.avatar_key ?? user.avatar),
    cover: resolveAvatarUrl(user.cover_key ?? user.cover_url), // NEW
    location: user.location,
    links: user.links ?? [],
    is_verified: user.is_verified,
    campus_verified: user.campus_verified,
    profile_completed: user.profile_completed,
    provider: user.provider,
    institution: user.institution ? {
      id: user.institution.id,
      name: user.institution.name,
      short_name: user.institution.short_name,
    } : null,
    faculty: user.faculty,
    level: user.level,
    campus_role: user.campus_role,
    unread_notifications: unreadCount,
  };
}