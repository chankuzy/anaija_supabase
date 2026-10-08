import type { SupabaseClient } from "../auth.ts";
import { batchAttachAudio } from "./audioAssetService.ts";
import { resolveAvatarUrl } from "../avatar.ts";

const PAGE_SIZE = 15;
const MARKETPLACE_PAGE_SIZE = 20;

const STORAGE_BUCKET = Deno.env.get("STORAGE_BUCKET") ?? "media";

function publicUrl(bucket: string, key: string | null | undefined): string | null {
  if (!key) return null;
  if (key.startsWith("http://") || key.startsWith("https://")) return key;
  const cleanKey = key.replace(/^\/+/, "");
  const cdnBase = Deno.env.get("CDN_BASE_URL") ?? "";
  if (cdnBase) {
    return `${cdnBase.replace(/\/+$/, "")}/${cleanKey}`;
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (!supabaseUrl) return null;
  return `${supabaseUrl.replace(/\/+$/, "")}/storage/v1/object/public/${bucket}/${cleanKey}`;
}

export async function formatAuthor(
  supabase: SupabaseClient,
  user: any,
  cdnBase: string = "",
  isFollowing = false
) {
  if (!user) return null;

  // FIX: was resolving via publicUrl() against a dedicated AVATARS_BUCKET
  // that nothing ever actually uploads to, and every caller of this
  // function selected only `avatar_key` on the user join — so the
  // `?? user.avatar` fallback below had nothing to fall back to, it was
  // always undefined. Now uses the same shared resolver every other
  // avatar read goes through, and the selects below (getFeedPage,
  // getMarketplaceFeed, getStoriesForUser) include `avatar` so the
  // fallback actually has data to work with for users who've never
  // uploaded a custom avatar (avatar_key null, avatar = their Google/
  // social-auth photo URL).
  const rawKey = user.avatar_key ?? user.avatar;
  const avatar = resolveAvatarUrl(rawKey);

  return {
    id: user.id,
    name: user.name,
    username: user.username,
    avatar,
    is_following: isFollowing,
  };
}

export async function formatMedia(supabase: SupabaseClient, media: any) {
  return {
    id: media.id,
    type: media.media_type,
    url: publicUrl(STORAGE_BUCKET, media.storage_key),
    thumbnail: publicUrl(STORAGE_BUCKET, media.thumbnail_key),
    hls_url: null,
    width: media.width,
    height: media.height,
    aspect_ratio: media.aspect_ratio,
    duration: media.duration_seconds,
    resolutions: media.resolutions ?? [],
    sort_order: media.sort_order,
    blurhash: media.blurhash,
    dominant_color: media.dominant_color,
    optimized: media.optimized,
  };
}

export async function formatPost(
  supabase: SupabaseClient,
  post: any,
  cdnBase: string,
  isLiked = false,
  isBookmarked = false,
  isFollowing = false,
) {
  const [media, author] = await Promise.all([
    Promise.all((post.media ?? []).map((m: any) => formatMedia(supabase, m))),
    formatAuthor(supabase, post.user, cdnBase, isFollowing),
  ]);

  const audioAsset = post._audioAsset ?? post.audioAsset?.[0] ?? null;
  const audio = audioAsset
    ? {
        enabled: post.audio_config?.enabled ?? true,
        name: audioAsset.name,
        url: publicUrl(STORAGE_BUCKET, audioAsset.storage_key),
        duration_ms: audioAsset.duration_ms,
        start_ms: post.audio_config?.start_ms ?? 0,
        playback_duration_ms: post.audio_config?.playback_duration_ms ?? audioAsset.duration_ms,
      }
    : { enabled: false };

  return {
    id: post.id,
    type: post.type,
    subtype: post.subtype,
    pinned_at: post.pinned_at ?? null,
    caption: post.caption,
    video_url: post.video_key ? (post.video_key.startsWith("http") ? post.video_key : `${cdnBase}/${post.video_key}`) : null,
    thumbnail_url: post.thumbnail_key ? `${cdnBase}/${post.thumbnail_key}` : null,
    duration: post.duration_seconds,
    resolutions: post.resolutions ?? [240],
    likes_count: post.likes_count,
    comments_count: post.comments_count,
    shares_count: post.shares_count,
    reposts_count: post.reposts_count ?? 0,
    bookmarks_count: post.bookmarks_count ?? 0,
    is_liked: isLiked,
    is_bookmarked: isBookmarked,
    allow_comments: post.allow_comments,
    allow_duet: post.allow_duet,
    visibility: post.visibility,
    hashtags: post.hashtags ?? [],
    created_at: post.created_at,
    author,
    media,
    slideshow: post.slideshow_config ?? { enabled: false, interval_ms: 2800, transition: 'fade' },
    audio,
  };
}

export async function formatListing(
  supabase: SupabaseClient,
  post: any,
  cdnBase: string,
  isFollowing = false,
  isLiked = false,
  isBookmarked = false,
) {
  const d = Array.isArray(post.listingDetail) ? post.listingDetail[0] : post.listingDetail;

  const listing = d ? {
    price: d.price_minor / 100,
    formatted_price: (d.price_minor / 100).toLocaleString(),
    currency: d.currency,
    price_type: d.price_type,
    condition: d.condition,
    status: d.status,
    contact_preference: d.contact_preference,
    contact_phone: d.contact_phone,
    pickup_info: d.pickup_info,
    quantity: d.quantity,
    views_count: d.views_count,
    inquiries_count: d.inquiries_count,
    business_name: d.business_name,
    business_description: d.business_description,
    fulfillment_type: d.fulfillment_type,
    accepting_orders: d.accepting_orders,
    delivery_available: d.delivery_available,
    opening_hours: d.opening_hours,
    estimated_delivery: d.estimated_delivery,
    service_radius_km: d.service_radius_km,
    minimum_order_price: d.minimum_order_price,
    verification_status: d.verification_status,
  } : null;

  const base = await formatPost(supabase, post, cdnBase, isLiked, isBookmarked, isFollowing);

  return { ...base, listing_type: post.listing_type ?? "product", listing };
}

export async function formatStory(
  supabase: SupabaseClient,
  post: any,
  viewerId: number,
  cdnBase: string = "",
) {
  const [media, author] = await Promise.all([
    Promise.all((post.media ?? []).map((m: any) => formatMedia(supabase, m))),
    formatAuthor(supabase, post.user, cdnBase, false),
  ]);

  const audioAsset = post._audioAsset ?? post.audioAsset?.[0] ?? null;
  const audio = audioAsset
    ? {
        enabled: true,
        name: audioAsset.name,
        url: publicUrl(STORAGE_BUCKET, audioAsset.storage_key),
        duration_ms: audioAsset.duration_ms,
        start_ms: post.audio_config?.start_ms ?? 0,
        playback_duration_ms: post.audio_config?.playback_duration_ms ?? audioAsset.duration_ms,
      }
    : { enabled: false };

  const seen = Array.isArray(post.storyViews) ? post.storyViews.length > 0 : false;

  return {
    id: post.id,
    caption: post.caption,
    expires_at: post.expires_at,
    seen,
    media,
    audio,
    author,
    created_at: post.created_at,
  };
}

export async function getFeedPage(supabase: SupabaseClient, userId: number, cursor: string | null, cdnBase: string) {
  const cursorId = cursor ? parseInt(atob(cursor), 10) : Number.MAX_SAFE_INTEGER;

  const { data: follows } = await supabase.from("follows").select("following_id").eq("follower_id", userId);
  const followingIds = (follows ?? []).map((f: any) => f.following_id);
  const followingSet = new Set<number>(followingIds);

  const visibleUserIds = [...new Set([userId, ...followingIds])];

  // FIX: added `avatar` — see formatAuthor's comment above.
  let query = supabase
    .from("posts")
    .select("*, user:users(id, name, username, avatar_key, avatar), media:post_media(*), listingDetail:listing_details(*)")
    .eq("processing_status", "ready")
    .eq("is_active", true)
    .in("type", ["post", "story", "listing"])
    .lt("id", cursorId)
    .limit(PAGE_SIZE + 1);

  if (followingIds.length) {
    query = query.in("user_id", visibleUserIds).order("id", { ascending: false });
  } else {
    query = query.order("engagement_score", { ascending: false }).order("id", { ascending: false });
  }

  const { data: posts, error } = await query;
  if (error) throw error;

  const hasMore = (posts?.length ?? 0) > PAGE_SIZE;
  const page = (posts ?? []).slice(0, PAGE_SIZE);

  await batchAttachAudio(supabase, page);

  const postIds = page.map((p: any) => p.id);
  const [likedSet, bookmarkedSet] = await Promise.all([
    getLikedIds(supabase, userId, postIds),
    getBookmarkedIds(supabase, userId, postIds),
  ]);

  const formattedPosts = await Promise.all(
    page.map((p: any) =>
      p.type === "listing"
        ? formatListing(
            supabase,
            p,
            cdnBase,
            followingSet.has(p.user_id),
            likedSet.has(p.id),
            bookmarkedSet.has(p.id),
          )
        : formatPost(
            supabase,
            p,
            cdnBase,
            likedSet.has(p.id),
            bookmarkedSet.has(p.id),
            followingSet.has(p.user_id),
          ),
    ),
  );

  return {
    posts: formattedPosts,
    next_cursor: hasMore && page.length ? btoa(String(page[page.length - 1].id)) : null,
    has_more: hasMore,
  };
}

export async function getLikedIds(supabase: SupabaseClient, userId: number, postIds: number[]): Promise<Set<number>> {
  if (!postIds.length) return new Set();
  const { data } = await supabase.from("post_likes").select("post_id").eq("user_id", userId).in("post_id", postIds);
  return new Set((data ?? []).map((r: any) => r.post_id));
}

export async function getBookmarkedIds(supabase: SupabaseClient, userId: number, postIds: number[]): Promise<Set<number>> {
  if (!postIds.length) return new Set();
  const { data } = await supabase.from("bookmarks").select("post_id").eq("user_id", userId).in("post_id", postIds);
  return new Set((data ?? []).map((r: any) => r.post_id));
}

export async function getMarketplaceFeed(
  supabase: SupabaseClient,
  userId: number,
  cdnBase: string,
  opts: {
    institutionId?: number;
    categoryId?: number;
    subtype?: string;
    minPrice?: number;
    maxPrice?: number;
    condition?: string;
    cursor?: string | null;
    listingType?: string;
    sort?: string;
  },
) {
  const cursorId = opts.cursor ? parseInt(atob(opts.cursor), 10) : Number.MAX_SAFE_INTEGER;

  // FIX: added `avatar` — see formatAuthor's comment above.
  let query = supabase
    .from("posts")
    .select("*, user:users(id, name, username, avatar_key, avatar, institution_id), media:post_media(*), listingDetail:listing_details!inner(*)")
    .eq("type", "listing")
    .eq("is_active", true)
    .eq("listingDetail.status", "available")
    .limit(MARKETPLACE_PAGE_SIZE + 1);

  if (opts.subtype) query = query.eq("subtype", opts.subtype);
  if (opts.listingType) query = query.eq("listing_type", opts.listingType);
  if (opts.condition) query = query.eq("listingDetail.condition", opts.condition);
  if (opts.minPrice !== undefined) query = query.gte("listingDetail.price_minor", Math.round(opts.minPrice * 100));
  if (opts.maxPrice !== undefined) query = query.lte("listingDetail.price_minor", Math.round(opts.maxPrice * 100));

  switch (opts.sort) {
    case "newest":
      if (cursorId < Number.MAX_SAFE_INTEGER) query = query.lt("id", cursorId);
      query = query.order("created_at", { ascending: false }).order("id", { ascending: false });
      break;
    case "price_asc":
      query = query.order("price_minor", { foreignTable: "listing_details", ascending: true }).order("id", { ascending: true });
      break;
    case "price_desc":
      query = query.order("price_minor", { foreignTable: "listing_details", ascending: false }).order("id", { ascending: false });
      break;
    default:
      if (cursorId < Number.MAX_SAFE_INTEGER) query = query.lt("id", cursorId);
      query = query
        .order("is_featured", { ascending: false })
        .order("engagement_score", { ascending: false })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });
  }

  const { data: rows, error } = await query;
  if (error) throw error;

  const hasMore = (rows?.length ?? 0) > MARKETPLACE_PAGE_SIZE;
  const page = (rows ?? []).slice(0, MARKETPLACE_PAGE_SIZE);

  await batchAttachAudio(supabase, page);

  const authorIds = [...new Set(page.map((p: any) => p.user_id))];
  const postIds = page.map((p: any) => p.id);

  const [followingSet, likedSet, bookmarkedSet] = await Promise.all([
    (async () => {
      const set = new Set<number>();
      if (authorIds.length) {
        const { data: follows } = await supabase.from("follows").select("following_id")
          .eq("follower_id", userId).in("following_id", authorIds);
        for (const f of follows ?? []) set.add(f.following_id);
      }
      return set;
    })(),
    getLikedIds(supabase, userId, postIds),
    getBookmarkedIds(supabase, userId, postIds),
  ]);

  const listings = await Promise.all(
    page.map((p: any) =>
      formatListing(
        supabase,
        p,
        cdnBase,
        followingSet.has(p.user_id),
        likedSet.has(p.id),
        bookmarkedSet.has(p.id),
      ),
    ),
  );

  return {
    listings,
    next_cursor: hasMore && page.length ? btoa(String(page[page.length - 1].id)) : null,
    has_more: hasMore,
  };
}

