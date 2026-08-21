/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { toggleCommentLike } from "../_shared/services/commentService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const commentId = parseInt(new URL(req.url).pathname.split("/").pop() ?? "", 10);
    if (!commentId) return json({ message: "Invalid comment id." }, 422);

    const result = await toggleCommentLike(supabase, userId, commentId);
    if ("notFound" in result) return json({ message: "Not found." }, 404);

    return json(result);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});