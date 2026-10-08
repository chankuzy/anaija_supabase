/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { resolveAvatarUrl } from "../_shared/avatar.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);

    const { data: blocks, error } = await supabase
      .from("user_blocks")
      .select("blocked_id, created_at")
      .eq("blocker_id", userId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;

    const ids = (blocks ?? []).map((b: any) => b.blocked_id);
    if (!ids.length) return json({ data: [] });

    const { data: users, error: uErr } = await supabase
      .from("users")
      .select("id, name, username, avatar_key, avatar")
      .in("id", ids);
    if (uErr) throw uErr;

    const byId = new Map((users ?? []).map((u: any) => [u.id, u]));
    const data = ids
      .map((id: number) => byId.get(id))
      .filter(Boolean)
      .map((u: any) => ({
        id: u.id,
        name: u.name,
        username: u.username,
        avatar: resolveAvatarUrl(u.avatar_key ?? u.avatar),
      }));

    return json({ data });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});
