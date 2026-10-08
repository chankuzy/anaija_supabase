/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { updatePresence } from "../_shared/services/presenceService.ts";

// Called by the Flutter client whenever a screen tied to a specific entity
// (a single post, a conversation) becomes visible, on a ~25s heartbeat
// while it stays open, and once more with screen: null when the screen is
// left or the app backgrounds.
//
// Body: { screen: string | null, entity_type?: string, entity_id?: number }
Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const body = await req.json().catch(() => ({}));

    await updatePresence(supabase, userId, {
      screen: body.screen ?? null,
      entityType: body.entity_type ?? null,
      entityId: body.entity_id ?? null,
    });

    return json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});