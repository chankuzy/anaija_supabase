/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { toggleFollow } from "../_shared/services/userService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const followerId = await requireAuth(req, supabase);
    const targetUserId = parseInt(new URL(req.url).pathname.split("/").pop() ?? "", 10);
    if (!targetUserId) return json({ message: "Invalid user id." }, 422);

    const { data: follower } = await supabase.from("users").select("name").eq("id", followerId).single();

    const result = await toggleFollow(supabase, followerId, follower?.name ?? "Someone", targetUserId);
    if ("selfFollow" in result) return json({ message: "You cannot follow yourself." }, 422);
    if ("notFound" in result) return json({ message: "Not found." }, 404);

    return json(result);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});