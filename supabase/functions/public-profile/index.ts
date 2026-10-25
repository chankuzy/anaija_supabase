/// <reference path="../_shared/deno-shim.d.ts" />
// Guest-readable profile header + a grid of the user's public posts/listings. No token is ever read.
import { serviceClient } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { resolveAvatarUrl } from "../_shared/avatar.ts";
import { formatMedia } from "../_shared/services/feedService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";
const USERNAME_RE = /^[\w.]{1,50}$/;
const notFound = () => json({ message: "Not found." }, 404);

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "GET") return json({ message: "Method not allowed." }, 405);

  try {
    let username = "";
    try {
      username = decodeURIComponent(new URL(req.url).pathname.split("/").pop() ?? "");
    } catch {
      return notFound();
    }
    if (!USERNAME_RE.test(username)) return notFound();

    const supabase = serviceClient();
    const { data: u, error } = await supabase
      .from("users")
      .select("*, institution:institutions(short_name, name)")
      .eq("username", username).eq("is_active", true).is("deleted_at", null)
      .maybeSingle();
    if (error) throw error;
    if (!u) return notFound();

    const pub = (q: any) => q.eq("user_id", u.id).eq("is_active", true).eq("processing_status", "ready")
      .eq("visibility", "public").not("public_since", "is", null).is("deleted_at", null);

    const [posts, listings, followers, rows] = await Promise.all([
      pub(supabase.from("posts").select("*", { count: "exact", head: true }).eq("type", "post")),
      pub(supabase.from("posts").select("*", { count: "exact", head: true }).eq("type", "listing")),
      supabase.from("follows").select("*", { count: "exact", head: true }).eq("following_id", u.id),
      pub(supabase.from("posts").select("id, type, thumbnail_key, media:post_media(*)").in("type", ["post", "listing"]))
        .order("id", { ascending: false }).limit(12),
    ]);
    if (rows.error) throw rows.error;

    // deno-lint-ignore no-explicit-any
    const tiles = await Promise.all((rows.data ?? []).map(async (r: any) => {
      let thumb: string | null = r.thumbnail_key ? `${CDN_BASE}/${r.thumbnail_key}` : null;
      const first = [...(r.media ?? [])].sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0))[0];
      if (!thumb && first) {
        const m = await formatMedia(supabase, first);
        thumb = m.type === "video" ? m.thumbnail : (m.url ?? m.thumbnail);
      }
      return { id: r.id, type: r.type, thumbnail: thumb ?? null };
    }));

    const res = json({
      id: u.id,
      name: u.name,
      username: u.username,
      bio: u.bio,
      tagline: u.tagline ?? null,
      avatar: resolveAvatarUrl(u.avatar_key ?? u.avatar),
      cover: resolveAvatarUrl(u.cover_key ?? u.cover_url ?? null),
      is_verified: u.is_verified,
      campus_verified: u.campus_verified,
      institution: u.institution?.short_name ?? u.institution?.name ?? null,
      counts: { posts: posts.count ?? 0, listings: listings.count ?? 0, followers: followers.count ?? 0 },
      tiles,
    });
    res.headers.set("Cache-Control", "public, max-age=30");
    return res;
  } catch (err) {
    console.error("[public-profile]", err);
    return json({ message: "Something went wrong." }, 500);
  }
});
