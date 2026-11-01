/// <reference path="../_shared/deno-shim.d.ts" />
import { Hono } from "hono";
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import {
  createPost,
  deletePost,
  getPost,
  updatePost,
  ValidationError,
} from "../_shared/services/postService.ts";
import { broadcastStoryChange } from "../_shared/services/storyService.ts";
import {
  listBookmarks,
  recordView,
  toggleBookmark,
  toggleLike,
  toggleRepost,
} from "../_shared/services/interactionService.ts";
import { batchAttachAudio } from "../_shared/services/audioAssetService.ts";
import {
  formatListing,
  formatPost,
  getBookmarkedIds,
  getLikedIds,
  getRepostedIds,
} from "../_shared/services/feedService.ts";
import { getUserLikedPosts, togglePinned } from "../_shared/services/userService.ts";
import { addToStory } from "./add-to-story.ts";
import { sharePost } from "./share.ts";
import { keepAccessible, postGate } from "../_shared/services/postAccess.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

// Routes (full path as the function sees it):
//   POST /posts/store                 GET  /posts/liked?cursor=
//   GET  /posts/bookmarks?type&page   */posts/show|update|destroy|like|bookmark|
//   view|share|repost|pin|add-to-story/:postId
// Legacy names (posts-like/12, bookmarks-list ...) are rewritten to these by the web proxy.
// app.all() keeps parity with the old functions, which never checked the HTTP method.
const app = new Hono().basePath("/posts");

app.use("*", async (c, next) => {
  const cors = handleCors(c.req.raw);
  if (cors) return cors;
  await next();
});

app.onError((err) => {
  if (err instanceof AuthError) return json({ message: err.message }, err.status);
  if (err instanceof ValidationError) {
    return json({ message: "Validation failed.", errors: err.errors }, 422);
  }
  console.error(err);
  return json({ message: "Something went wrong." }, 500);
});

app.notFound(() => json({ message: "Not found." }, 404));

// Visibility gate: every route that takes a post id answers 404 unless this viewer may see the post.
const NO_COMMUNITY = new Set(["repost", "add-to-story"]);
for (const route of ["show", "like", "bookmark", "repost", "view", "share", "add-to-story"]) {
  app.use(`/${route}/:postId`, async (c, next) => {
    const postId = parseInt(c.req.param("postId") ?? "", 10);
    if (postId) {
      const supabase = serviceClient();
      const userId = await requireAuth(c.req.raw, supabase);
      const g = await postGate(supabase, userId, postId);
      if (!g.ok) return json({ message: "Not found." }, 404);
      if (g.community && NO_COMMUNITY.has(route)) return json({ message: "Community posts can't be shared outside the community." }, 403);
    }
    await next();
  });
}

// ── create / read / update / delete ─────────────────────────────────────────

app.all("/store", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const body = await c.req.json();

  const { data: user, error } = await supabase.from("users").select("*").eq("id", userId).single();
  if (error) throw error;

  const post = await createPost(supabase, userId, user, body);

  // Retry of an already-created post: answer success, skip side effects.
  if (post.duplicate) {
    return json({
      post_id: post.id,
      type: post.type,
      listing_type: post.listing_type,
      status: post.processing_status,
      duplicate: true,
      message: "Already published.",
    }, 200);
  }

  // Live stories row: followers (and the author's other devices) refetch
  // the moment a story lands. Awaited so the edge runtime doesn't cut the
  // request off mid-fan-out; broadcastStoryChange never throws.
  if (post.type === "story") {
    await broadcastStoryChange(supabase, userId, "created", post.id);
  }

  // New-post alerts for followers are created by the trg_activity_post DB trigger.

  return json({
    post_id: post.id,
    type: post.type,
    listing_type: post.listing_type,
    status: post.processing_status,
    message: post.processing_status === "ready" ? "Published." : "Your content is being processed.",
  }, 202);
});

app.all("/show/:postId", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const postId = parseInt(c.req.param("postId"), 10);
  if (!postId) return json({ message: "Invalid post id." }, 422);

  const fetchResult = await getPost(supabase, postId, userId);
  if ("notFound" in fetchResult) return json({ message: "Not found." }, 404);
  if ("expired" in fetchResult) return json({ message: "This story has expired." }, 410);

  const { post, isLiked, isBookmarked } = fetchResult;

  let isFollowing = false;
  if (post.user_id !== userId) {
    const { count } = await supabase
      .from("follows")
      .select("*", { count: "exact", head: true })
      .eq("follower_id", userId)
      .eq("following_id", post.user_id);
    isFollowing = (count ?? 0) > 0;
  }

  const formatted = post.type === "listing"
    ? await formatListing(supabase, post, CDN_BASE, isFollowing, isLiked, isBookmarked)
    : await formatPost(supabase, post, CDN_BASE, isLiked, isBookmarked, isFollowing);

  return json(formatted);
});

