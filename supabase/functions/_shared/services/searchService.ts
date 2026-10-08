import type { SupabaseClient } from "../auth.ts";
import { formatPost, formatListing } from "./feedService.ts";
import { getTrending } from "./hashtagService.ts";
import { resolveAvatarUrl } from "../avatar.ts";

const PAGE_SIZE = 20;
const TYPED_PAGE_SIZE = 40;

const POST_SELECT =
  "*, user:users(id, name, username, avatar_key, avatar), media:post_media(*), listingDetail:listing_details(*)";

// "iphone char" -> "iphone:* & char:*" (prefix match on every word).
function toTsQuery(raw: string): string {
  return raw.trim().split(/\s+/)
    .map((w) => w.replace(/[^\w]/g, ""))
    .filter(Boolean)
    .map((w) => `${w}:*`)
    .join(" & ");
}

// Strips characters that would break PostgREST or/ilike filters.
function safeLike(raw: string): string {
  return raw.replace(/[,()%*_\\]/g, " ").replace(/\s+/g, " ").trim();
}

async function searchPosts(supabase: SupabaseClient, query: string, tsQuery: string, limit: number): Promise<any[]> {
  const { data, error } = await supabase
    .from("posts")
    .select(POST_SELECT)
    .textSearch("search_vector", tsQuery, { config: "english" })
    .eq("is_active", true)
    .eq("processing_status", "ready")
    .in("type", ["post", "listing"])
    .order("engagement_score", { ascending: false })
    .limit(limit);
  if (error) console.error("search fts failed:", error.message);

  let rows: any[] = data ?? [];

  // Fallback: plain caption match when full-text finds nothing.
  if (rows.length === 0) {
    const safe = safeLike(query);
    if (safe) {
      const { data: fuzzy } = await supabase
        .from("posts")
        .select(POST_SELECT)
        .eq("is_active", true)
        .eq("processing_status", "ready")
        .in("type", ["post", "listing"])
        .ilike("caption", `%${safe}%`)
        .limit(limit);
      rows = fuzzy ?? [];
    }
  }

  return rows.map((p: any) => ({
    ...p,
    listingDetail: Array.isArray(p.listingDetail) ? p.listingDetail[0] : p.listingDetail,
  }));
}

async function searchUsers(supabase: SupabaseClient, query: string, limit: number) {
  const safe = safeLike(query);
  if (!safe) return [];
  const { data } = await supabase
    .from("users")
    .select("id, name, username, avatar_key, avatar, is_verified, campus_verified")
    .or(`username.ilike.%${safe}%,name.ilike.%${safe}%`)
    .eq("is_active", true)
    .limit(limit);

  const q = safe.toLowerCase();
  const rank = (u: any) =>
    u.username?.toLowerCase().startsWith(q) ? 0 : u.name?.toLowerCase().startsWith(q) ? 1 : 2;

  return (data ?? [])
    .sort((a: any, b: any) => rank(a) - rank(b))
    .map((u: any) => ({
      id: u.id,
      name: u.name,
      username: u.username,
      avatar: resolveAvatarUrl(u.avatar_key ?? u.avatar),
      is_verified: u.is_verified,
      campus_verified: u.campus_verified,
    }));
}

const paged = (data: any[]) => ({ data, has_more: false, next_cursor: null });

export async function search(supabase: SupabaseClient, query: string, type: string | null, _userId: number, cdnBase: string) {
  const tsQuery = toTsQuery(query);
  if (!tsQuery) return { posts: [], listings: [], users: [] };

  const all = !type || type === "all";
  const wantUsers = all || type === "users";
  const wantPosts = all || type === "posts" || type === "listings";
  const limit = all ? PAGE_SIZE : TYPED_PAGE_SIZE;

  const [rows, users] = await Promise.all([
    wantPosts ? searchPosts(supabase, query, tsQuery, limit) : Promise.resolve([] as any[]),
    wantUsers ? searchUsers(supabase, query, limit) : Promise.resolve([] as any[]),
  ]);

  const postRows = rows.filter((p) => p.type !== "listing");
  const listingRows = rows.filter((p) => p.type === "listing");

  const [posts, listings] = await Promise.all([
    Promise.all(postRows.map((p) => formatPost(supabase, p, cdnBase))),
    Promise.all(listingRows.map((p) => formatListing(supabase, p, cdnBase))),
  ]);

  if (type === "users") return paged(users);
  if (type === "posts") return paged(posts);
  if (type === "listings") return paged(listings);
  return { posts, listings, users };
}

// No query  -> trending hashtags for the landing view.
// With query -> live autocomplete (people + hashtags).
export async function suggestions(supabase: SupabaseClient, query: string) {
  const q = safeLike(query.replace(/^#/, ""));

  if (!q) {
    const { hashtags } = await getTrending(supabase);
    return {
      suggestions: [],
      trending_terms: [],
      trending_hashtags: (hashtags ?? []).slice(0, 10).map((h: any) => ({
        tag: h.tag,
        posts_count: h.posts_count,
      })),
    };
  }

  const [{ data: users }, { data: tags }] = await Promise.all([
    supabase
      .from("users")
      .select("username, name, avatar_key, avatar")
      .or(`username.ilike.${q}%,name.ilike.${q}%`)
      .eq("is_active", true)
      .limit(5),
    supabase
      .from("hashtags")
      .select("tag, posts_count")
      .ilike("tag", `${q}%`)
      .order("posts_count", { ascending: false })
      .limit(5),
  ]);

  return {
    suggestions: [
      ...(users ?? []).map((u: any) => ({
        type: "user",
        value: u.username,
        name: u.name,
        avatar: resolveAvatarUrl(u.avatar_key ?? u.avatar),
      })),
      ...(tags ?? []).map((h: any) => ({ type: "hashtag", value: h.tag, posts_count: h.posts_count })),
    ],
  };
}
