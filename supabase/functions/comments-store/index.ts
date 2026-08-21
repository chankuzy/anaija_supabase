/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { createComment } from "../_shared/services/commentService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const postId = parseInt(new URL(req.url).pathname.split("/")[2], 10);
    if (!postId) return json({ message: "Invalid post id." }, 422);

    const body = await req.json();
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
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});