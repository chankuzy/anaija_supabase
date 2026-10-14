/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { getUserReposts } from "../_shared/services/userService.ts";
import { formatPost, getLikedIds } from "../_shared/services/feedService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const url = new URL(req.url);
    const username = url.pathname.split("/")[2]; // /users-reposts/{username}
    const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);

    const result = await getUserReposts(supabase, username, page);
    if ("notFound" in result) return json({ message: "Not found." }, 404);

    const ids = result.rows.map((r: any) => r.post.id);
    const likedSet = await getLikedIds(supabase, userId, ids);

    // Reposted-by-the-VIEWER (not the profile owner), so the icon state is right.
    const { data: mine } = ids.length
      ? await supabase.from("reposts").select("post_id").eq("user_id", userId).in("post_id", ids)
      : { data: [] as any[] };
    const mySet = new Set((mine ?? []).map((r: any) => r.post_id));

    const data = await Promise.all(result.rows.map(async (r: any) => {
      r.post._reposted = mySet.has(r.post.id);
      const formatted = await formatPost(supabase, r.post, CDN_BASE, likedSet.has(r.post.id));
      return { ...formatted, reposted_at: r.created_at ?? null };
    }));

    return json({ data, has_more: result.hasMore });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});
