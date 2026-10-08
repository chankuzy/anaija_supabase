// supabase/functions/discover/index.ts
/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { getDiscoverFeed } from "../_shared/services/discoverService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const p = new URL(req.url).searchParams;

    const lens = (p.get("lens") ?? "for_you") as "for_you" | "trending" | "nearby" | "people" | "marketplace";
    if (!["for_you", "trending", "nearby", "people", "marketplace"].includes(lens)) {
      return json({ message: "Invalid lens." }, 422);
    }

    const lat = p.get("lat") ? parseFloat(p.get("lat")!) : undefined;
    const lng = p.get("lng") ? parseFloat(p.get("lng")!) : undefined;

    const result = await getDiscoverFeed(supabase, userId, CDN_BASE, {
      lens, cursor: p.get("cursor"), lat, lng,
    });

    return json(result);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});