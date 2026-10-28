/// <reference path="../_shared/deno-shim.d.ts" />
import type { Hono } from "hono";
import { serviceClient, requireAuth } from "../_shared/auth.ts";
import { json } from "../_shared/response.ts";
import { resolveAvatarUrl } from "../_shared/avatar.ts";
import { toggleBlock } from "../_shared/services/blockService.ts";
import {
  getFollowers,
  getFollowing,
  getProfile,
  getUserListings,
  getUserPosts,
  getUserReposts,
  getUserStories,
  toggleFollow,
} from "../_shared/services/userService.ts";
import {
  formatListing,
  formatPost,
  formatStory,
  getBookmarkedIds,
  getLikedIds,
  getRepostedIds,
} from "../_shared/services/feedService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

export function registerPeople(app: Hono<any, any, any>) {
  app.all("/show/:username", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);

    const result = await getProfile(supabase, c.req.param("username"), userId, CDN_BASE);
    if ("notFound" in result) return json({ message: "Not found." }, 404);
    return json(result.profile);
  });

  app.all("/posts/:username", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const cursor = c.req.query("cursor") ?? null;

    const result = await getUserPosts(supabase, c.req.param("username"), cursor);
    if ("notFound" in result) return json({ message: "Not found." }, 404);

    const ids = result.page.map((p: any) => p.id);
    const [likedSet, bookmarkedSet, repostedSet] = await Promise.all([
      getLikedIds(supabase, userId, ids),
      getBookmarkedIds(supabase, userId, ids),
      getRepostedIds(supabase, userId, ids),
    ]);

    const data = await Promise.all(result.page.map((p: any) =>
      formatPost(supabase, Object.assign(p, { _reposted: repostedSet.has(p.id) }), CDN_BASE, likedSet.has(p.id), bookmarkedSet.has(p.id))));

    return json({
      data,
      next_cursor: result.hasMore ? btoa(String(result.page[result.page.length - 1].id)) : null,
      has_more: result.hasMore,
    });
  });

  app.all("/listings/:username", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const cursor = c.req.query("cursor") ?? null;

    const result = await getUserListings(supabase, c.req.param("username"), cursor);
    if ("notFound" in result) return json({ message: "Not found." }, 404);

    const ids = result.page.map((p: any) => p.id);
    const [likedSet, bookmarkedSet] = await Promise.all([
      getLikedIds(supabase, userId, ids),
      getBookmarkedIds(supabase, userId, ids),
    ]);
    const data = await Promise.all(result.page.map((p: any) =>
      formatListing(supabase, p, CDN_BASE, false, likedSet.has(p.id), bookmarkedSet.has(p.id))));

    return json({
      data,
      next_cursor: result.hasMore ? btoa(String(result.page[result.page.length - 1].id)) : null,
      has_more: result.hasMore,
    });
  });

  app.all("/reposts/:username", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10) || 1);

    const result = await getUserReposts(supabase, c.req.param("username"), page);
    if ("notFound" in result) return json({ message: "Not found." }, 404);

    const ids = result.rows.map((r: any) => r.post.id);
    const likedSet = await getLikedIds(supabase, userId, ids);
    const bookmarkedSet = await getBookmarkedIds(supabase, userId, ids);

    // Reposted-by-the-VIEWER (not the profile owner), so the icon state is right.
    const { data: mine } = ids.length
      ? await supabase.from("reposts").select("post_id").eq("user_id", userId).in("post_id", ids)
      : { data: [] as any[] };
    const mySet = new Set((mine ?? []).map((r: any) => r.post_id));

    const data = await Promise.all(result.rows.map(async (r: any) => {
      r.post._reposted = mySet.has(r.post.id);
      const formatted = await formatPost(supabase, r.post, CDN_BASE, likedSet.has(r.post.id), bookmarkedSet.has(r.post.id));
      return { ...formatted, reposted_at: r.created_at ?? null };
    }));

    return json({ data, has_more: result.hasMore });
  });

  app.all("/stories/:username", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);

    const result = await getUserStories(supabase, c.req.param("username"), userId);
    if ("notFound" in result) return json({ message: "Not found." }, 404);

    // Same enrichment stories-index does: without it the profile viewer
    // shows 0 likes and an unfilled heart for every story.
    const likedIds = new Set<number>();
    const ids = result.stories.map((s: any) => s.id);
    if (ids.length) {
      const { data: likes } = await supabase
        .from("post_likes")
        .select("post_id")
        .eq("user_id", userId)
        .in("post_id", ids);
      for (const l of likes ?? []) likedIds.add(l.post_id);
    }

    const data = await Promise.all(
      result.stories.map(async (s: any) => ({
        ...(await formatStory(supabase, s, userId)),
        likes_count: s.likes_count ?? 0,
        is_liked: likedIds.has(s.id),
      })),
    );
    return json({ data });
  });

  app.all("/followers/:username", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const page = parseInt(c.req.query("page") ?? "1", 10);

    const result = await getFollowers(supabase, c.req.param("username"), userId, page, CDN_BASE);
    if ("notFound" in result) return json({ message: "Not found." }, 404);
    return json({ data: result.data, has_more: result.hasMore });
  });

  app.all("/following/:username", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const page = parseInt(c.req.query("page") ?? "1", 10);

    const result = await getFollowing(supabase, c.req.param("username"), userId, page, CDN_BASE);
    if ("notFound" in result) return json({ message: "Not found." }, 404);
    return json({ data: result.data, has_more: result.hasMore });
  });

  app.all("/follow/:id", async (c) => {
    const supabase = serviceClient();
    const followerId = await requireAuth(c.req.raw, supabase);
    const targetUserId = parseInt(c.req.param("id"), 10);
    if (!targetUserId) return json({ message: "Invalid user id." }, 422);

    const { data: follower } = await supabase.from("users").select("name").eq("id", followerId).single();

    const result = await toggleFollow(supabase, followerId, follower?.name ?? "Someone", targetUserId);
    if ("selfFollow" in result) return json({ message: "You cannot follow yourself." }, 422);
    if ("notFound" in result) return json({ message: "Not found." }, 404);
    return json(result);
  });

  app.all("/block/:id", async (c) => {
    const supabase = serviceClient();
    const blockerId = await requireAuth(c.req.raw, supabase);
    const targetUserId = parseInt(c.req.param("id"), 10);
    if (!targetUserId) return json({ message: "Invalid user id." }, 422);
    if (targetUserId === blockerId) return json({ message: "You cannot block yourself." }, 422);

    return json(await toggleBlock(supabase, blockerId, targetUserId));
  });

  app.all("/blocks", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);

    const { data: blocks, error } = await supabase
      .from("user_blocks")
      .select("blocked_id, created_at")
      .eq("blocker_id", userId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw error;

    const ids = (blocks ?? []).map((b: any) => b.blocked_id);
    if (!ids.length) return json({ data: [] });

    const { data: users, error: uErr } = await supabase
      .from("users")
      .select("id, name, username, avatar_key, avatar")
      .in("id", ids);
    if (uErr) throw uErr;

    const byId = new Map((users ?? []).map((u: any) => [u.id, u]));
    const data = ids
      .map((id: number) => byId.get(id))
      .filter(Boolean)
      .map((u: any) => ({
        id: u.id,
        name: u.name,
        username: u.username,
        avatar: resolveAvatarUrl(u.avatar_key ?? u.avatar),
      }));

    return json({ data });
  });
}
