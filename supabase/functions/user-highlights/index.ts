/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { getUserHighlights } from "../_shared/services/userService.ts";

// GET /user-highlights/{username}
Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    await requireAuth(req, supabase);
    const username = new URL(req.url).pathname.split("/").pop() ?? "";

    const { data: profile } = await supabase.from("users").select("id").eq("username", username).eq("is_active", true).maybeSingle();
    if (!profile) return json({ message: "Not found." }, 404);

    const highlights = await getUserHighlights(supabase, profile.id);
    return json({ data: highlights });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});