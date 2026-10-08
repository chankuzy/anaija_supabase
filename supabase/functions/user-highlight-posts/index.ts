/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { addPostToHighlight, removePostFromHighlight, getHighlightPosts } from "../_shared/services/userService.ts";
import { formatPost, formatListing, getLikedIds, getBookmarkedIds } from "../_shared/services/feedService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

// POST   /user-highlight-posts            body: { highlight_id, post_id }  — attach
// DELETE /user-highlight-posts/{hid}/{pid}                                 — detach
// GET    /user-highlight-posts/{hid}                                       — list (any viewer, public)
Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean); // ["user-highlight-posts", ...]

    if (req.method === "POST") {
      const userId = await requireAuth(req, supabase);
      const body = await req.json();
      const highlightId = parseInt(body.highlight_id, 10);
      const postId = parseInt(body.post_id, 10);
      if (Number.isNaN(highlightId) || Number.isNaN(postId)) {
        return json({ message: "highlight_id and post_id are required." }, 422);
      }

      const result = await addPostToHighlight(supabase, userId, highlightId, postId);
      if ("notFound" in result) return json({ message: "Highlight not found." }, 404);
      if ("postNotFound" in result) return json({ message: "Post not found." }, 404);
      if ("unauthorized" in result) return json({ message: "Not yours." }, 403);
      return json({ ok: true }, 201);
    }

    if (req.method === "DELETE") {
      const userId = await requireAuth(req, supabase);
      const postId = parseInt(segments.pop() ?? "", 10);
      const highlightId = parseInt(segments.pop() ?? "", 10);
      if (Number.isNaN(highlightId) || Number.isNaN(postId)) {
        return json({ message: "Invalid ids." }, 422);
      }

      const result = await removePostFromHighlight(supabase, userId, highlightId, postId);
      if ("notFound" in result) return json({ message: "Highlight not found." }, 404);
      if ("unauthorized" in result) return json({ message: "Not yours." }, 403);
      return json({ ok: true });
    }

    if (req.method === "GET") {
      // Public read — anyone viewing a profile can open a highlight.
      const userId = await requireAuth(req, supabase);
      const highlightId = parseInt(segments.pop() ?? "", 10);
      if (Number.isNaN(highlightId)) return json({ message: "Invalid highlight id." }, 422);

      const posts = await getHighlightPosts(supabase, highlightId);
      const likedSet = await getLikedIds(supabase, userId, posts.map((p: any) => p.id));
      const bookmarkedSet = await getBookmarkedIds(supabase, userId, posts.map((p: any) => p.id));

      const data = await Promise.all(posts.map((p: any) =>
        p.type === "listing"
          ? formatListing(supabase, p, CDN_BASE, false, likedSet.has(p.id), bookmarkedSet.has(p.id))
          : formatPost(supabase, p, CDN_BASE, likedSet.has(p.id), bookmarkedSet.has(p.id)),
      ));

      return json({ data });
    }

    return json({ message: "Method not allowed." }, 405);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});