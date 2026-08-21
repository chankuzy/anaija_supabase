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
    if (!postId) return json({ message: "Invalid post id." }, 422);

    const body = await req.json().catch(() => ({}));
    const result = await replyToStory(supabase, postId, userId, body.message ?? null);

    if ("notFound" in result) return json({ message: "Not found." }, 404);
    if ("notAStory" in result) return json({ message: "Not a story." }, 422);
    if ("expired" in result) return json({ message: "This story has expired." }, 410);
    if ("ownStory" in result) return json({ message: "Cannot reply to your own story." }, 422);

    return json({ conversation_id: result.conversation_id, message_id: result.message_id }, 201);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});