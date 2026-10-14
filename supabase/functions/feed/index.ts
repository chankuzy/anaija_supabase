/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { getFeed, type Scope } from "../_shared/feed/engine.ts";
import { getFeedPage } from "../_shared/services/feedService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";
const SCOPES = ["for_you", "following", "campus"];

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const t0 = performance.now();
  let userId: number | null = null;
  let cursor: string | null = null;

  try {
    const supabase = serviceClient();
    userId = await requireAuth(req, supabase);
    const q = new URL(req.url).searchParams;
    const scope = q.get("scope") ?? "for_you";
    if (!SCOPES.includes(scope)) return json({ message: "Invalid scope." }, 422);
    cursor = q.get("cursor");

    const { body } = await getFeed({
      supabase, viewerId: userId, scope: scope as Scope, cursor,
      refresh: q.get("refresh") === "1", cdnBase: CDN_BASE,
    });
    console.log(`[feed] user=${userId} scope=${scope} items=${(body.items as unknown[]).length} caught_up=${body.caught_up} reset=${body.cursor_reset} ${(performance.now() - t0).toFixed(0)}ms`);
    const res = json(body);
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error("[feed-engine-failure]", err);
    // Rollout safety net: first page only (a continuing client would otherwise get duplicates). Remove once stable.
    if (userId !== null && !cursor) {
      try {
        const legacy = await getFeedPage(serviceClient(), userId, null, CDN_BASE, "for_you");
        return json({ ...legacy, fallback: true });
      } catch (e) {
        console.error("[feed-legacy-fallback-failure]", e);
      }
    }
    return json({ message: "Something went wrong." }, 500);
  }
});
