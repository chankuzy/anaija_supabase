/// <reference path="../_shared/deno-shim.d.ts" />
import type { Hono } from "hono";
import type { SupabaseClient } from "../_shared/auth.ts";
import { json } from "../_shared/response.ts";
import { ACTIONS, HttpError, canManage, loadAccess } from "../_shared/services/communityAccess.ts";
import { updateCommunity } from "../_shared/services/communityService.ts";
import { audit, staffCtx } from "./core.ts";
import { readBody } from "./util.ts";

const KEY_RE = /^[a-z0-9_]{2,30}$/;
const SETTABLE = ["member", "moderator", "admin"];

async function loadCommunity(supabase: SupabaseClient, key: string) {
  if (!KEY_RE.test(key)) throw new HttpError(404, "Not found.");
  const { data, error } = await supabase.from("communities").select("*")
    .eq("platform_key", key).eq("is_platform_owned", true).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "Not found.");
  return data as any;
}

async function shape(supabase: SupabaseClient, c: any) {
  const { count } = await supabase.from("community_members").select("user_id", { count: "exact", head: true }).eq("community_id", c.id);
  return {
    key: c.platform_key, id: c.id, name: c.name, slug: c.slug, description: c.description ?? "",
    join_policy: c.join_policy ?? null, read_policy: c.read_policy ?? null,
    permissions: c.permissions ?? {},
    discoverability: c.discoverability, listed: c.discoverability === "listed",
    is_active: c.is_active !== false, status: c.status ?? "active",
    members: count ?? 0,
  };
}

export function registerCommunities(app: Hono<any, any, any>) {
  app.get("/communities", async (c) => {
    const { supabase } = await staffCtx(c, "communities.moderate");
    const { data, error } = await supabase.from("communities").select("*")
      .eq("is_platform_owned", true).not("platform_key", "is", null).order("id", { ascending: true });
    if (error) throw error;
    return json({ data: await Promise.all((data ?? []).map((r: any) => shape(supabase, r))) });
  });

  app.get("/communities/:key", async (c) => {
    const { supabase } = await staffCtx(c, "communities.moderate");
    return json(await shape(supabase, await loadCommunity(supabase, c.req.param("key") ?? "")));
  });

  // Config goes through the real updateCommunity() so community rules stay in one place. Name and slug are fixed.
  app.patch("/communities/:key", async (c) => {
    const { supabase, userId } = await staffCtx(c, "communities.manage");
    const row = await loadCommunity(supabase, c.req.param("key") ?? "");
    const body = await readBody(c);

    const errors: Record<string, string> = {};
    const patch: Record<string, unknown> = {};
    if (body.description !== undefined) {
      const v = String(body.description ?? "").trim();
      if (v.length > 500) errors.description = "Description must be 500 characters or fewer."; else patch.description = v;
    }
    if (body.permissions !== undefined) {
      const p = body.permissions;
      const bad = !p || typeof p !== "object" || Array.isArray(p) ||
        Object.entries(p).some(([k, v]) => !(ACTIONS as readonly string[]).includes(k) || !SETTABLE.includes(String(v)));
      if (bad) errors.permissions = "Invalid permissions."; else patch.permissions = { ...(row.permissions ?? {}), ...p };
    }
    if (Object.keys(errors).length) throw new HttpError(422, "Validation failed.", errors);
    if (!Object.keys(patch).length) throw new HttpError(422, "Nothing to update.");

    const access = await loadAccess(supabase, row.id, userId);
    if (!access) throw new HttpError(409, "This community isn't active.");
    if (!canManage(access)) throw new HttpError(404, "Not found.");

    await updateCommunity(supabase, access, userId, patch);

    const fresh = await loadCommunity(supabase, row.platform_key);
    const changes: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) changes[k] = { from: row[k] ?? null, to: patch[k] };
    await audit(supabase, userId, "community.edit", { kind: "community", id: row.id }, { key: row.platform_key, changes });
    return json(await shape(supabase, fresh));
  });

  // Listing is the activation switch. The SQL function writes its own audit row with this actor.
  app.post("/communities/:key/listing", async (c) => {
    const { supabase, userId } = await staffCtx(c, "communities.manage");
    const row = await loadCommunity(supabase, c.req.param("key") ?? "");
    const listed = (await readBody(c)).listed;
    if (typeof listed !== "boolean") throw new HttpError(422, "listed must be true or false.");
    const { error } = await supabase.rpc("platform_set_community_listing", { p_key: row.platform_key, p_listed: listed, p_actor: userId });
    if (error) throw error;
    return json(await shape(supabase, await loadCommunity(supabase, row.platform_key)));
  });
}
