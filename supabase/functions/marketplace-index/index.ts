/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { getMarketplaceFeed } from "../_shared/services/feedService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const url = new URL(req.url);
    const p = url.searchParams;

    const result = await getMarketplaceFeed(supabase, userId, CDN_BASE, {
      institutionId: p.get("institution_id") ? parseInt(p.get("institution_id")!, 10) : undefined,
      categoryId: p.get("category_id") ? parseInt(p.get("category_id")!, 10) : undefined,
      subtype: p.get("subtype") ?? undefined,
      minPrice: p.get("min_price") ? parseFloat(p.get("min_price")!) : undefined,
      maxPrice: p.get("max_price") ? parseFloat(p.get("max_price")!) : undefined,
      condition: p.get("condition") ?? undefined,
      cursor: p.get("cursor"),
      listingType: p.get("listing_type") ?? undefined,
      sort: p.get("sort") ?? "relevance",
    });

    return json(result);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});