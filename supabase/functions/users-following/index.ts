/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { getFollowing } from "../_shared/services/userService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const url = new URL(req.url);
    const username = url.pathname.split("/")[2];
    const page = parseInt(url.searchParams.get("page") ?? "1", 10);

    const result = await getFollowing(supabase, username, userId, page, CDN_BASE);
    if ("notFound" in result) return json({ message: "Not found." }, 404);

    return json({ data: result.data, has_more: result.hasMore });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});