/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";

// GET   /content-settings  -> every switch below, with defaults filled in
// PATCH /content-settings  body: any subset of the switches, as booleans
// Add a users column + one line in DEFAULTS to add another switch.
const DEFAULTS: Record<string, boolean> = {
  allow_story_sharing: true,
  feed_start_muted: false,
  feed_autoplay_video: true,
};
const FIELDS = Object.keys(DEFAULTS);

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);

    if (req.method === "GET") {
      const { data, error } = await supabase
        .from("users").select(FIELDS.join(", ")).eq("id", userId).single();
      if (error) throw error;
      const row: any = data ?? {};
      const out: Record<string, boolean> = {};
      for (const f of FIELDS) out[f] = typeof row[f] === "boolean" ? row[f] : DEFAULTS[f];
      return json(out);
    }

    if (req.method === "PATCH" || req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const updates: Record<string, boolean> = {};
      for (const f of FIELDS) {
        if (body[f] === undefined) continue;
        if (typeof body[f] !== "boolean") return json({ message: `${f} must be true or false.` }, 422);
        updates[f] = body[f];
      }
      if (!Object.keys(updates).length) return json({ message: "Nothing to update." }, 422);

      const { error } = await supabase.from("users").update(updates).eq("id", userId);
      if (error) throw error;
      return json(updates);
    }

    return json({ message: "Method not allowed." }, 405);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});
