/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { deletePost } from "../_shared/services/postService.ts";
import { broadcastStoryChange } from "../_shared/services/storyService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);

    const postId = parseInt(new URL(req.url).pathname.split("/").pop() ?? "", 10);
    if (!postId) return json({ message: "Invalid post id." }, 422);

    // Read the type BEFORE deleting — afterwards there's nothing left to
    // tell us whether this was a story that followers need to drop.
    const { data: target } = await supabase
      .from("posts").select("type, user_id").eq("id", postId).maybeSingle();

    const result = await deletePost(supabase, postId, userId);
    if ("notFound" in result) return json({ message: "Not found." }, 404);
    if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);

    if (target?.type === "story" && target.user_id === userId) {
      await broadcastStoryChange(supabase, userId, "deleted", postId);
    }

    return json({ message: "Deleted." });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});