/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { getUserStories } from "../_shared/services/userService.ts";
import { formatStory } from "../_shared/services/feedService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const username = new URL(req.url).pathname.split("/")[2];

    const result = await getUserStories(supabase, username, userId);
    if ("notFound" in result) return json({ message: "Not found." }, 404);

    // Same enrichment stories-index does: without it the profile viewer
    // showed 0 likes and an unfilled heart for every story.
    const likedIds = new Set<number>();
    const ids = result.stories.map((s: any) => s.id);
    if (ids.length) {
      const { data: likes } = await supabase
        .from("post_likes")
        .select("post_id")
        .eq("user_id", userId)
        .in("post_id", ids);
      for (const l of likes ?? []) likedIds.add(l.post_id);
    }

    const data = await Promise.all(
      result.stories.map(async (s: any) => ({
        ...(await formatStory(supabase, s, userId)),
        likes_count: s.likes_count ?? 0,
        is_liked: likedIds.has(s.id),
      })),
    );
    return json({ data });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});
