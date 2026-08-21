/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { listComments } from "../_shared/services/commentService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const url = new URL(req.url);
    const postId = parseInt(url.pathname.split("/")[2], 10);
    const cursor = url.searchParams.get("cursor");

    if (!postId) return json({ message: "Invalid post id." }, 422);

    const result = await listComments(supabase, postId, userId, cursor, CDN_BASE);
    if ("notFound" in result) return json({ message: "Not found." }, 404);
    if ("disabled" in result) return json({ data: [], message: "Comments are disabled." });

    return json(result);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});