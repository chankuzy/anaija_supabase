/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { updatePost, ValidationError } from "../_shared/services/postService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);

    const postId = parseInt(new URL(req.url).pathname.split("/").pop() ?? "", 10);
    if (!postId) return json({ message: "Invalid post id." }, 422);

    const body = await req.json();
    const result = await updatePost(supabase, postId, userId, body);

    if ("notFound" in result) return json({ message: "Not found." }, 404);
    if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);

    return json({ message: "Updated.", post_id: postId });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    if (err instanceof ValidationError) return json({ message: "Validation failed.", errors: err.errors }, 422);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});
