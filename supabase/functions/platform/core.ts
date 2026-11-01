/// <reference path="../_shared/deno-shim.d.ts" />
import type { Context, Hono } from "hono";
import { requireAuth, serviceClient, type SupabaseClient } from "../_shared/auth.ts";
import { resolveAvatarUrl } from "../_shared/avatar.ts";
import { json } from "../_shared/response.ts";
import { HttpError } from "../_shared/services/communityAccess.ts";
import { ROLE_CAPS, hasCap, loadStaffRole, type Cap, type StaffRole } from "../_shared/services/platformStaff.ts";

const int = (v: unknown) => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** Authenticates, then requires active platform staff (and the capability, if given). Anyone else gets a plain 404. */
export async function staffCtx(c: Context, cap?: Cap): Promise<{ supabase: SupabaseClient; userId: number; role: StaffRole }> {
  const supabase = serviceClient();
  const userId = await requireAuth(c.req.raw, supabase);
  const role = await loadStaffRole(supabase, userId);
  if (!role || (cap && !hasCap(role, cap))) throw new HttpError(404, "Not found.");
  return { supabase, userId, role };
}

/** Append-only audit record. Throws on failure so a sensitive action never succeeds unaudited. */
export async function audit(
  supabase: SupabaseClient, actor: number, action: string,
  target: { kind?: string; id?: number } = {}, detail: Record<string, unknown> = {},
) {
  const { error } = await supabase.from("platform_audit_log").insert({
    actor_id: actor, action, target_kind: target.kind ?? null, target_id: target.id ?? null, detail,
  });
  if (error) throw error;
}

export function registerCore(app: Hono<any, any, any>) {
  // Who am I to the platform? The admin UI calls this first; non-staff get 404.
  app.get("/me", async (c) => {
    const { userId, role } = await staffCtx(c);
    return json({ user_id: userId, role, capabilities: ROLE_CAPS[role] });
  });

  app.get("/accounts", async (c) => {
    const { supabase, userId, role } = await staffCtx(c, "accounts.view");

    // Admins with accounts.manage see every official account; everyone else only the ones they are assigned to.
    let allowed: number[] | null = null;
    if (!hasCap(role, "accounts.manage")) {
      const { data } = await supabase.from("platform_account_admins").select("account_user_id")
        .eq("staff_user_id", userId).is("revoked_at", null);
      allowed = (data ?? []).map((r: any) => r.account_user_id as number);
      if (!allowed.length) return json({ data: [] });
    }

    let q = supabase.from("platform_accounts")
      .select("account_key, status, created_at, activated_at, suspended_at, user:users!platform_accounts_user_id_fkey(id, name, username, bio, avatar_key, avatar)")
      .order("created_at", { ascending: true });
    if (allowed) q = q.in("user_id", allowed);
    const { data, error } = await q;
    if (error) throw error;

    const rows = (data ?? []).filter((r: any) => r.user);
    const followers = await Promise.all(rows.map((r: any) =>
      supabase.from("follows").select("id", { count: "exact", head: true }).eq("following_id", r.user.id)));
    return json({
      data: rows.map((r: any, i: number) => ({
        key: r.account_key, status: r.status,
        created_at: r.created_at, activated_at: r.activated_at, suspended_at: r.suspended_at,
        id: r.user.id, name: r.user.name, username: r.user.username, bio: r.user.bio,
        avatar: resolveAvatarUrl(r.user.avatar_key ?? r.user.avatar),
        followers: followers[i].count ?? 0,
      })),
    });
  });

  app.get("/audit", async (c) => {
    const { supabase } = await staffCtx(c, "audit.view");
    const cursor = int(c.req.query("cursor")) ?? Number.MAX_SAFE_INTEGER;
    const { data, error } = await supabase.from("platform_audit_log")
      .select("id, actor_id, action, target_kind, target_id, detail, created_at")
      .lt("id", cursor).order("id", { ascending: false }).limit(51);
    if (error) throw error;
    const rows = data ?? [];
    const page = rows.slice(0, 50);

    const ids = [...new Set(page.map((r: any) => r.actor_id).filter(Boolean))] as number[];
    const { data: users } = ids.length
      ? await supabase.from("users").select("id, name, username").in("id", ids)
      : { data: [] as any[] };
    const by = new Map((users ?? []).map((u: any) => [u.id, u]));
    return json({
      data: page.map((r: any) => ({ ...r, actor: by.get(r.actor_id) ?? null })),
      next_cursor: rows.length > 50 ? String(page[page.length - 1].id) : null,
    });
  });
}
