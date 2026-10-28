// supabase/functions/communities-index/index.ts
/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { listCommunities } from "../_shared/services/communityService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const p = new URL(req.url).searchParams;
    const result = await listCommunities(supabase, {
      viewerId: userId,
      institutionId: p.get("institution_id") ? parseInt(p.get("institution_id")!, 10) : undefined,
      search: p.get("search"),
      page: p.get("page") ? parseInt(p.get("page")!, 10) : 1,
    });
    return json(result);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});