/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";

const USERNAME_REGEX = /^[a-zA-Z0-9_]+$/;
const ALLOWED_FIELDS = ["name", "username", "bio", "location", "links", "institution_id", "faculty", "level", "campus_role"] as const;

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const body = await req.json();

    // ── validation (mirrors the Laravel request rules) ──
    if (body.username !== undefined && body.username !== null) {
      const u = body.username;
      if (typeof u !== "string" || u.length < 3 || u.length > 30 || !USERNAME_REGEX.test(u)) {
        return json({ message: "Invalid username." }, 422);
      }
      const { data: taken, error: takenErr } = await supabase
        .from("users").select("id").eq("username", u).neq("id", userId).maybeSingle();
      if (takenErr) throw takenErr;
      if (taken) return json({ message: "Username is taken." }, 409);
    }

    if (body.links !== undefined && body.links !== null) {
      if (!Array.isArray(body.links) || body.links.length > 5) {
        return json({ message: "Links must be an array of up to 5 URLs." }, 422);
      }
    }

    // Build update payload, filtering to allowed fields + dropping nulls (matches array_filter in PHP)
    const updates: Record<string, unknown> = {};
    for (const field of ALLOWED_FIELDS) {
      if (body[field] !== undefined && body[field] !== null) {
        updates[field] = body[field];
      }
    }

    const { data: updated, error: updateError } = await supabase
      .from("users").update(updates).eq("id", userId).select().single();
    if (updateError) throw updateError;

    // maybeMarkProfileComplete
    if (!updated.profile_completed && updated.name && updated.username) {
      const { data: completed, error: completeErr } = await supabase
        .from("users").update({ profile_completed: true }).eq("id", userId).select().single();
      if (completeErr) throw completeErr;
      return json(await fullProfile(supabase, completed));
    }

    return json(await fullProfile(supabase, updated));
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});

async function fullProfile(supabase: any, user: any) {
  const { data: institution } = user.institution_id
    ? await supabase.from("institutions").select("id, name, short_name").eq("id", user.institution_id).single()
    : { data: null };

  const { count: unreadCount } = await supabase
    .from("notifications").select("*", { count: "exact", head: true })
    .eq("user_id", user.id).is("read_at", null);

  return {
    id: user.id, name: user.name, username: user.username, email: user.email, phone: user.phone,
    bio: user.bio,
    avatar: user.avatar ? (user.avatar.startsWith("http") ? user.avatar : (await supabase.storage.from(Deno.env.get("STORAGE_BUCKET") ?? "media").createSignedUrl(user.avatar, 3600)).data?.signedUrl ?? null) : null,
    location: user.location, links: user.links ?? [],
    is_verified: user.is_verified, campus_verified: user.campus_verified,
    profile_completed: user.profile_completed, provider: user.provider,
    institution: institution ? { id: institution.id, name: institution.name, short_name: institution.short_name } : null,
    faculty: user.faculty, level: user.level, campus_role: user.campus_role,
    unread_notifications: unreadCount ?? 0,
  };
}