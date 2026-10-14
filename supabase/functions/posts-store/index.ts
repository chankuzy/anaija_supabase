/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { createPost, ValidationError } from "../_shared/services/postService.ts";
import { broadcastStoryChange } from "../_shared/services/storyService.ts";

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

    // Retry of an already-created post: answer success, skip side effects.
    if (post.duplicate) {
      return json({
        post_id: post.id,
        type: post.type,
        listing_type: post.listing_type,
        status: post.processing_status,
        duplicate: true,
        message: "Already published.",
      }, 200);
    }

    // Live stories row: followers (and the author's other devices) refetch
    // the moment a story lands. Awaited so the edge runtime doesn't cut the
    // request off mid-fan-out; broadcastStoryChange never throws.
    if (post.type === "story") {
      await broadcastStoryChange(supabase, userId, "created", post.id);
    }

    // New-post alerts for followers are created by the trg_activity_post DB trigger.

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