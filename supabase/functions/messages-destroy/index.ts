/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { deleteMessage } from "../_shared/services/messagingService.ts";

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
    const scope = body.scope === "everyone" ? "everyone" : "me";

    const result = await deleteMessage(supabase, conversationId, messageId, userId, scope);
    if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);
    if ("notFound" in result) return json({ message: "Not found." }, 404);
    if ("notOwner" in result) return json({ message: "You can only delete your own messages." }, 403);
    if ("tooLate" in result) return json({ message: "Messages can only be deleted within 5 minutes of sending." }, 422);
    if ("cannotHide" in result) return json({ message: "You can only hide your own messages from your view." }, 422);
    if ("everyone" in result) return json({ message: "Message deleted for everyone." });

    return json({ message: "Message hidden from your view." });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});