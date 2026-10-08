/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { createHighlight } from "../_shared/services/userService.ts";
import { resolveAvatarUrl } from "../_shared/avatar.ts";

// POST /user-highlights-store — { title, storage_key? }
// storage_key is the R2 key returned by /storage-sign-upload after the
// client PUTs the highlight cover photo — same contract profile-avatar
// and profile-cover already use. Resolved to a full CDN URL here (once,
// at write time) since user_highlights.cover_url is stored as a plain
// URL, not a key+resolver pair like users.avatar_key.
Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const body = await req.json();
    const title = String(body.title ?? "").trim();
    const storageKey = body.storage_key ? String(body.storage_key) : null;

    if (!title) return json({ message: "Title is required." }, 422);
    if (title.length > 20) return json({ message: "Title must be 20 characters or fewer." }, 422);

    const coverUrl = storageKey ? resolveAvatarUrl(storageKey) : null;

    const highlight = await createHighlight(supabase, userId, title, coverUrl);
    return json(highlight, 201);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});