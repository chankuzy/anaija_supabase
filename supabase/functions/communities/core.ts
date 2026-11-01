/// <reference path="../_shared/deno-shim.d.ts" />
import type { Hono } from "hono";
import { requireAuth, serviceClient, verifyTokenOptional } from "../_shared/auth.ts";
import { json } from "../_shared/response.ts";
import { HttpError, canManage, canRead, loadAccess } from "../_shared/services/communityAccess.ts";
import {
  createCommunity, getCommunityDetail, getCommunityPosts, listCommunities, listMine, updateCommunity,
} from "../_shared/services/communityService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";
const int = (v: string | undefined) => {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const EMPTY_FEED = { posts: [], next_cursor: null, has_more: false };

export function registerCore(app: Hono<any, any, any>) {
  app.get("/discover", async (c) => {
    const supabase = serviceClient();
    const viewer = await verifyTokenOptional(c.req.raw, supabase);
    return json(await listCommunities(supabase, {
      viewerId: viewer,
      search: c.req.query("search") ?? null,
      category: c.req.query("category") ?? null,
      institutionId: int(c.req.query("institution_id")),
      page: int(c.req.query("page")) ?? 1,
    }));
  });

  app.get("/mine", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    return json({ data: await listMine(supabase, userId) });
  });

  app.get("/show/:ref", async (c) => {
    const supabase = serviceClient();
    const viewer = await verifyTokenOptional(c.req.raw, supabase);
    const detail = await getCommunityDetail(supabase, c.req.param("ref"), viewer);
    if (!detail) throw new HttpError(404, "Not found.");
    const feed = detail.can.read
      ? await getCommunityPosts(supabase, detail.id, viewer, c.req.query("cursor") ?? null, CDN_BASE)
      : EMPTY_FEED;
    return json({ community: detail, ...feed });
  });

  app.get("/feed/:ref", async (c) => {
    const supabase = serviceClient();
    const viewer = await verifyTokenOptional(c.req.raw, supabase);
    const a = await loadAccess(supabase, c.req.param("ref"), viewer);
    if (!a) throw new HttpError(404, "Not found.");
    if (!canRead(a)) throw new HttpError(403, "Join this community to see its posts.");
    return json(await getCommunityPosts(supabase, a.community.id, viewer, c.req.query("cursor") ?? null, CDN_BASE));
  });

  app.post("/create", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const body = await c.req.json().catch(() => ({}));
    const id = await createCommunity(supabase, userId, body);
    return json({ community: await getCommunityDetail(supabase, id, userId) }, 201);
  });

  app.post("/update/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const id = int(c.req.param("id"));
    if (!id) return json({ message: "Invalid id." }, 422);
    const a = await loadAccess(supabase, id, userId);
    if (!a) throw new HttpError(404, "Not found.");
    if (!canManage(a)) throw new HttpError(403, "Only admins can change community settings.");
    await updateCommunity(supabase, a, userId, await c.req.json().catch(() => ({})));
    return json({ community: await getCommunityDetail(supabase, id, userId) });
  });
}
