/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";

const APP_URL = Deno.env.get("APP_URL") ?? "https://anaija.app";

// Deterministic UUID per (user, post). feed_ingest_events dedupes on (user_id, event_id),
// so a user's share of a post counts once no matter how often they tap.
async function shareEventId(userId: number, postId: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`share:${userId}:${postId}`));
  const b = new Uint8Array(digest).slice(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5 layout
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const postId = parseInt(new URL(req.url).pathname.split("/").pop() ?? "", 10);
    if (!postId) return json({ message: "Invalid post id." }, 422);

    const { data: post, error } = await supabase
      .from("posts").select("id, user_id, type, is_active, shares_count").eq("id", postId).maybeSingle();
    if (error) throw error;
    if (!post || !post.is_active) return json({ message: "Not found." }, 404);

    const current = post.shares_count ?? 0;

    // Stories are not shareable links and never count.
    if (post.type === "story") return json({ shares_count: current, share_url: null });

    const shareUrl = post.type === "listing" ? `${APP_URL}/marketplace/${postId}` : `${APP_URL}/posts/${postId}`;

    // Sharing your own post is allowed but never counts.
    if (post.user_id === userId) return json({ shares_count: current, share_url: shareUrl });

    // The sharer must be allowed to see the post (visibility, blocks, eligibility).
    const { data: visible, error: visErr } = await supabase.rpc("feed_filter_visible", {
      p_viewer: userId,
      p_ids: [postId],
    });
    if (visErr) throw visErr;
    if (!Array.isArray(visible) || visible.length === 0) return json({ message: "Not found." }, 404);

    let shares = current;
    const { data: res, error: ingestErr } = await supabase.rpc("feed_ingest_events", {
      p_user: userId,
      p_events: [{
        kind: "share",
        event_id: await shareEventId(userId, postId),
        post_id: postId,
        surface: "share_sheet",
        src: "share",
      }],
    });

    if (ingestErr) {
      // Engine trouble must not break sharing: hand back the link, skip the count.
      console.error("[posts-share] ingest failed:", ingestErr.message);
    } else if ((res as { accepted?: number } | null)?.accepted === 1) {
      shares = current + 1; // first share by this user: keep the legacy counter in step
      await supabase.from("posts").update({ shares_count: shares }).eq("id", postId);
    }

    return json({ shares_count: shares, share_url: shareUrl });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});
