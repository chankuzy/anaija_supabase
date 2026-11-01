/// <reference path="../_shared/deno-shim.d.ts" />
import type { Hono } from "hono";
import { requireAuth, serviceClient, type SupabaseClient } from "../_shared/auth.ts";
import { resolveAvatarUrl } from "../_shared/avatar.ts";
import { json } from "../_shared/response.ts";
import { HttpError, canManage, isStaff, loadAccess, rank, type Access } from "../_shared/services/communityAccess.ts";
import { notify } from "../_shared/services/communityService.ts";

const int = (v: unknown) => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const KINDS = ["class_rep", "course_rep", "dept_exec", "contributor"];
const PER_PAGE = 50;

async function target(supabase: SupabaseClient, cid: number, uid: number) {
  const { data } = await supabase.from("community_members").select("role").eq("community_id", cid).eq("user_id", uid).maybeSingle();
  return (data?.role as string | undefined) ?? null;
}
const mustOutrank = (a: Access, role: string | null) => {
  if (role === "owner" || rank(a.role) <= rank(role)) throw new HttpError(403, "You can't do that to this member.");
};
const log = (supabase: SupabaseClient, cid: number, actor: number, action: string, user: number | null, note?: string) =>
  supabase.from("community_mod_log").insert({ community_id: cid, actor_id: actor, action, target_user_id: user, target_kind: "user", note: note?.slice(0, 200) ?? null });
const tell = (supabase: SupabaseClient, a: Access, actor: number, user: number, action: string, reason: string | null) =>
  notify(supabase, {
    recipient: user, actor, kind: "community_moderation",
    groupKey: `community_moderation:${action}:${a.community.id}:${user}:${Date.now()}`,
    dedupe: `community_moderation:${action}:${a.community.id}:${user}:${Date.now()}`,
    community: a.community.id, payload: { community: a.community.name, slug: a.community.slug, action, reason },
  });

async function staffAccess(c: any, level: "staff" | "admin") {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const a = await loadAccess(supabase, int(c.req.param("id")) ?? 0, userId);
  if (!a) throw new HttpError(404, "Not found.");
  if (level === "admin" ? !canManage(a) : !isStaff(a)) {
    throw new HttpError(403, level === "admin" ? "Only admins can do that." : "Only moderators can do that.");
  }
  return { supabase, userId, a, body: await c.req.json().catch(() => ({})) };
}

