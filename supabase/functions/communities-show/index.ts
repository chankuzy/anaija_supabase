// supabase/functions/communities-show/index.ts
/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { getCommunity, getCommunityPosts } from "../_shared/services/communityService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const url = new URL(req.url);
    const slugOrId = url.pathname.split("/")[2];

    const result = await getCommunity(supabase, slugOrId, userId);
    if ("notFound" in result) return json({ message: "Not found." }, 404);

    const posts = await getCommunityPosts(supabase, result.community.id, userId, url.searchParams.get("cursor"), CDN_BASE);

    return json({ community: result.community, ...posts });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});