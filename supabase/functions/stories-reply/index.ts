/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { replyToStory } from "../_shared/services/storyService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const postId = parseInt(new URL(req.url).pathname.split("/")[2], 10);
    if (!postId) return json({ message: "Invalid story id." }, 422);

    const body = await req.json().catch(() => ({}));
    const result = await replyToStory(supabase, postId, userId, body.message ?? null);

    if ("notFound" in result) return json({ message: "Not found." }, 404);
    if ("notAStory" in result) return json({ message: "Not a story." }, 422);
    if ("expired" in result) return json({ message: "Story expired." }, 410);
    if ("ownStory" in result) return json({ message: "You can't reply to your own story." }, 422);
    if ("blocked" in result) return json({ message: "You can't message this user." }, 403);
    if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);
    if ("requestLimitReached" in result) return json({ message: "Message request limit reached — wait for a response before sending more." }, 429);

    return json(result, 201);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});