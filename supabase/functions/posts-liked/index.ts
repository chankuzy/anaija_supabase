/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { getUserLikedPosts } from "../_shared/services/userService.ts";
import { formatPost, formatListing, getBookmarkedIds, getRepostedIds } from "../_shared/services/feedService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

// Own-only, like bookmarks-list — no :username param. Liking is private,
// same as Instagram's old Likes tab, so there's nothing to enforce beyond
// "the token owner sees their own likes."
Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const cursor = new URL(req.url).searchParams.get("cursor");

    const result = await getUserLikedPosts(supabase, userId, cursor);
    const likedIds = result.page.map((p: any) => p.id);
    const bookmarkedSet = await getBookmarkedIds(supabase, userId, likedIds);
    const repostedSet = await getRepostedIds(supabase, userId, likedIds);

    const data = await Promise.all(result.page.map((p: any) =>
      p.type === "listing"
        ? formatListing(supabase, p, CDN_BASE, false, true, bookmarkedSet.has(p.id))
        : formatPost(supabase, Object.assign(p, { _reposted: repostedSet.has(p.id) }), CDN_BASE, true, bookmarkedSet.has(p.id)),
    ));

    return json({
      data,
      next_cursor: result.hasMore ? btoa(String(result.page[result.page.length - 1].id)) : null,
      has_more: result.hasMore,
    });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});