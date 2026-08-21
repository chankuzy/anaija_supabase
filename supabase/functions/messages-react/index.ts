/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { toggleReaction } from "../_shared/services/messagingService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const parts = new URL(req.url).pathname.split("/");
    const conversationId = parseInt(parts[2], 10);
    const messageId = parseInt(parts[4], 10);
    if (!conversationId || !messageId) return json({ message: "Invalid id." }, 422);

    const body = await req.json();
    if (!body.emoji) return json({ message: "emoji is required." }, 422);

    const result = await toggleReaction(supabase, conversationId, messageId, userId, body.emoji);
    if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);
    if ("notFound" in result) return json({ message: "Not found." }, 404);

    return json({ reactions: result.reactions });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});