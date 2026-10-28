/// <reference path="../_shared/deno-shim.d.ts" />
import { Hono } from "hono";
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import {
  createInquiry,
  getListing,
  listInquiries,
  markAsAvailable,
  markAsReserved,
  markAsSold,
} from "../_shared/services/listingService.ts";
import { getMarketplaceFeed } from "../_shared/services/feedService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

// Routes (full path as the function sees it):
//   /marketplace/index?institution_id&category_id&subtype&min_price&max_price&condition&cursor&listing_type&sort
//   /marketplace/show|inquire|inquiries|available|reserve|sold/:postId
// Legacy names (marketplace-show/12 ...) are rewritten to these by the web proxy.
// app.all() keeps parity with the old functions, which never checked the HTTP method.
const app = new Hono().basePath("/marketplace");

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

app.all("/index", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const p = new URL(c.req.url).searchParams;

  const result = await getMarketplaceFeed(supabase, userId, CDN_BASE, {
    institutionId: p.get("institution_id") ? parseInt(p.get("institution_id")!, 10) : undefined,
    categoryId: p.get("category_id") ? parseInt(p.get("category_id")!, 10) : undefined,
    subtype: p.get("subtype") ?? undefined,
    minPrice: p.get("min_price") ? parseFloat(p.get("min_price")!) : undefined,
    maxPrice: p.get("max_price") ? parseFloat(p.get("max_price")!) : undefined,
    condition: p.get("condition") ?? undefined,
    cursor: p.get("cursor"),
    listingType: p.get("listing_type") ?? undefined,
    sort: p.get("sort") ?? "relevance",
  });

  return json(result);
});

app.all("/show/:postId", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const postId = parseInt(c.req.param("postId"), 10);
  if (!postId) return json({ message: "Invalid post id." }, 422);

  const result = await getListing(supabase, postId, userId, CDN_BASE);
  if ("notFound" in result) return json({ message: "Not found." }, 404);
  return json(result.listing);
});

app.all("/inquire/:postId", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const postId = parseInt(c.req.param("postId"), 10);
  if (!postId) return json({ message: "Invalid post id." }, 422);

  const body = await c.req.json().catch(() => ({}));
  const { data: user } = await supabase.from("users").select("name").eq("id", userId).single();

  const result = await createInquiry(supabase, userId, user?.name ?? "Someone", postId, body.message ?? null);

  if ("notFound" in result) return json({ message: "Not found." }, 404);
  if ("notAListing" in result) return json({ message: "This is not a listing." }, 422);
  if ("ownListing" in result) return json({ message: "You cannot inquire on your own listing." }, 422);
  if ("unavailable" in result) return json({ message: "This listing is no longer available." }, 422);
  if ("notAcceptingOrders" in result) return json({ message: "This vendor is not accepting orders right now." }, 422);
  if ("duplicate" in result) {
    return json({
      message: "You have already sent an inquiry for this listing.",
      inquiry_id: result.inquiry_id, conversation_id: result.conversation_id,
    }, 409);
  }

  return json({
    inquiry_id: result.inquiry_id,
    conversation_id: result.conversation_id,
    existing_conversation: result.existing_conversation,
    message: result.existing_conversation
      ? "Message sent in your existing conversation."
      : "Inquiry sent. The seller has been notified.",
  }, 201);
});

app.all("/inquiries/:postId", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const postId = parseInt(c.req.param("postId"), 10);
  if (!postId) return json({ message: "Invalid post id." }, 422);

  const result = await listInquiries(supabase, postId, userId, CDN_BASE);
  if ("notFound" in result) return json({ message: "Not found." }, 404);
  if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);
  return json(result);
});

app.all("/available/:postId", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const postId = parseInt(c.req.param("postId"), 10);
  if (!postId) return json({ message: "Invalid post id." }, 422);

  const result = await markAsAvailable(supabase, postId, userId);
  if ("notFound" in result) return json({ message: "Not found." }, 404);
  if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);
  return json({ message: "Listing marked as available." });
});

app.all("/reserve/:postId", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const postId = parseInt(c.req.param("postId"), 10);
  if (!postId) return json({ message: "Invalid post id." }, 422);

  const result = await markAsReserved(supabase, postId, userId);
  if ("notFound" in result) return json({ message: "Not found." }, 404);
  if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);
  return json({ message: "Listing marked as reserved." });
});

app.all("/sold/:postId", async (c) => {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const postId = parseInt(c.req.param("postId"), 10);
  if (!postId) return json({ message: "Invalid post id." }, 422);

  const result = await markAsSold(supabase, postId, userId);
  if ("notFound" in result) return json({ message: "Not found." }, 404);
  if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);
  if ("notAListing" in result) return json({ message: "Not a listing." }, 422);
  return json({ message: "Listing marked as sold." });
});

Deno.serve(app.fetch);