export function registerMembers(app: Hono<any, any, any>) {
  // Members only. Directory shows name, username, avatar, role and designations: nothing else.
  app.get("/members/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const a = await loadAccess(supabase, int(c.req.param("id")) ?? 0, userId);
    if (!a || a.banned) throw new HttpError(404, "Not found.");
    if (!a.role) throw new HttpError(403, "Join this community to see its members.");
    const page = int(c.req.query("page")) ?? 1;
    const from = (page - 1) * PER_PAGE;
    const { data, error } = await supabase.from("community_members")
      .select("role, joined_at, user:users!community_members_user_id_fkey(id, name, username, avatar_key, avatar, is_verified, campus_verified)")
      .eq("community_id", a.community.id).order("joined_at", { ascending: false }).range(from, from + PER_PAGE);
    if (error) throw error;
    const rows = (data ?? []).filter((r: any) => r.user);
    const slice = rows.slice(0, PER_PAGE);
    const ids = slice.map((r: any) => r.user.id);
    const { data: ds } = ids.length
      ? await supabase.from("community_designations").select("id, user_id, kind, scope_label")
        .eq("community_id", a.community.id).is("revoked_at", null).in("user_id", ids)
      : { data: [] as any[] };
    const by = new Map<number, any[]>();
    for (const d of ds ?? []) by.set(d.user_id, [...(by.get(d.user_id) ?? []), { id: d.id, kind: d.kind, scope_label: d.scope_label }]);
    return json({
      data: slice.map((r: any) => ({
        id: r.user.id, name: r.user.name, username: r.user.username,
        avatar: resolveAvatarUrl(r.user.avatar_key ?? r.user.avatar),
        is_verified: !!r.user.is_verified, campus_verified: !!r.user.campus_verified,
        role: r.role, joined_at: r.joined_at, designations: by.get(r.user.id) ?? [],
      })),
      has_more: (data ?? []).length > PER_PAGE,
    });
  });

  app.post("/member-role/:id", async (c) => {
    const { supabase, userId, a, body } = await staffAccess(c, "admin");
    const uid = int(body?.user_id);
    if (!uid || !["member", "moderator", "admin"].includes(body?.role)) return json({ message: "user_id and role are required." }, 422);
    if (body.role === "admin" && a.role !== "owner") throw new HttpError(403, "Only the owner can appoint admins.");
    const role = await target(supabase, a.community.id, uid);
    if (!role) throw new HttpError(404, "Not a member.");
    mustOutrank(a, role);
    await supabase.from("community_members").update({ role: body.role }).eq("community_id", a.community.id).eq("user_id", uid);
    await supabase.from("conversation_participants").update({ role: body.role === "admin" ? "admin" : "member" })
      .eq("conversation_id", a.community.chat_conversation_id).eq("user_id", uid);
    await log(supabase, a.community.id, userId, "set_role", uid, `${role} -> ${body.role}`);
    return json({ role: body.role });
  });

  app.post("/member-remove/:id", async (c) => {
    const { supabase, userId, a, body } = await staffAccess(c, "staff");
    const uid = int(body?.user_id);
    if (!uid || uid === userId) return json({ message: "user_id is required." }, 422);
    const role = await target(supabase, a.community.id, uid);
    if (!role) throw new HttpError(404, "Not a member.");
    mustOutrank(a, role);
    await supabase.from("community_designations").update({ revoked_at: new Date().toISOString(), revoked_by: userId })
      .eq("community_id", a.community.id).eq("user_id", uid).is("revoked_at", null);
    const { error } = await supabase.from("community_members").delete().eq("community_id", a.community.id).eq("user_id", uid);
    if (error) throw error;
    await log(supabase, a.community.id, userId, "remove_member", uid);
    await tell(supabase, a, userId, uid, "removed", null);
    return json({ ok: true });
  });

  app.post("/member-mute/:id", async (c) => {
    const { supabase, userId, a, body } = await staffAccess(c, "staff");
    const uid = int(body?.user_id);
    const hours = Number(body?.hours ?? 0);
    if (!uid || uid === userId || !Number.isFinite(hours) || hours < 0 || hours > 24 * 90) return json({ message: "user_id and hours (0 to unmute) are required." }, 422);
    const role = await target(supabase, a.community.id, uid);
    if (!role) throw new HttpError(404, "Not a member.");
    mustOutrank(a, role);
    const until = hours > 0 ? new Date(Date.now() + hours * 3_600_000).toISOString() : null;
    await supabase.from("community_members").update({ muted_until: until }).eq("community_id", a.community.id).eq("user_id", uid);
    await log(supabase, a.community.id, userId, hours > 0 ? "mute" : "unmute", uid, hours > 0 ? `${hours}h` : undefined);
    if (until) await tell(supabase, a, userId, uid, "muted", null);
    return json({ muted_until: until });
  });

  app.post("/ban/:id", async (c) => {
    const { supabase, userId, a, body } = await staffAccess(c, "staff");
    const uid = int(body?.user_id);
    if (!uid || uid === userId) return json({ message: "user_id is required." }, 422);
    const role = await target(supabase, a.community.id, uid);
    mustOutrank(a, role);
    const hours = body?.expires_hours != null ? Number(body.expires_hours) : null;
    if (hours !== null && (!Number.isFinite(hours) || hours < 1 || hours > 24 * 365)) return json({ message: "Invalid expiry." }, 422);
    const reason = typeof body?.reason === "string" ? body.reason.slice(0, 300) : "";
    const { error } = await supabase.rpc("community_ban", {
      p_community: a.community.id, p_user: uid, p_actor: userId, p_reason: reason,
      p_expires: hours ? new Date(Date.now() + hours * 3_600_000).toISOString() : null,
    });
    if (error) throw error;
    await tell(supabase, a, userId, uid, "banned", reason || null);
    return json({ ok: true });
  });

  app.post("/unban/:id", async (c) => {
    const { supabase, userId, a, body } = await staffAccess(c, "staff");
    const uid = int(body?.user_id);
    if (!uid) return json({ message: "user_id is required." }, 422);
    await supabase.from("community_bans").delete().eq("community_id", a.community.id).eq("user_id", uid);
    await log(supabase, a.community.id, userId, "unban", uid);
    return json({ ok: true });
  });

  app.get("/bans/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const a = await loadAccess(supabase, int(c.req.param("id")) ?? 0, userId);
    if (!a) throw new HttpError(404, "Not found.");
    if (!isStaff(a)) throw new HttpError(403, "Only moderators can see bans.");
    const { data, error } = await supabase.from("community_bans")
      .select("user_id, reason, expires_at, created_at, user:users!community_bans_user_id_fkey(id, name, username, avatar_key, avatar)")
      .eq("community_id", a.community.id).order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    return json({
      data: (data ?? []).filter((r: any) => r.user).map((r: any) => ({
        user: { id: r.user.id, name: r.user.name, username: r.user.username, avatar: resolveAvatarUrl(r.user.avatar_key ?? r.user.avatar) },
        reason: r.reason, expires_at: r.expires_at, created_at: r.created_at,
      })),
    });
  });

  // Designations are visible titles. They never grant admin power; `can_announce` is the one explicit capability.
  app.post("/designation/:id", async (c) => {
    const { supabase, userId, a, body } = await staffAccess(c, "admin");
    const uid = int(body?.user_id);
    if (!uid || !KINDS.includes(body?.kind)) return json({ message: "user_id and kind are required." }, 422);
    if (!(await target(supabase, a.community.id, uid))) throw new HttpError(404, "Not a member.");
    const scope = typeof body?.scope_label === "string" ? body.scope_label.trim().slice(0, 40) || null : null;
    const { data, error } = await supabase.from("community_designations")
      .insert({ community_id: a.community.id, user_id: uid, kind: body.kind, scope_label: scope, can_announce: body?.can_announce === true, granted_by: userId })
      .select("id, kind, scope_label, can_announce").single();
    if (error) {
      if ((error as { code?: string }).code === "23505") throw new HttpError(409, "They already hold this designation.");
      throw error;
    }
    await log(supabase, a.community.id, userId, "grant_designation", uid, `${body.kind}${scope ? ` ${scope}` : ""}`);
    return json({ designation: data }, 201);
  });

  app.post("/designation-revoke/:id", async (c) => {
    const { supabase, userId, a, body } = await staffAccess(c, "admin");
    const did = int(body?.designation_id);
    if (!did) return json({ message: "designation_id is required." }, 422);
    const { data, error } = await supabase.from("community_designations")
      .update({ revoked_at: new Date().toISOString(), revoked_by: userId })
      .eq("id", did).eq("community_id", a.community.id).is("revoked_at", null).select("user_id").maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(404, "Designation not found.");
    await log(supabase, a.community.id, userId, "revoke_designation", data.user_id);
    return json({ ok: true });
  });
}
