/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { locateComment } from "../_shared/services/commentService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    await requireAuth(req, supabase);
    const url = new URL(req.url);
    const postId = parseInt(url.pathname.split("/")[2], 10);
    const commentId = parseInt(url.searchParams.get("comment_id") ?? "", 10);
    if (!postId || !commentId) return json({ message: "postId and comment_id are required." }, 422);

    const result = await locateComment(supabase, postId, commentId);
    if ("notFound" in result) return json({ message: "Comment not found." }, 404);

    return json(result);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});
