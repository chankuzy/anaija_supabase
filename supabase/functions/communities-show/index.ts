// Legacy read used by the Flutter app. Posts are returned only when the viewer may read them.
/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { canRead, loadAccess } from "../_shared/services/communityAccess.ts";
import { formatCommunity, getCommunityPosts } from "../_shared/services/communityService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const url = new URL(req.url);
    const a = await loadAccess(supabase, url.pathname.split("/")[2], userId);
    if (!a) return json({ message: "Not found." }, 404);
    if (a.banned) return json({ message: "You can't access this community." }, 403);

    const community = await formatCommunity(supabase, a.community, userId);
    const feed = canRead(a)
      ? await getCommunityPosts(supabase, a.community.id, userId, url.searchParams.get("cursor"), CDN_BASE)
      : { posts: [], next_cursor: null, has_more: false };
    return json({ community, ...feed });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});
