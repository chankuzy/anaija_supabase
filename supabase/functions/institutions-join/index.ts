/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { joinInstitution } from "../_shared/services/campusService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const body = await req.json();

    if (!body.institution_id) return json({ message: "institution_id is required." }, 422);

    const result = await joinInstitution(supabase, userId, body.institution_id, body.faculty ?? null, body.level ?? null, body.campus_role ?? "student");
    if ("notFound" in result) return json({ message: "Institution not found." }, 422);

    return json({ message: "Institution linked successfully." });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});