/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { getUserPosts } from "../_shared/services/userService.ts";
import { formatPost } from "../_shared/services/feedService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const url = new URL(req.url);
    const username = url.pathname.split("/")[2]; // /users-posts/{username}
    const cursor = url.searchParams.get("cursor");

    const result = await getUserPosts(supabase, username, cursor);
    if ("notFound" in result) return json({ message: "Not found." }, 404);

    const { data: liked } = await supabase.from("post_likes").select("post_id")
      .eq("user_id", userId).in("post_id", result.page.map((p: any) => p.id));
    const likedSet = new Set((liked ?? []).map((r: any) => r.post_id));

    const data = await Promise.all(result.page.map((p: any) => formatPost(supabase, p, CDN_BASE, likedSet.has(p.id))));

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