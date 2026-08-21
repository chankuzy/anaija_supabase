/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";

const BUCKET = Deno.env.get("STORAGE_BUCKET") ?? "media";
const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

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

    const dir = body.storage_key.split("/").slice(0, -1).join("/");
    const filename = body.storage_key.split("/").pop()!;
    const { data: found, error: listErr } = await supabase.storage.from(BUCKET).list(dir, { search: filename });
    if (listErr) throw listErr;
    if (!found?.some((f: any) => f.name === filename)) {
      return json({ message: "File not found in storage." }, 422);
    }

    const { error } = await supabase.from("users").update({
      avatar_key: body.storage_key,
      avatar: body.storage_key,
    }).eq("id", userId);

    if (error) throw error;

    const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrl(body.storage_key, 3600);

    return json({ avatar_url: signed?.signedUrl ?? null });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});