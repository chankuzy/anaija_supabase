/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { getFeedPage } from "../_shared/services/feedService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const t0 = performance.now();

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const t1 = performance.now();

    const cursor = new URL(req.url).searchParams.get("cursor");
    const scope = new URL(req.url).searchParams.get("scope") ?? "for_you";
    const result = await getFeedPage(supabase, userId, cursor, CDN_BASE, scope);
    const t2 = performance.now();

    console.log(`[timing] auth: ${(t1 - t0).toFixed(1)}ms | getFeedPage: ${(t2 - t1).toFixed(1)}ms | total: ${(t2 - t0).toFixed(1)}ms | posts_returned: ${result.posts.length}`);

    return json(result);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});