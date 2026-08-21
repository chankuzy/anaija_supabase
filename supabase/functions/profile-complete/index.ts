/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";

const USERNAME_REGEX = /^[a-zA-Z0-9_]+$/;

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const body = await req.json();

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
        institution: updated.institution ? { id: updated.institution.id, name: updated.institution.name, short_name: updated.institution.short_name } : null,
        faculty: updated.faculty, level: updated.level, campus_role: updated.campus_role,
      },
    });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});