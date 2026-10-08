// supabase/functions/communities-join/index.ts
/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { toggleMembership } from "../_shared/services/communityService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const communityId = parseInt(new URL(req.url).pathname.split("/")[2], 10);
    if (!communityId) return json({ message: "Invalid community id." }, 422);

    const result = await toggleMembership(supabase, communityId, userId);
    if ("notFound" in result) return json({ message: "Not found." }, 404);

    return json(result);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});