/// <reference path="../_shared/deno-shim.d.ts" />
import type { Hono } from "hono";
import { requireAuth, serviceClient, verifyTokenOptional } from "../_shared/auth.ts";
import { resolveAvatarUrl } from "../_shared/avatar.ts";
import { json } from "../_shared/response.ts";
import { HttpError, can, isStaff, loadAccess } from "../_shared/services/communityAccess.ts";
import { joinCommunity, leaveCommunity, notifyDecision } from "../_shared/services/communityService.ts";

const int = (v: string | undefined) => {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const hex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes))).map((b) => b.toString(16).padStart(2, "0")).join("");

export function registerMembership(app: Hono<any, any, any>) {
  app.post("/join/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const id = int(c.req.param("id"));
    if (!id) return json({ message: "Invalid id." }, 422);
    const body = await c.req.json().catch(() => ({}));
    const r = await joinCommunity(supabase, id, userId, typeof body?.message === "string" ? body.message : null);
    switch (r.state) {
      case "joined": return json({ status: "joined", is_member: true, members_count: r.members_count });
      case "already_member": return json({ status: "already_member", is_member: true, members_count: r.members_count });
      case "requested":
      case "already_requested": return json({ status: r.state, is_member: false, request_status: "pending" }, 202);
      case "invite_only": return json({ status: "invite_only", message: "This community is invite-only." }, 403);
      case "banned": return json({ status: "banned", message: "You can't join this community." }, 403);
      case "not_found": return json({ message: "Not found." }, 404);
      default: return json({ status: r.state, message: "You can't join this community." }, 403);
    }
  });

  app.post("/leave/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const id = int(c.req.param("id"));
    if (!id) return json({ message: "Invalid id." }, 422);
    const r = await leaveCommunity(supabase, id, userId);
    if (r.state === "owner") throw new HttpError(422, "Owners can't leave. Transfer ownership first.");
    return json({ is_member: false, status: r.state });
  });

  // ── join requests ──────────────────────────────────────────────────────

  app.get("/requests/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const a = await loadAccess(supabase, int(c.req.param("id")) ?? 0, userId);
    if (!a) throw new HttpError(404, "Not found.");
    if (!isStaff(a)) throw new HttpError(403, "Only moderators can see join requests.");
    const { data, error } = await supabase.from("community_join_requests")
      .select("id, message, created_at, user:users!community_join_requests_user_id_fkey(id, name, username, avatar_key, avatar)")
      .eq("community_id", a.community.id).eq("status", "pending").order("created_at", { ascending: true }).limit(100);
    if (error) throw error;
    return json({
      data: (data ?? []).filter((r: any) => r.user).map((r: any) => ({
        id: r.id, message: r.message, created_at: r.created_at,
        user: { id: r.user.id, name: r.user.name, username: r.user.username, avatar: resolveAvatarUrl(r.user.avatar_key ?? r.user.avatar) },
      })),
    });
  });

  app.post("/decide/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const a = await loadAccess(supabase, int(c.req.param("id")) ?? 0, userId);
    if (!a) throw new HttpError(404, "Not found.");
    if (!isStaff(a)) throw new HttpError(403, "Only moderators can decide join requests.");
    const body = await c.req.json().catch(() => ({}));
    const requestId = Number(body?.request_id);
    if (!Number.isInteger(requestId) || requestId <= 0 || typeof body?.approve !== "boolean") {
      return json({ message: "request_id and approve are required." }, 422);
    }
    // The request must belong to THIS community: moderators of one community can't decide another's.
    const { data: req } = await supabase.from("community_join_requests").select("community_id")
      .eq("id", requestId).maybeSingle();
    if (!req || req.community_id !== a.community.id) throw new HttpError(404, "Request not found.");

    const { data, error } = await supabase.rpc("community_decide_request", {
      p_request: requestId, p_actor: userId, p_approve: body.approve,
    });
    if (error) throw error;
    const result = (data as any)?.result as string;
    if (result === "approved" || result === "rejected") {
      await notifyDecision(supabase, a.community.id, (data as any).user_id, userId, result === "approved");
    }
    if (result === "already_decided") throw new HttpError(409, "This request was already decided.");
    return json({ result, user_id: (data as any)?.user_id ?? null });
  });

  // ── invitations ────────────────────────────────────────────────────────

  app.get("/invites/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const a = await loadAccess(supabase, int(c.req.param("id")) ?? 0, userId);
    if (!a) throw new HttpError(404, "Not found.");
    if (!can(a, "invite")) throw new HttpError(403, "You can't manage invitations here.");
    const { data, error } = await supabase.from("community_invites")
      .select("id, token, label, max_uses, uses, expires_at, revoked_at, created_at")
      .eq("community_id", a.community.id).order("id", { ascending: false }).limit(50);
    if (error) throw error;
    return json({ data: (data ?? []).map((i: any) => ({ ...i, path: `/join/${i.token}` })) });
  });

  app.post("/invites/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const a = await loadAccess(supabase, int(c.req.param("id")) ?? 0, userId);
    if (!a) throw new HttpError(404, "Not found.");
    if (!can(a, "invite")) throw new HttpError(403, "You can't create invitations here.");
    const body = await c.req.json().catch(() => ({}));

    const errors: Record<string, string> = {};
    let maxUses: number | null = null;
    if (body?.max_uses != null && body.max_uses !== "") {
      maxUses = Number(body.max_uses);
      if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 5000) errors.max_uses = "Use a number between 1 and 5000.";
    }
    let expiresAt: string | null = null;
    if (body?.expires_hours != null && body.expires_hours !== "") {
      const h = Number(body.expires_hours);
      if (!Number.isFinite(h) || h < 1 || h > 24 * 365) errors.expires_hours = "Choose between 1 hour and 1 year.";
      else expiresAt = new Date(Date.now() + h * 3_600_000).toISOString();
    }
    if (Object.keys(errors).length) throw new HttpError(422, "Validation failed.", errors);

    const { count } = await supabase.from("community_invites").select("id", { count: "exact", head: true })
      .eq("community_id", a.community.id).is("revoked_at", null);
    if ((count ?? 0) >= 25) throw new HttpError(422, "Revoke an old invitation before creating another.");

    const token = hex(24); // 192 bits, URL-safe, starts alphanumeric
    const label = typeof body?.label === "string" ? body.label.trim().slice(0, 60) || null : null;
    const { data, error } = await supabase.from("community_invites")
      .insert({ community_id: a.community.id, token, label, created_by: userId, max_uses: maxUses, expires_at: expiresAt })
      .select("id, token, label, max_uses, uses, expires_at, created_at").single();
    if (error) throw error;
    return json({ invite: { ...data, path: `/join/${data.token}` } }, 201);
  });

  app.post("/invite-revoke/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const a = await loadAccess(supabase, int(c.req.param("id")) ?? 0, userId);
    if (!a) throw new HttpError(404, "Not found.");
    if (!can(a, "invite")) throw new HttpError(403, "You can't manage invitations here.");
    const body = await c.req.json().catch(() => ({}));
    const inviteId = Number(body?.invite_id);
    if (!Number.isInteger(inviteId) || inviteId <= 0) return json({ message: "invite_id is required." }, 422);
    const { data, error } = await supabase.from("community_invites")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", inviteId).eq("community_id", a.community.id).is("revoked_at", null).select("id").maybeSingle();
    if (error) throw error;
    if (!data) throw new HttpError(404, "Invitation not found.");
    await supabase.from("community_mod_log").insert({ community_id: a.community.id, actor_id: userId, action: "revoke_invite", target_id: inviteId });
    return json({ ok: true });
  });

  // What the landing page shows before sign-in: name, avatar, member count. Nothing about content.
  app.get("/invite-preview/:token", async (c) => {
    const supabase = serviceClient();
    const viewer = await verifyTokenOptional(c.req.raw, supabase);
    const { data: i } = await supabase.from("community_invites")
      .select("community_id, max_uses, uses, expires_at, revoked_at").eq("token", c.req.param("token")).maybeSingle();
    if (!i || i.revoked_at) return json({ state: "invalid" });
    const { data: com } = await supabase.from("communities")
      .select("id, name, slug, avatar_key, members_count, is_active, status").eq("id", i.community_id).maybeSingle();
    if (!com || !com.is_active || com.status !== "active") return json({ state: "invalid" });

    let state = "valid";
    if (i.expires_at && new Date(i.expires_at) <= new Date()) state = "expired";
    else if (i.max_uses != null && i.uses >= i.max_uses) state = "exhausted";

    let isMember = false;
    if (viewer) {
      const { data: m } = await supabase.from("community_members").select("role")
        .eq("community_id", com.id).eq("user_id", viewer).maybeSingle();
      isMember = !!m;
    }
    return json({
      state, is_member: isMember,
      community: { name: com.name, slug: com.slug, avatar: resolveAvatarUrl(com.avatar_key), members_count: com.members_count },
    });
  });

  app.post("/invite-redeem/:token", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const { data, error } = await supabase.rpc("community_redeem_invite", { p_token: c.req.param("token"), p_user: userId });
    if (error) throw error;
    const r = data as { result: string; slug?: string; community_id?: number };
    switch (r.result) {
      case "joined":
      case "already_member": return json({ result: r.result, slug: r.slug, community_id: r.community_id });
      case "expired":
      case "exhausted": return json({ result: r.result, slug: r.slug, message: "This invitation is no longer valid." }, 410);
      case "banned": return json({ result: "banned", message: "You can't join this community." }, 403);
      default: return json({ result: "invalid", message: "This invitation isn't valid." }, 404);
    }
  });
}
