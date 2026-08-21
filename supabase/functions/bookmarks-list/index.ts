/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { listBookmarks } from "../_shared/services/interactionService.ts";
import { formatPost, getLikedIds } from "../_shared/services/feedService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const url = new URL(req.url);
    const type = url.searchParams.get("type");
    const page = parseInt(url.searchParams.get("page") ?? "1", 10);

    const { rows, hasMore } = await listBookmarks(supabase, userId, type, page);

    // Every row here is, by definition, bookmarked by this viewer — no need
    // to re-query bookmark state. Still need real like state per post though.
    const postIds = rows.map((b: any) => b.post.id);
    const likedSet = await getLikedIds(supabase, userId, postIds);

    const data = await Promise.all(rows.map(async (b: any) => ({
      bookmarked_at: b.created_at,
      post: await formatPost(supabase, b.post, CDN_BASE, likedSet.has(b.post.id), true),
    })));

    return json({ data, has_more: hasMore });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});