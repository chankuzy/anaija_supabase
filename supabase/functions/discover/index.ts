// supabase/functions/discover/index.ts
// Discover = exploration surface. Content only (posts + listings); no people, communities or hashtag seeds.
/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { getDiscover } from "../_shared/discover/engine.ts";
import type { DiscoverFilter } from "../_shared/discover/types.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const p = new URL(req.url).searchParams;

    // `filter` is the current contract. `lens` is accepted so app builds already in the wild keep working:
    // marketplace -> marketplace, people -> nothing (people discovery is intentionally off), the rest -> for_you.
    const lens = p.get("lens");
    const filterParam = p.get("filter");
    if (lens === "people") return json({ items: [], next_cursor: null, has_more: false, caught_up: true });
    if (filterParam && !["for_you", "marketplace"].includes(filterParam)) {
      return json({ message: "Invalid filter." }, 422);
    }
    const filter: DiscoverFilter = filterParam === "marketplace" || (!filterParam && lens === "marketplace")
      ? "marketplace" : "for_you";

    const body = await getDiscover({
      supabase, viewerId: userId, filter,
      cursor: p.get("cursor"), refresh: p.get("refresh") === "1", cdnBase: CDN_BASE,
    });
    return json(body);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error("[discover] failed:", err);
    return json({ message: "Temporarily unavailable." }, 503);
  }
});
