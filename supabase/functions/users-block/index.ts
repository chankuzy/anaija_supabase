/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { toggleBlock } from "../_shared/services/blockService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const blockerId = await requireAuth(req, supabase);
    const targetUserId = parseInt(new URL(req.url).pathname.split("/").pop() ?? "", 10);
    if (!targetUserId) return json({ message: "Invalid user id." }, 422);
    if (targetUserId === blockerId) return json({ message: "You cannot block yourself." }, 422);

    const result = await toggleBlock(supabase, blockerId, targetUserId);
    return json(result);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});