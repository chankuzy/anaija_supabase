/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { getCampusFeed } from "../_shared/services/campusService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const url = new URL(req.url);
    const { data: user } = await supabase.from("users").select("institution_id").eq("id", userId).single();

    const institutionId = url.searchParams.get("institution_id")
      ? parseInt(url.searchParams.get("institution_id")!, 10)
      : user?.institution_id ?? null;

    return json(await getCampusFeed(supabase, institutionId, userId, url.searchParams.get("subtype"), url.searchParams.get("cursor"), CDN_BASE));
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});