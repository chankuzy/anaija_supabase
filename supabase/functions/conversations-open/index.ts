/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { openDirect } from "../_shared/services/messagingService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const myId = await requireAuth(req, supabase);
    const body = await req.json();
    const otherId = parseInt(body.user_id, 10);
    if (!otherId) return json({ message: "user_id is required." }, 422);

    const result = await openDirect(supabase, myId, otherId);
    if ("blocked" in result) return json({ message: "You can't message this user." }, 403);
    if ("selfConversation" in result) return json({ message: "Cannot start a conversation with yourself." }, 422);
    if ("notFound" in result) return json({ message: "User not found." }, 422);

    return json({ conversation_id: result.conversation_id, existing: result.existing }, result.existing ? 200 : 201);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});