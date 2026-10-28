/// <reference path="../_shared/deno-shim.d.ts" />
// Public/guest feed. No token is read, ever: guests get contextual ranking only, never personalisation,
// even if a stale token is attached. Eligibility is enforced in SQL (visibility='public' AND public_since).
import { serviceClient } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { getFeed } from "../_shared/feed/engine.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

// best-effort per-instance limiter (instances are ephemeral; a real WAF/limit belongs at the edge)
const hits = new Map<string, { n: number; reset: number }>();
function limited(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.reset < now) {
    hits.set(ip, { n: 1, reset: now + 60_000 });
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    return false;
  }
  return ++h.n > 60;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "GET") return json({ message: "Method not allowed." }, 405);

  const ip = (req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();
  if (limited(ip)) return json({ message: "Too many requests." }, 429);

  try {
    const q = new URL(req.url).searchParams;
    const { body } = await getFeed({
      supabase: serviceClient(), viewerId: null, scope: "for_you",
      cursor: q.get("cursor"), refresh: q.get("refresh") === "1", cdnBase: CDN_BASE,
    });
    const res = json(body);
    res.headers.set("Cache-Control", "no-store");
    return res;
  } catch (err) {
    console.error("[feed-public-failure]", err);
    return json({ message: "Something went wrong." }, 500);
  }
});
