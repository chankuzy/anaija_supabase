/// <reference path="../_shared/deno-shim.d.ts" />
// Behavioural event ingestion (batched). The server validates, dedupes, classifies and aggregates;
// the client only reports raw metrics. See feed_ingest_events (migration 02) for the rules.
// Discover grid events (surface='discover', kind impression|open) are routed to discover_ingest_events
// (migration discover_01). Everything else, including full-screen consume events that carry
// surface='discover_view', goes through feed_ingest_events unchanged.
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";

type Ev = Record<string, unknown>;
type Counts = { accepted?: number; duplicates?: number; rejected?: number; error?: string };
const DISCOVER_KINDS = new Set(["impression", "open"]);

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

    const events = body.events as Ev[];
    const disc = events.filter((e) => e && typeof e === "object" && e.surface === "discover" && DISCOVER_KINDS.has(String(e.kind)));
    const rest = events.filter((e) => !disc.includes(e));

    const results: Counts[] = [];
    for (const [fn, batch] of [["feed_ingest_events", rest], ["discover_ingest_events", disc]] as const) {
      if (!batch.length) continue;
      const { data, error } = await supabase.rpc(fn, { p_user: userId, p_events: batch });
      if (error) {
        console.error(`[feed-events] ${fn} failed:`, error.message);
        return json({ message: "Temporarily unavailable." }, 503); // client keeps the batch; event_id dedupe makes the retry safe
      }
      results.push(data as Counts);
    }

    const merged: Counts = {
      accepted: results.reduce((n, r) => n + (r.accepted ?? 0), 0),
      duplicates: results.reduce((n, r) => n + (r.duplicates ?? 0), 0),
      rejected: results.reduce((n, r) => n + (r.rejected ?? 0), 0),
    };
    const err = results.find((r) => r.error)?.error;
    if (err === "rate_limited") return json({ ...merged, error: err }, 429);
    if (err) return json({ ...merged, error: err }, 422);
    return json(merged);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});
