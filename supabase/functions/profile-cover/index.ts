/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { resolveAvatarUrl, r2ObjectExists } from "../_shared/avatar.ts";

// Exact mirror of profile-avatar/index.ts — same presigned-upload-then-
// confirm flow (client gets a key from storage-sign-upload, PUTs the file
// to R2 directly, then calls this to attach the key to the user row), just
// writing `cover_key` instead of `avatar_key`. Kept as a separate function
// rather than parameterizing profile-avatar so each stays a simple,
// single-purpose endpoint — matches how avatar/cover are already split as
// separate columns rather than a generic "images" table.
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

    if (!body.storage_key.startsWith(`${userId}/`)) {
      return json({ message: "File does not belong to this user." }, 422);
    }

    const exists = await r2ObjectExists(body.storage_key);
    if (!exists) {
      return json({ message: "File not found in storage." }, 422);
    }

    const { error } = await supabase.from("users").update({
      cover_key: body.storage_key,
    }).eq("id", userId);

    if (error) throw error;

    return json({ cover_url: resolveAvatarUrl(body.storage_key) });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});