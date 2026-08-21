/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { listInstitutions } from "../_shared/services/campusService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    await requireAuth(req, supabase);
    const url = new URL(req.url);
    const page = parseInt(url.searchParams.get("page") ?? "1", 10);

    return json(await listInstitutions(supabase, url.searchParams.get("search"), page));
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});