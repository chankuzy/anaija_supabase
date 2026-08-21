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

    const data = await Promise.all(result.stories.map((s: any) => formatStory(supabase, s, userId)));
    return json({ data });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});