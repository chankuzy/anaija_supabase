/// <reference path="../_shared/deno-shim.d.ts" />
import type { Hono } from "hono";
import { serviceClient, requireAuth } from "../_shared/auth.ts";
import { json } from "../_shared/response.ts";
import { resolveAvatarUrl } from "../_shared/avatar.ts";
import {
  addPostToHighlight,
  createHighlight,
  getHighlightPosts,
  getUserHighlights,
  removePostFromHighlight,
} from "../_shared/services/userService.ts";
import { formatListing, formatPost, getBookmarkedIds, getLikedIds } from "../_shared/services/feedService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

export function registerHighlights(app: Hono<any, any, any>) {
  // GET /users/highlights/{username}
  app.all("/highlights/:username", async (c) => {
    const supabase = serviceClient();
    await requireAuth(c.req.raw, supabase);

    const { data: profile } = await supabase
      .from("users").select("id").eq("username", c.req.param("username")).eq("is_active", true).maybeSingle();
    if (!profile) return json({ message: "Not found." }, 404);

    return json({ data: await getUserHighlights(supabase, profile.id) });
  });

  // POST /users/highlights-store  { title, storage_key? }
  // storage_key is the R2 key from storage-sign-upload. Resolved to a full CDN URL
  // here, once, since user_highlights.cover_url is stored as a plain URL.
  app.all("/highlights-store", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const body = await c.req.json();
    const title = String(body.title ?? "").trim();
    const storageKey = body.storage_key ? String(body.storage_key) : null;

    if (!title) return json({ message: "Title is required." }, 422);
    if (title.length > 20) return json({ message: "Title must be 20 characters or fewer." }, 422);

    const coverUrl = storageKey ? resolveAvatarUrl(storageKey) : null;
    return json(await createHighlight(supabase, userId, title, coverUrl), 201);
  });

  // POST   /users/highlight-posts            body: { highlight_id, post_id }  attach
  // DELETE /users/highlight-posts/{hid}/{pid}                                 detach
  // GET    /users/highlight-posts/{hid}                                       list
  app.post("/highlight-posts", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const body = await c.req.json();
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
  });

  app.delete("/highlight-posts/:highlightId/:postId", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const highlightId = parseInt(c.req.param("highlightId"), 10);
    const postId = parseInt(c.req.param("postId"), 10);
    if (Number.isNaN(highlightId) || Number.isNaN(postId)) {
      return json({ message: "Invalid ids." }, 422);
    }

    const result = await removePostFromHighlight(supabase, userId, highlightId, postId);
    if ("notFound" in result) return json({ message: "Highlight not found." }, 404);
    if ("unauthorized" in result) return json({ message: "Not yours." }, 403);
    return json({ ok: true });
  });

  app.get("/highlight-posts/:highlightId", async (c) => {
    // Any logged-in viewer can open a highlight on a profile.
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const highlightId = parseInt(c.req.param("highlightId"), 10);
    if (Number.isNaN(highlightId)) return json({ message: "Invalid highlight id." }, 422);

    const posts = await getHighlightPosts(supabase, highlightId);
    const ids = posts.map((p: any) => p.id);
    const likedSet = await getLikedIds(supabase, userId, ids);
    const bookmarkedSet = await getBookmarkedIds(supabase, userId, ids);

    const data = await Promise.all(posts.map((p: any) =>
      p.type === "listing"
        ? formatListing(supabase, p, CDN_BASE, false, likedSet.has(p.id), bookmarkedSet.has(p.id))
        : formatPost(supabase, p, CDN_BASE, likedSet.has(p.id), bookmarkedSet.has(p.id)),
    ));

    return json({ data });
  });
}
