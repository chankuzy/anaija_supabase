/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";

const CATEGORIES = ["bug", "account", "marketplace", "safety", "suggestion"];
const MIN_LEN = 10;
const MAX_LEN = 2000;
const MAX_PER_HOUR = 5;

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const body = await req.json().catch(() => ({}));

    const category = String(body.category ?? "");
    const message = String(body.message ?? "").trim();

    if (!CATEGORIES.includes(category)) return json({ message: "Invalid category." }, 422);
    if (message.length < MIN_LEN) return json({ message: "Please add a few more details." }, 422);
    if (message.length > MAX_LEN) return json({ message: `Please keep it under ${MAX_LEN} characters.` }, 422);

    const since = new Date(Date.now() - 3_600_000).toISOString();
    const { count } = await supabase
      .from("reports")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", since);
    if ((count ?? 0) >= MAX_PER_HOUR) {
      return json({ message: "You've sent a few reports already. Please try again later." }, 429);
    }

    const { error } = await supabase.from("reports").insert({ user_id: userId, category, message });
    if (error) throw error;

    return json({ ok: true }, 201);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});
