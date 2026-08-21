/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, verifyTokenOptional } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";

const USERNAME_REGEX = /^[a-zA-Z0-9_]+$/;

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const url = new URL(req.url);
    const username = url.searchParams.get("username");

    if (!username || username.length < 3 || username.length > 30 || !USERNAME_REGEX.test(username)) {
      return json({ message: "Invalid username." }, 422);
    }

    const supabase = serviceClient();
    const userId = await verifyTokenOptional(req, supabase); // null if no/invalid token — that's fine here

    let query = supabase.from("users").select("id", { count: "exact", head: true }).eq("username", username);
    if (userId) query = query.neq("id", userId);

    const { count, error } = await query;
    if (error) throw error;

    if ((count ?? 0) > 0) return json({ message: "Username is taken." }, 409);
    return json({ available: true });
  } catch (err) {
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});