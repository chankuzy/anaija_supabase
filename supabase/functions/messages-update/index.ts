/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { updateMessage } from "../_shared/services/messagingService.ts";

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

    const body = await req.json().catch(() => ({}));
    if (!body || typeof body.body !== "string" || !body.body.trim()) {
      return json({ message: "Message body cannot be empty." }, 422);
    }

    const result = await updateMessage(supabase, conversationId, messageId, userId, { body: body.body });
    if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);
    if ("notFound" in result) return json({ message: "Not found." }, 404);
    if ("notOwner" in result) return json({ message: "You can only edit your own messages." }, 403);
    if ("deleted" in result) return json({ message: "Deleted messages cannot be edited." }, 422);
    if ("notEditable" in result) return json({ message: "Only text messages can be edited." }, 422);
    if ("tooLate" in result) return json({ message: "Messages can only be edited within 15 minutes of sending." }, 422);
    if ("invalidBody" in result) return json({ message: "Message body cannot be empty." }, 422);

    return json(result.message);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});
