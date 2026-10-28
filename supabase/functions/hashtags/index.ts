/// <reference path="../_shared/deno-shim.d.ts" />
import { Hono } from "hono";
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { getListingsForTag, getPostsForTag, getTrending } from "../_shared/services/hashtagService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

// Routes (full path as the function sees it):
//   /hashtags/trending   /hashtags/posts/:tag?cursor=   /hashtags/listings/:tag?cursor=
// Legacy names (hashtags-posts/tag ...) are rewritten to these by the web proxy.
// Hono already URL-decodes :tag, so no decodeURIComponent here (decoding twice can throw).
const app = new Hono().basePath("/hashtags");

app.use("*", async (c, next) => {
  const cors = handleCors(c.req.raw);
  if (cors) return cors;
  await next();
});

app.onError((err) => {
  if (err instanceof AuthError) return json({ message: err.message }, err.status);
  console.error(err);
  return json({ message: "Something went wrong." }, 500);
});

app.notFound(() => json({ message: "Not found." }, 404));

app.all("/trending", async (c) => {
  const supabase = serviceClient();
  await requireAuth(c.req.raw, supabase);
  return json(await getTrending(supabase));
});

app.all("/posts/:tag", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const cursor = c.req.query("cursor") ?? null;
  return json(await getPostsForTag(supabase, c.req.param("tag"), userId, cursor, CDN_BASE));
});

app.all("/listings/:tag", async (c) => {
  const supabase = serviceClient();
  await requireAuth(c.req.raw, supabase);
  const cursor = c.req.query("cursor") ?? null;
  return json(await getListingsForTag(supabase, c.req.param("tag"), cursor, CDN_BASE));
});

Deno.serve(app.fetch);
