/// <reference path="../_shared/deno-shim.d.ts" />
import type { Context, Hono } from "hono";
import { serviceClient, requireAuth, verifyTokenOptional } from "../_shared/auth.ts";
import { json } from "../_shared/response.ts";
import { resolveAvatarUrl, r2ObjectExists } from "../_shared/avatar.ts";

const USERNAME_REGEX = /^[a-zA-Z0-9_]+$/;
// "tagline" is the short quote under the cover photo. Plain text, same shape as bio.
const ALLOWED_FIELDS = ["name", "username", "bio", "tagline", "location", "links", "institution_id", "faculty", "level", "campus_role"] as const;
const TAGLINE_MAX_LEN = 80;

function shapeProfile(user: any, institution: any, unread: number) {
  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    phone: user.phone,
    bio: user.bio,
    tagline: user.tagline ?? null,
    avatar: resolveAvatarUrl(user.avatar_key ?? user.avatar),
    cover: resolveAvatarUrl(user.cover_key ?? user.cover_url),
    location: user.location,
    links: user.links ?? [],
    is_verified: user.is_verified,
    campus_verified: user.campus_verified,
    profile_completed: user.profile_completed,
    provider: user.provider,
    institution: institution
      ? { id: institution.id, name: institution.name, short_name: institution.short_name }
      : null,
    faculty: user.faculty,
    level: user.level,
    campus_role: user.campus_role,
    unread_notifications: unread,
  };
}

function unreadQuery(supabase: any, userId: number) {
  return supabase
    .from("notifications")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("read_at", null);
}

// Presigned-upload-then-confirm flow: the client gets a key from storage-sign-upload,
// PUTs the file to R2 directly, then calls this to attach the key to the user row.
function imageRoute(column: "avatar_key" | "cover_key", resultKey: "avatar_url" | "cover_url") {
  return async (c: Context) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const body = await c.req.json();

    if (!body.storage_key || typeof body.storage_key !== "string") {
      return json({ message: "storage_key is required." }, 422);
    }
    // Ownership check, same pattern as post media verification.
    if (!body.storage_key.startsWith(`${userId}/`)) {
      return json({ message: "File does not belong to this user." }, 422);
    }
    // R2 is the upload backend (not Supabase Storage), so HEAD-check R2 directly.
    if (!(await r2ObjectExists(body.storage_key))) {
      return json({ message: "File not found in storage." }, 422);
    }

    const { error } = await supabase.from("users").update({ [column]: body.storage_key }).eq("id", userId);
    if (error) throw error;

    return json({ [resultKey]: resolveAvatarUrl(body.storage_key) });
  };
}

export function registerProfile(app: Hono<any, any, any>) {
  app.all("/me", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);

    const { data: user, error } = await supabase
      .from("users")
      .select("*, institution:institutions(id, name, short_name, slug)")
      .eq("id", userId)
      .single();
    if (error) throw error;

    const { count, error: countError } = await unreadQuery(supabase, userId);
    if (countError) throw countError;

    return json(shapeProfile(user, user.institution, count ?? 0));
  });

  app.all("/me/update", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const body = await c.req.json();

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

    if (body.tagline !== undefined && body.tagline !== null) {
      if (typeof body.tagline !== "string" || body.tagline.length > TAGLINE_MAX_LEN) {
        return json({ message: `Tagline must be ${TAGLINE_MAX_LEN} characters or fewer.` }, 422);
      }
    }

    // Allowed fields only, nulls dropped (matches array_filter in the old PHP).
    const updates: Record<string, unknown> = {};
    for (const field of ALLOWED_FIELDS) {
      if (body[field] !== undefined && body[field] !== null) updates[field] = body[field];
    }

    const { data: updated, error: updateError } = await supabase
      .from("users").update(updates).eq("id", userId).select().single();
    if (updateError) throw updateError;

    let finalUser = updated;
    if (!updated.profile_completed && updated.name && updated.username) {
      const { data: completed, error: completeErr } = await supabase
        .from("users").update({ profile_completed: true }).eq("id", userId).select().single();
      if (completeErr) throw completeErr;
      finalUser = completed;
    }

    const { data: institution } = finalUser.institution_id
      ? await supabase.from("institutions").select("id, name, short_name").eq("id", finalUser.institution_id).single()
      : { data: null };
    const { count } = await unreadQuery(supabase, finalUser.id);

    return json(shapeProfile(finalUser, institution, count ?? 0));
  });

  app.all("/me/complete", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const body = await c.req.json();

    if (!body.name || typeof body.name !== "string") return json({ message: "name is required." }, 422);
    if (!body.username || typeof body.username !== "string" || body.username.length < 3 || body.username.length > 30 || !USERNAME_REGEX.test(body.username)) {
      return json({ message: "Invalid username." }, 422);
    }

    const { data: taken } = await supabase.from("users").select("id").eq("username", body.username).neq("id", userId).maybeSingle();
    if (taken) return json({ message: "Username is taken." }, 409);

    const { data: updated, error } = await supabase
      .from("users")
      .update({
        name: body.name,
        username: body.username,
        bio: body.bio ?? null,
        institution_id: body.institution_id ?? null,
        faculty: body.faculty ?? null,
        level: body.level ?? null,
        campus_role: body.campus_role ?? "student",
        profile_completed: true,
      })
      .eq("id", userId)
      .select("*, institution:institutions(id, name, short_name)")
      .single();
    if (error) throw error;

    return json({
      message: "Profile completed.",
      user: {
        id: updated.id, name: updated.name, username: updated.username, bio: updated.bio,
        profile_completed: updated.profile_completed,
        institution: updated.institution
          ? { id: updated.institution.id, name: updated.institution.name, short_name: updated.institution.short_name }
          : null,
        faculty: updated.faculty, level: updated.level, campus_role: updated.campus_role,
      },
    });
  });

  app.all("/me/avatar", imageRoute("avatar_key", "avatar_url"));
  app.all("/me/cover", imageRoute("cover_key", "cover_url"));

  // Guests allowed: the token is optional here.
  app.all("/username-check", async (c) => {
    const username = c.req.query("username");
    if (!username || username.length < 3 || username.length > 30 || !USERNAME_REGEX.test(username)) {
      return json({ message: "Invalid username." }, 422);
    }

    const supabase = serviceClient();
    const userId = await verifyTokenOptional(c.req.raw, supabase); // null if no/invalid token

    let query = supabase.from("users").select("id", { count: "exact", head: true }).eq("username", username);
    if (userId) query = query.neq("id", userId);

    const { count, error } = await query;
    if (error) throw error;

    if ((count ?? 0) > 0) return json({ message: "Username is taken." }, 409);
    return json({ available: true });
  });
}
