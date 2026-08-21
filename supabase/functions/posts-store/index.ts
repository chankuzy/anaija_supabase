/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { createPost, ValidationError } from "../_shared/services/postService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const body = await req.json();

    const { data: user, error } = await supabase.from("users").select("*").eq("id", userId).single();
    if (error) throw error;

    const post = await createPost(supabase, userId, user, body);

    return json({
      post_id: post.id,
      type: post.type,
      listing_type: post.listing_type,
      status: post.processing_status,
      message: post.processing_status === "ready" ? "Published." : "Your content is being processed.",
    }, 202);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    if (err instanceof ValidationError) return json({ message: "Validation failed.", errors: err.errors }, 422);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});