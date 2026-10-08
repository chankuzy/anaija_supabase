/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";

// GET  /follows-notify/{userId} -> { following, notify }
// POST /follows-notify/{userId} -> toggles "notify me when they post" -> { notify }
// Only meaningful while the viewer follows the target; unfollowing deletes
// the follows row, so the flag resets on its own.
Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const viewerId = await requireAuth(req, supabase);
    const targetId = parseInt(new URL(req.url).pathname.split("/").pop() ?? "", 10);
    if (!targetId) return json({ message: "Invalid user id." }, 422);
    if (targetId === viewerId) return json({ message: "Not applicable to yourself." }, 422);

    const { data: row, error } = await supabase
      .from("follows")
      .select("id, notify_posts")
      .eq("follower_id", viewerId)
      .eq("following_id", targetId)
      .maybeSingle();
    if (error) throw error;

    if (req.method === "GET") {
      return json({ following: !!row, notify: row?.notify_posts === true });
    }
    if (req.method !== "POST") return json({ message: "Method not allowed." }, 405);
    if (!row) return json({ message: "Follow this user first." }, 409);

    const next = row.notify_posts !== true;
    const { error: upErr } = await supabase.from("follows").update({ notify_posts: next }).eq("id", row.id);
    if (upErr) throw upErr;

    return json({ notify: next });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});
