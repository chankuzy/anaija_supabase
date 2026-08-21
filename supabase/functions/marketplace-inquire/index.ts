/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { createInquiry } from "../_shared/services/listingService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const postId = parseInt(new URL(req.url).pathname.split("/")[2], 10);
    if (!postId) return json({ message: "Invalid post id." }, 422);

    const body = await req.json().catch(() => ({}));
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
      message: result.existing_conversation ? "Message sent in your existing conversation." : "Inquiry sent. The seller has been notified.",
    }, 201);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});