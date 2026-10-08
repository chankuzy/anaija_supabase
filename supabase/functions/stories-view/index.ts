/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { markStoryViewed } from "../_shared/services/storyService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const postId = parseInt(new URL(req.url).pathname.split("/")[2], 10);
    if (!postId) return json({ message: "Invalid story id." }, 422);

    const result = await markStoryViewed(supabase, postId, userId);
    if ("notFound" in result) return json({ message: "Not found." }, 404);
    if ("notAStory" in result) return json({ message: "Not a story." }, 422);
    if ("expired" in result) return json({ message: "Story expired." }, 410);

    return json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});