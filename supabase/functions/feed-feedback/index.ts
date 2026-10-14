/// <reference path="../_shared/deno-shim.d.ts" />
// Explicit negative feedback ("Not interested" / "Hide this creator"), recorded as validated events
// so the post leaves this user's feeds, the signal decays their affinity, and aggregates see it.
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";

const KINDS = ["not_interested", "hide_creator"];

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return json({ message: "Method not allowed." }, 405);

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);

    let body: { post_id?: unknown; kind?: unknown; event_id?: unknown };
    try { body = await req.json(); } catch { return json({ message: "Invalid JSON." }, 422); }
    const postId = Number(body.post_id);
    if (!Number.isInteger(postId) || postId <= 0) return json({ message: "Invalid post_id." }, 422);
    if (typeof body.kind !== "string" || !KINDS.includes(body.kind)) return json({ message: "Invalid kind." }, 422);
    // a client-supplied event_id makes retries idempotent
    const eventId = typeof body.event_id === "string" && /^[0-9a-f-]{36}$/i.test(body.event_id)
      ? body.event_id : crypto.randomUUID();

    const { data, error } = await supabase.rpc("feed_ingest_events", {
      p_user: userId, p_events: [{ event_id: eventId, kind: body.kind, post_id: postId, surface: "feed_menu" }],
    });
    if (error) {
      console.error("[feed-feedback] failed:", error.message);
      return json({ message: "Temporarily unavailable." }, 503);
    }
    const r = data as { accepted?: number; duplicates?: number };
    if (!r.accepted && !r.duplicates) return json({ message: "That post is not available." }, 404);
    return json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});
