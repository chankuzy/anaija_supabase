/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";

import { json, handleCors } from "../_shared/response.ts";
import { createPost, ValidationError } from "../_shared/services/postService.ts";
import { broadcastStoryChange } from "../_shared/services/storyService.ts";
import { isBlockedEitherWay } from "../_shared/services/blockService.ts";

// POST /posts-add-to-story/{postId}  body: { client_request_id? }
// Turns a published post/listing into a story that reuses the SAME uploaded
// files (nothing is re-uploaded). Allowed for your own posts, and for anyone
// else's PUBLIC post when its author has "allow_story_sharing" on. Stories
// hold one item, so the first photo/video is used.
Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const postId = Number(new URL(req.url).pathname.split("/")[2]);
    if (!Number.isInteger(postId) || postId <= 0) {
      return json({ message: "Invalid post id." }, 422);
    }
    const body = await req.json().catch(() => ({}));

    const { data: source, error } = await supabase
      .from("posts")
      .select(
        "id, user_id, type, caption, visibility, allow_story_sharing, expires_at, context, is_active, deleted_at, processing_status, audio_asset_id, audio_config, media:post_media(media_type, storage_key, thumbnail_key, width, height, duration_seconds, aspect_ratio, size_bytes, mime_type, blurhash, dominant_color, sort_order)",
      )
      .eq("id", postId)
      .maybeSingle();
    if (error) throw error;


    if (!source || !source.is_active || source.deleted_at || source.processing_status !== "ready") {
      return json({ message: "Not found." }, 404);
    }
    const isOwn = source.user_id === userId;
    const isStorySource = source.type === "story";
    if (isStorySource) {
      // Story reshare: someone else's live story can be added to your own story.
      if (isOwn) return json({ message: "This is already your story." }, 422);
      if (source.expires_at && new Date(source.expires_at) < new Date()) {
        return json({ message: "Story expired." }, 410);
      }
    }
    if (!isOwn) {
      if (await isBlockedEitherWay(supabase, userId, source.user_id)) {
        return json({ message: "Not found." }, 404);
      }
      if ((source.visibility ?? "public") !== "public") {
        return json({ message: "This post isn't public, so it can't be added to a story." }, 403);
      }
      const { data: author, error: authorErr } = await supabase
        .from("users").select("name, allow_story_sharing").eq("id", source.user_id).single();
      if (authorErr) throw authorErr;
      // The post's own switch wins; otherwise the author's account setting.
      if ((source.allow_story_sharing ?? author.allow_story_sharing) === false) {
        return json({ message: `${author.name ?? "This person"} doesn't allow their posts to be added to stories.` }, 403);
      }
    }

    const first: any = [...(source.media ?? [])]
      .filter((m: any) => m.media_type === "image" || m.media_type === "video")
      .sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0))[0];
    if (!first) {
      return json({ message: "This post has no photo or video to share." }, 422);
    }

    const { data: user, error: userErr } = await supabase
      .from("users").select("*").eq("id", userId).single();

    if (userErr) throw userErr;

    const audio = source.audio_asset_id
      ? {
        enabled: source.audio_config?.enabled ?? true,
        start_ms: source.audio_config?.start_ms ?? 0,
        playback_duration_ms: source.audio_config?.playback_duration_ms ?? undefined,
      }
      : undefined;

    const story: any = await createPost(supabase, userId, user, {
      type: "story",
      caption: source.caption ?? undefined,
      visibility: "public",
      media: [{
        type: first.media_type,
        storage_key: first.storage_key,
        thumbnail_key: first.thumbnail_key ?? undefined,
        width: first.width ?? undefined,
        height: first.height ?? undefined,
        duration_seconds: first.duration_seconds ?? undefined,
        aspect_ratio: first.aspect_ratio ?? undefined,
        size_bytes: first.size_bytes ?? undefined,
        mime_type: first.mime_type ?? undefined,
        blurhash: first.blurhash ?? undefined,
        dominant_color: first.dominant_color ?? undefined,
      }],
      audio_asset_id: source.audio_asset_id ?? undefined,
      audio,
      client_request_id: typeof body.client_request_id === "string" ? body.client_request_id : undefined,
    }, { trustedSource: !isOwn });


    if (story.duplicate) {
      return json({ story_id: story.id, duplicate: true, message: "Already added." }, 200);
    }

    // Remember where this story came from, so viewers can show the
    // price / product card instead of a bare picture.
    {
      const { data: cur } = await supabase.from("posts").select("context").eq("id", story.id).maybeSingle();
      const { error: ctxErr } = await supabase.from("posts")
        .update({ context: { ...(cur?.context ?? {}), ...(isStorySource ? { source_post_id: source.context?.source_post_id ?? null, reshared_from_story_id: source.id, reshared_from_user_id: source.user_id } : { source_post_id: source.id }) } })
        .eq("id", story.id);
      if (ctxErr) console.error("story source link failed", ctxErr);
    }

    await broadcastStoryChange(supabase, userId, "created", story.id);
    return json({ story_id: story.id, message: "Added to your story." }, 201);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    if (err instanceof ValidationError) return json({ message: "Validation failed.", errors: err.errors }, 422);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});
