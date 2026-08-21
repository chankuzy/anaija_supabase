import type { SupabaseClient } from "../auth.ts";
import { formatPost, formatListing } from "./feedService.ts";

const PAGE_SIZE = 20;

// Converts a raw query into a tsquery-safe string: splits on whitespace,
// treats each word as a prefix match (websearch-style), joined with AND.
// e.g. "iphone char" -> "iphone:* & char:*"
function toTsQuery(raw: string): string {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  return words.map((w) => `${w.replace(/[^\w]/g, "")}:*`).join(" & ");
}

export async function search(supabase: SupabaseClient, query: string, type: string | null, userId: number, cdnBase: string) {
  const tsQuery = toTsQuery(query);
  if (!tsQuery) return { posts: [], users: [] };

  // ── Full-text search on posts (primary path) ──
  let postQuery = supabase
    .from("posts")
    .select("*, user:users(id, name, username, avatar_key), media:post_media(*), listingDetail:listing_details(*)")
    .textSearch("search_vector", query, { type: "websearch", config: "english" })
    .eq("is_active", true)
    .eq("processing_status", "ready")
    .limit(PAGE_SIZE);

  if (type) postQuery = postQuery.eq("type", type);

  const { data: postRows, error: postErr } = await postQuery;
  if (postErr) throw postErr;

  let posts = postRows ?? [];

  // ── Fallback: if full-text finds nothing, try trigram fuzzy match ──
  // Catches typos ("iphon" -> "iphone") that exact-word tsquery would miss.
  if (posts.length === 0) {
    const { data: fuzzyRows } = await supabase
      .from("posts")
      .select("*, user:users(id, name, username, avatar_key), media:post_media(*), listingDetail:listing_details(*)")
      .eq("is_active", true)
      .eq("processing_status", "ready")
      .ilike("caption", `%${query}%`)
      .limit(PAGE_SIZE);
    posts = fuzzyRows ?? [];
  }

  posts = posts.map((p: any) => ({ ...p, listingDetail: Array.isArray(p.listingDetail) ? p.listingDetail[0] : p.listingDetail }));

  const formattedPosts = await Promise.all(
    posts.map((p: any) => (p.type === "listing" ? formatListing(supabase, p, cdnBase) : formatPost(supabase, p, cdnBase))),
  );

  // ── User search (trigram, since usernames/names are short strings) ──
  const { data: users } = await supabase
    .from("users")
    .select("id, name, username, avatar_key, is_verified")
    .or(`username.ilike.%${query}%,name.ilike.%${query}%`)
    .eq("is_active", true)
    .limit(10);

  const formattedUsers = (users ?? []).map((u: any) => ({
    id: u.id, name: u.name, username: u.username,
    avatar: u.avatar_key ? `${cdnBase}/${u.avatar_key}` : null,
    is_verified: u.is_verified,
  }));

  return { posts: formattedPosts, users: formattedUsers };
}

// Lightweight autocomplete — usernames + trending-ish caption prefixes.
export async function suggestions(supabase: SupabaseClient, query: string) {
  if (!query.trim()) return { suggestions: [] };

  const { data: users } = await supabase
    .from("users").select("username").ilike("username", `${query}%`).eq("is_active", true).limit(5);

  const { data: hashtags } = await supabase
    .from("hashtags").select("tag").ilike("tag", `${query}%`).order("posts_count", { ascending: false }).limit(5);

  return {
    suggestions: [
      ...(users ?? []).map((u: any) => ({ type: "user", value: u.username })),
      ...(hashtags ?? []).map((h: any) => ({ type: "hashtag", value: h.tag })),
    ],
  };
}