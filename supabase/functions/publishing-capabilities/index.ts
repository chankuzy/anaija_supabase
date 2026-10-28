/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { listPublishers } from "../_shared/services/contentAccess.ts";

// What this account can publish. `ready` is false until the content-kinds migration is applied, so clients
// never offer a flow the database cannot store.
Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const { error } = await supabase.from("posts").select("content").limit(1);
    const ready = !error;
    const publishers = ready ? await listPublishers(supabase, userId) : [];
    return json({
      ready,
      kinds: { poll: ready, document: ready, article: ready, announcement: ready && publishers.length > 0 },
      publishers: publishers.map((p) => ({ id: p.id, name: p.name, type: p.type })),
    });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});
