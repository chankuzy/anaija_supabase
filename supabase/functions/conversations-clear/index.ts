/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { clearConversation } from "../_shared/services/messagingService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const conversationId = parseInt(new URL(req.url).pathname.split("/")[2], 10);
    if (!conversationId) return json({ message: "Invalid conversation id." }, 422);

    const result = await clearConversation(supabase, conversationId, userId);
    if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);
    return json({ message: "Chat cleared." });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});
