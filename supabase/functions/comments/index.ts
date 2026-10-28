/// <reference path="../_shared/deno-shim.d.ts" />
import { Hono } from "hono";
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import {
  createComment,
  deleteComment,
  listComments,
  listReplies,
  locateComment,
  toggleCommentLike,
} from "../_shared/services/commentService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

// Routes (full path as the function sees it):
//   /comments/list/:postId        /comments/replies/:commentId
//   /comments/store/:postId       /comments/like/:commentId
//   /comments/destroy/:commentId  /comments/locate/:postId?comment_id=
// Legacy names (comments-list/...) are rewritten to these by the web proxy.
// app.all() keeps parity with the old functions, which never checked the HTTP method.
const app = new Hono().basePath("/comments");

app.use("*", async (c, next) => {
  const cors = handleCors(c.req.raw);
  if (cors) return cors;
  await next();
});

app.onError((err) => {
  if (err instanceof AuthError) return json({ message: err.message }, err.status);
  console.error(err);
  return json({ message: "Something went wrong." }, 500);
});

app.notFound(() => json({ message: "Not found." }, 404));

app.all("/list/:postId", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const postId = parseInt(c.req.param("postId"), 10);
  const cursor = c.req.query("cursor") ?? null;
  if (!postId) return json({ message: "Invalid post id." }, 422);

  const result = await listComments(supabase, postId, userId, cursor, CDN_BASE);
  if ("notFound" in result) return json({ message: "Not found." }, 404);
  if ("disabled" in result) return json({ data: [], message: "Comments are disabled." });
  return json(result);
});

app.all("/replies/:commentId", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const commentId = parseInt(c.req.param("commentId"), 10);
  const cursor = c.req.query("cursor") ?? null;
  if (!commentId) return json({ message: "Invalid comment id." }, 422);

  return json(await listReplies(supabase, commentId, userId, cursor, CDN_BASE));
});

app.all("/store/:postId", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const postId = parseInt(c.req.param("postId"), 10);
  if (!postId) return json({ message: "Invalid post id." }, 422);

  const body = await c.req.json().catch(() => ({}));
  if (!body.body || typeof body.body !== "string" || body.body.length > 1000) {
    return json({ message: "Comment body is required (max 1000 chars)." }, 422);
  }

  const { data: user } = await supabase.from("users").select("name").eq("id", userId).single();

  const result = await createComment(
    supabase, postId, userId, user?.name ?? "Someone", body.body, body.parent_id ?? null, CDN_BASE,
  );

  if ("notFound" in result) return json({ message: "Not found." }, 404);
  if ("storiesNotAllowed" in result) return json({ message: "Stories do not support comments." }, 422);
  if ("disabled" in result) return json({ message: "Comments are disabled on this post." }, 422);
  if ("parentNotFound" in result) return json({ message: "Parent comment not found." }, 404);
  return json(result.comment, 201);
});

app.all("/like/:commentId", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const commentId = parseInt(c.req.param("commentId"), 10);
  if (!commentId) return json({ message: "Invalid comment id." }, 422);

  const result = await toggleCommentLike(supabase, userId, commentId);
  if ("notFound" in result) return json({ message: "Not found." }, 404);
  return json(result);
});

app.all("/destroy/:commentId", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const commentId = parseInt(c.req.param("commentId"), 10);
  if (!commentId) return json({ message: "Invalid comment id." }, 422);

  const result = await deleteComment(supabase, commentId, userId);
  if ("notFound" in result) return json({ message: "Not found." }, 404);
  if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);
  return json({ message: "Deleted." });
});

app.all("/locate/:postId", async (c) => {
  const supabase = serviceClient();
  await requireAuth(c.req.raw, supabase);
  const postId = parseInt(c.req.param("postId"), 10);
  const commentId = parseInt(c.req.query("comment_id") ?? "", 10);
  if (!postId || !commentId) return json({ message: "postId and comment_id are required." }, 422);

  const result = await locateComment(supabase, postId, commentId);
  if ("notFound" in result) return json({ message: "Comment not found." }, 404);
  return json(result);
});

Deno.serve(app.fetch);
