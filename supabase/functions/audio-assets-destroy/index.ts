/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { deleteAudioAsset } from "../_shared/services/audioAssetService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const assetId = parseInt(new URL(req.url).pathname.split("/").pop() ?? "", 10);
    if (!assetId) return json({ message: "Invalid asset id." }, 422);

    const result = await deleteAudioAsset(supabase, userId, assetId);
    if ("notFound" in result) return json({ message: "Not found." }, 404);
    if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);

    return json({ message: "Deleted." });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});