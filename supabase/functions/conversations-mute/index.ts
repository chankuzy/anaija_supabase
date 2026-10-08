/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { setConversationMuted } from "../_shared/services/messagingService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);

    let body: any = {};
    if (req.method !== "GET" && req.method !== "HEAD") {
      try {
        body = await req.json();
      } catch {
        // body could be empty
      }
    }

    // Support conversation id from path (/conversations-mute/:id) or query or body
    const url = new URL(req.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const lastPart = pathParts[pathParts.length - 1];
    const parsedPathId = parseInt(lastPart, 10);

    const conversationId =
      !isNaN(parsedPathId) && lastPart !== "conversations-mute"
        ? parsedPathId
        : (body.conversation_id
            ? parseInt(body.conversation_id, 10)
            : parseInt(url.searchParams.get("conversation_id") ?? "", 10));

    if (!conversationId || isNaN(conversationId)) {
      return json({ message: "Invalid conversation id." }, 422);
    }

    const isMuted =
      typeof body.is_muted === "boolean"
        ? body.is_muted
        : (url.searchParams.get("is_muted") === "false" ? false : true);

    const result = await setConversationMuted(supabase, conversationId, userId, isMuted);
    if ("unauthorized" in result) {
      return json({ message: "Conversation not found or access denied." }, 403);
    }

    return json(result);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error("conversations-mute error:", err);
    return json({ message: "Something went wrong." }, 500);
  }
});
