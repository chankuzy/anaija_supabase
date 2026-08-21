/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { toggleRepost } from "../_shared/services/interactionService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const postId = parseInt(new URL(req.url).pathname.split("/").pop() ?? "", 10);
    if (!postId) return json({ message: "Invalid post id." }, 422);

    const body = await req.json().catch(() => ({}));
    const { data: user } = await supabase.from("users").select("name").eq("id", userId).single();

    const result = await toggleRepost(supabase, userId, postId, user?.name ?? "Someone", body.quote);
    if ("notFound" in result) return json({ message: "Not found." }, 404);
    if ("invalidType" in result) return json({ message: "Only posts can be reposted." }, 422);

    return json(result);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});