/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { sendMessage } from "../_shared/services/messagingService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const conversationId = parseInt(new URL(req.url).pathname.split("/")[2], 10);
    if (!conversationId) return json({ message: "Invalid conversation id." }, 422);

    const body = await req.json();
    const result = await sendMessage(supabase, conversationId, userId, body, CDN_BASE);
    if ("blocked" in result) return json({ message: "You can't message this user." }, 403);
    if ("requestLimitReached" in result) return json({ message: "Message request limit reached — wait for a response before sending more." }, 429);
    if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);

    return json(result.message, 201);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});