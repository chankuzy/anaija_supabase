/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { markMessagesRead } from "../_shared/services/messagingService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const conversationId = parseInt(new URL(req.url).pathname.split("/")[2], 10);
    if (!conversationId) return json({ ok: false });

    const body = await req.json().catch(() => ({}));
    await markMessagesRead(supabase, conversationId, userId, body.message_ids ?? null, body.up_to_message_id ?? null);

    return json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ ok: true }); // fire-and-forget contract, matches Laravel
  }
});