export async function getStoriesForUser(supabase: SupabaseClient, userId: number, cdnBase: string) {
  const { data: follows } = await supabase.from("follows").select("following_id").eq("follower_id", userId);
  const followingIds = (follows ?? []).map((f: any) => f.following_id);
  const authorIds = [...new Set([userId, ...followingIds])];

  // FIX: added `avatar` — see formatAuthor's comment above.
  const { data: stories, error } = await supabase
    .from("posts")
    .select("*, user:users(id, name, username, avatar_key, avatar), media:post_media(*), storyViews:story_views(user_id)")
    .eq("type", "story")
    .eq("is_active", true)
    .gt("expires_at", new Date().toISOString())
    .in("user_id", authorIds)
    .order("created_at", { ascending: false });

  if (error) throw error;

  await batchAttachAudio(supabase, stories ?? []);

  // Which of these stories has the viewer liked? One query for the whole
  // list instead of one per story. Story likes live in post_likes like any
  // other post's (see interactionService.toggleLike).
  const likedIds = new Set<number>();
  const storyIds = (stories ?? []).map((s: any) => s.id);
  if (storyIds.length) {
    const { data: likes } = await supabase
      .from("post_likes")
      .select("post_id")
      .eq("user_id", userId)
      .in("post_id", storyIds);
    for (const l of likes ?? []) likedIds.add(l.post_id);
  }

  const grouped = new Map<number, any[]>();
  for (const s of stories ?? []) {
    if (!grouped.has(s.user_id)) grouped.set(s.user_id, []);
    grouped.get(s.user_id)!.push(s);
  }

  const groups = await Promise.all(
    Array.from(grouped.entries()).map(async ([_authorId, userStories]) => {
      const rawAuthor = userStories[0].user;
      const hasUnseen = userStories.some(
        (s: any) => !(s.storyViews ?? []).some((v: any) => v.user_id === userId)
      );

      const [author, formattedStories] = await Promise.all([
        formatAuthor(supabase, rawAuthor, cdnBase, false),
        Promise.all(
          userStories.map((s: any) =>
            formatStory(
              supabase,
              { ...s, storyViews: (s.storyViews ?? []).filter((v: any) => v.user_id === userId) },
              userId,
              cdnBase,
            )
          )
        ),
      ]);

      return {
        author,
        has_unseen: hasUnseen,
        // Promise.all preserves order, so formattedStories[i] is userStories[i].
        stories: formattedStories.map((fs: any, i: number) => ({
          ...fs,
          likes_count: userStories[i].likes_count ?? 0,
          is_liked: likedIds.has(userStories[i].id),
        })),
      };
    }),
  );

  return groups;
}