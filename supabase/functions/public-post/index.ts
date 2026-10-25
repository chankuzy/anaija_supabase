/// <reference path="../_shared/deno-shim.d.ts" />
// Guest-readable post/listing behind shared links (/p/{id}, /l/{id}). No token is ever read.
// Visibility = feed_filter_visible with a null viewer: the same rule feed-public uses.
import { serviceClient } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { formatPost, formatListing } from "../_shared/services/feedService.ts";
import { batchAttachAudio } from "../_shared/services/audioAssetService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";
const SEL =
  "*, user:users!posts_user_id_foreign(id, name, username, avatar_key, avatar, is_active), media:post_media(*), listingDetail:listing_details(*)";
const notFound = () => json({ message: "Not found." }, 404);

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "GET") return json({ message: "Method not allowed." }, 405);

  try {
    const id = parseInt(new URL(req.url).pathname.split("/").pop() ?? "", 10);
    if (!Number.isInteger(id) || id <= 0) return notFound();

    const supabase = serviceClient();
    const { data: post, error } = await supabase.from("posts").select(SEL).eq("id", id).maybeSingle();
    if (error) throw error;

    // Deleted, hidden, unfinished and story rows all look identical to "never existed".
    if (
      !post || !post.is_active || post.deleted_at || post.type === "story" ||
      post.processing_status !== "ready" || post.user?.is_active === false
    ) return notFound();

    const { data: visible, error: visErr } = await supabase.rpc("feed_filter_visible", { p_viewer: null, p_ids: [id] });
    if (visErr) throw visErr;
    if (!Array.isArray(visible) || visible.length === 0) return notFound();

    await batchAttachAudio(supabase, [post]);

    // deno-lint-ignore no-explicit-any
    const out: any = post.type === "listing"
      ? await formatListing(supabase, post, CDN_BASE, false, false, false)
      : await formatPost(supabase, post, CDN_BASE, false, false, false);

    if (out.listing) {
      delete out.listing.contact_phone;
      delete out.listing.pickup_info;
      delete out.listing.inquiries_count;
    }

    const res = json(out);
    res.headers.set("Cache-Control", "public, max-age=30");
    return res;
  } catch (err) {
    console.error("[public-post]", err);
    return json({ message: "Something went wrong." }, 500);
  }
});