app.all("/update/:postId", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const postId = parseInt(c.req.param("postId"), 10);
  if (!postId) return json({ message: "Invalid post id." }, 422);

  const body = await c.req.json();
  const result = await updatePost(supabase, postId, userId, body);

  if ("notFound" in result) return json({ message: "Not found." }, 404);
  if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);

  return json({ message: "Updated.", post_id: postId });
});

app.all("/destroy/:postId", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const postId = parseInt(c.req.param("postId"), 10);
  if (!postId) return json({ message: "Invalid post id." }, 422);

  // Read the type BEFORE deleting: afterwards there's nothing left to
  // tell us whether this was a story that followers need to drop.
  const { data: target } = await supabase
    .from("posts").select("type, user_id").eq("id", postId).maybeSingle();

  const result = await deletePost(supabase, postId, userId);
  if ("notFound" in result) return json({ message: "Not found." }, 404);
  if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);

  if (target?.type === "story" && target.user_id === userId) {
    await broadcastStoryChange(supabase, userId, "deleted", postId);
  }

  return json({ message: "Deleted." });
});

// ── interactions ────────────────────────────────────────────────────────────

app.all("/like/:postId", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const postId = parseInt(c.req.param("postId"), 10);
  if (!postId) return json({ message: "Invalid post id." }, 422);

  const { data: user } = await supabase.from("users").select("name").eq("id", userId).single();

  const result = await toggleLike(supabase, userId, postId, user?.name ?? "Someone");
  if ("notFound" in result) return json({ message: "Not found." }, 404);
  return json(result);
});

app.all("/bookmark/:postId", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const postId = parseInt(c.req.param("postId"), 10);
  if (!postId) return json({ message: "Invalid post id." }, 422);

  const result = await toggleBookmark(supabase, userId, postId);
  if ("notFound" in result) return json({ message: "Not found." }, 404);
  return json(result);
});

app.all("/repost/:postId", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const postId = parseInt(c.req.param("postId"), 10);
  if (!postId) return json({ message: "Invalid post id." }, 422);

  const body = await c.req.json().catch(() => ({}));
  const { data: user } = await supabase.from("users").select("name").eq("id", userId).single();

  const result = await toggleRepost(supabase, userId, postId, user?.name ?? "Someone", body.quote);
  if ("notFound" in result) return json({ message: "Not found." }, 404);
  if ("invalidType" in result) return json({ message: "Only posts can be reposted." }, 422);
  return json(result);
});

app.all("/pin/:postId", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const postId = parseInt(c.req.param("postId"), 10);
  if (Number.isNaN(postId)) return json({ message: "Invalid post id." }, 400);

  const result = await togglePinned(supabase, postId, userId);
  if ("notFound" in result) return json({ message: "Not found." }, 404);
  if ("unauthorized" in result) return json({ message: "Not your post." }, 403);
  if ("limitReached" in result) {
    return json({ message: `You can only pin up to ${result.max} posts. Unpin one first.` }, 422);
  }
  return json({ pinned: result.pinned });
});

// Fire-and-forget: always 200 once authenticated, never fail the client.
app.all("/view/:postId", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const postId = parseInt(c.req.param("postId"), 10);
  if (!postId) return json({ ok: true });

  try {
    await recordView(supabase, userId, postId);
  } catch (err) {
    console.error(err);
  }
  return json({ ok: true });
});

app.all("/share/:postId", (c) => sharePost(c));
app.all("/add-to-story/:postId", (c) => addToStory(c));

// ── own lists (no id) ───────────────────────────────────────────────────────

// Own-only, no :username param. Liking is private, so there's nothing to
// enforce beyond "the token owner sees their own likes."
app.all("/liked", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const cursor = c.req.query("cursor") ?? null;

  const liked0 = await getUserLikedPosts(supabase, userId, cursor);
  const result = { ...liked0, page: await keepAccessible(supabase, userId, liked0.page, (p: any) => p) };
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
});

app.all("/bookmarks", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const type = c.req.query("type") ?? null;
  const page = parseInt(c.req.query("page") ?? "1", 10);

  const listed = await listBookmarks(supabase, userId, type, page);
  const hasMore = listed.hasMore;
  const rows = await keepAccessible(supabase, userId, listed.rows, (b: any) => b.post);
  await batchAttachAudio(supabase, rows.map((b: any) => b.post));

  // Every row here is, by definition, bookmarked by this viewer, so no need
  // to re-query bookmark state. Still need real like state per post though.
  const postIds = rows.map((b: any) => b.post.id);
  const likedSet = await getLikedIds(supabase, userId, postIds);
  const repostedSet = await getRepostedIds(supabase, userId, postIds);

  const data = await Promise.all(rows.map(async (b: any) => ({
    bookmarked_at: b.created_at,
    post: await formatPost(supabase, Object.assign(b.post, { _reposted: repostedSet.has(b.post.id) }), CDN_BASE, likedSet.has(b.post.id), true),
  })));

  return json({ data, has_more: hasMore });
});

Deno.serve(app.fetch);
