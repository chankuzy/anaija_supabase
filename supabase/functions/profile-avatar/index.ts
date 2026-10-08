/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { resolveAvatarUrl, r2ObjectExists } from "../_shared/avatar.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const body = await req.json();

    if (!body.storage_key || typeof body.storage_key !== "string") {
      return json({ message: "storage_key is required." }, 422);
    }

    // Ownership check — same pattern as post media verification.
    if (!body.storage_key.startsWith(`${userId}/`)) {
      return json({ message: "File does not belong to this user." }, 422);
    }

    // FIX: this used to check supabase.storage.from(BUCKET).list() —
    // Supabase Storage. But storage-sign-upload puts avatar uploads
    // straight into R2 via a presigned PUT, same as every other media
    // upload. Checking the wrong backend meant this always came back
    // "not found" no matter what the client actually uploaded. HEAD-
    // checking R2 directly is the same pattern postService's
    // verifyMediaOwnership() already uses for post media.
    const exists = await r2ObjectExists(body.storage_key);
    if (!exists) {
      return json({ message: "File not found in storage." }, 422);
    }

    const { error } = await supabase.from("users").update({
      avatar_key: body.storage_key,
    }).eq("id", userId);

    if (error) throw error;

    // FIX: was signing a Supabase Storage URL against the wrong
    // backend. R2 objects here are public-read behind the CDN — same
    // resolution every other avatar read now goes through.
    return json({ avatar_url: resolveAvatarUrl(body.storage_key) });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});