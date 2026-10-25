/// <reference path="../_shared/deno-shim.d.ts" />
// Internal feed-readiness report (aggregate counts only). Gated by FEED_ADMIN_SECRET; fails closed.
import { serviceClient } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";

async function sha(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

async function authorised(req: Request): Promise<boolean> {
  const secret = Deno.env.get("FEED_ADMIN_SECRET") ?? "";
  const given = req.headers.get("x-admin-secret") ?? "";
  if (!secret || !given) return false;
  const [a, b] = await Promise.all([sha(secret), sha(given)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "GET") return json({ message: "Method not allowed." }, 405);
  if (!(await authorised(req))) return json({ message: "Not found." }, 404);

  try {
    const { data, error } = await serviceClient().rpc("feed_readiness");
    if (error) {
      console.error("[feed-debug] readiness failed:", error.message);
      return json({ message: "Temporarily unavailable." }, 503);
    }
    const res = json(data);
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    console.error("[feed-debug]", err);
    return json({ message: "Something went wrong." }, 500);
  }
});
