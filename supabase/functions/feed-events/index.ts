/// <reference path="../_shared/deno-shim.d.ts" />
// Behavioural event ingestion (batched). The server validates, dedupes, classifies and aggregates;
// the client only reports raw metrics. See feed_ingest_events (migration 02) for the rules.
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return json({ message: "Method not allowed." }, 405);

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase); // guests do not feed the behavioural engine

    if (Number(req.headers.get("content-length") ?? 0) > 65_536) return json({ message: "Payload too large." }, 413);
    let body: { events?: unknown };
    try { body = await req.json(); } catch { return json({ message: "Invalid JSON." }, 422); }
    if (!Array.isArray(body.events)) return json({ message: "events must be an array." }, 422);
    if (body.events.length === 0) return json({ accepted: 0, duplicates: 0, rejected: 0 });

    const { data, error } = await supabase.rpc("feed_ingest_events", { p_user: userId, p_events: body.events });
    if (error) {
      console.error("[feed-events] ingest failed:", error.message);
      return json({ message: "Temporarily unavailable." }, 503); // client keeps the batch and retries
    }
    const result = data as { error?: string };
    if (result?.error === "rate_limited") return json(result, 429);
    if (result?.error) return json(result, 422);
    return json(data);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});
