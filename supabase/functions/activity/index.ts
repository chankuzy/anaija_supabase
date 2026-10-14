/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import {
  listActivity, markSeen, markRead, dismissItem, getCounts, listTargets,
} from "../_shared/services/activityService.ts";
import { dispatchOne, sweep } from "../_shared/services/activityDispatch.ts";

// Routes (all under /functions/v1/activity/...):
//   GET  list?filter=&cursor=    POST seen {up_to}    POST read {id|all}
//   POST dismiss {id}            GET  counts          POST dispatch  (DB webhook + cron, no user token)
Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const parts = new URL(req.url).pathname.split("/").filter(Boolean);
    const action = parts[parts.indexOf("activity") + 1] ?? "";

    if (action === "dispatch") {
      // Idempotent by design: only ever processes rows that are already queued,
      // claimed atomically, so a forged call can at worst trigger an early send.
      const secret = Deno.env.get("DISPATCH_WEBHOOK_SECRET");
      const sent = req.headers.get("x-webhook-secret");
      if (secret && sent && sent !== secret) return json({ message: "Unauthorized." }, 401);
      const body = await req.json().catch(() => ({}));
      if (body?.sweep) return json(await sweep(supabase));
      const id = Number(body?.record?.id);
      return json(id ? await dispatchOne(supabase, id) : { ok: true });
    }

    const userId = await requireAuth(req, supabase);
    const url = new URL(req.url);
    const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));

    switch (action) {
      case "list": {
        const { data: u } = await supabase.from("users").select("username").eq("id", userId).single();
        return json(await listActivity(supabase, { id: userId, username: u?.username ?? "" }, {
          cursor: url.searchParams.get("cursor"), filter: url.searchParams.get("filter"),
        }));
      }
      case "targets": return json(await listTargets(supabase, userId, Number(url.searchParams.get("id"))));
      case "counts": return json(await getCounts(supabase, userId));
      case "seen": return json(await markSeen(supabase, userId, body.up_to ?? null));
      case "read": return json(await markRead(supabase, userId, body.id ? Number(body.id) : null, !!body.all));
      case "dismiss":
        if (!body.id) return json({ message: "id is required." }, 422);
        return json(await dismissItem(supabase, userId, Number(body.id)));
      default: return json({ message: "Not found." }, 404);
    }
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});
