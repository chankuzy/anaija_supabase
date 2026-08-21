/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { getPost } from "../_shared/services/postService.ts";
import { formatPost, formatListing } from "../_shared/services/feedService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);

    const postId = parseInt(new URL(req.url).pathname.split("/").pop() ?? "", 10);
    if (!postId) return json({ message: "Invalid post id." }, 422);

    const fetchResult = await getPost(supabase, postId, userId);
    if ("notFound" in fetchResult) return json({ message: "Not found." }, 404);
    if ("expired" in fetchResult) return json({ message: "This story has expired." }, 410);

    const { post, isLiked, isBookmarked } = fetchResult;
    const formatted = post.type === "listing"
      ? await formatListing(supabase, post, CDN_BASE)
      : await formatPost(supabase, post, CDN_BASE, isLiked, isBookmarked);

    return json(formatted);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});