/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { togglePinned } from "../_shared/services/userService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const postId = parseInt(new URL(req.url).pathname.split("/").pop() ?? "", 10);
    if (Number.isNaN(postId)) return json({ message: "Invalid post id." }, 400);

    const result = await togglePinned(supabase, postId, userId);
    if ("notFound" in result) return json({ message: "Not found." }, 404);
    if ("unauthorized" in result) return json({ message: "Not your post." }, 403);
    if ("limitReached" in result) {
      return json({ message: `You can only pin up to ${result.max} posts. Unpin one first.` }, 422);
    }

    return json({ pinned: result.pinned });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});