/// <reference path="../_shared/deno-shim.d.ts" />
import type { Context, Hono } from "hono";
import type { SupabaseClient } from "../_shared/auth.ts";
import { resolveAvatarUrl } from "../_shared/avatar.ts";
import { json } from "../_shared/response.ts";
import { HttpError } from "../_shared/services/communityAccess.ts";
import { hasCap, loadStaffRole, type StaffRole } from "../_shared/services/platformStaff.ts";
import { audit, staffCtx } from "./core.ts";
import { liteUser, posInt, readBody, userMap } from "./util.ts";

const KEY_RE = /^[a-z0-9_]{2,30}$/;

interface Account {
  user_id: number; account_key: string; status: string;
  created_at: string; activated_at: string | null; suspended_at: string | null;
}
interface Access { view: boolean; edit: boolean; status: boolean; admins: boolean }

async function loadAccount(supabase: SupabaseClient, c: Context): Promise<Account> {
  const key = c.req.param("key") ?? "";
  if (!KEY_RE.test(key)) throw new HttpError(404, "Not found.");
  const { data, error } = await supabase.from("platform_accounts")
    .select("user_id, account_key, status, created_at, activated_at, suspended_at")
    .eq("account_key", key).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "Not found.");
  return data as Account;
}

// Account-level access: accounts.manage covers every account; otherwise only the assignments a staff member holds.
// Anyone without view access gets the same 404 as a missing account.
async function accessFor(supabase: SupabaseClient, userId: number, role: StaffRole, acct: Account): Promise<Access> {
  const manage = hasCap(role, "accounts.manage");
  const { data, error } = await supabase.from("platform_account_admins").select("can_manage")
    .eq("account_user_id", acct.user_id).eq("staff_user_id", userId).is("revoked_at", null).maybeSingle();
  if (error) throw error;
  const assigned = !!data;
  const access: Access = {
    view: manage || assigned,
    edit: manage || data?.can_manage === true,
    status: manage,
    admins: manage,
  };
  if (!access.view) throw new HttpError(404, "Not found.");
  return access;
}

async function shape(supabase: SupabaseClient, acct: Account, can: Access) {
  const { data: u, error } = await supabase.from("users")
    .select("id, name, username, bio, tagline, avatar_key, avatar").eq("id", acct.user_id).single();
  if (error) throw error;
  const { count } = await supabase.from("follows").select("id", { count: "exact", head: true }).eq("following_id", acct.user_id);
  return {
    key: acct.account_key, status: acct.status,
    created_at: acct.created_at, activated_at: acct.activated_at, suspended_at: acct.suspended_at,
    id: u.id, name: u.name, username: u.username, bio: u.bio, tagline: u.tagline ?? null,
    avatar: resolveAvatarUrl(u.avatar_key ?? u.avatar),
    followers: count ?? 0,
    can: { edit: can.edit, status: can.status, admins: can.admins },
  };
}

export function registerAccounts(app: Hono<any, any, any>) {
  app.get("/accounts/:key", async (c) => {
    const { supabase, userId, role } = await staffCtx(c, "accounts.view");
    const acct = await loadAccount(supabase, c);
    const can = await accessFor(supabase, userId, role, acct);
    return json(await shape(supabase, acct, can));
  });

  // Profile edit. Handles (usernames) are deliberately not editable here.
  app.patch("/accounts/:key", async (c) => {
    const { supabase, userId, role } = await staffCtx(c, "accounts.view");
    const acct = await loadAccount(supabase, c);
    const can = await accessFor(supabase, userId, role, acct);
    if (!can.edit) throw new HttpError(404, "Not found.");

    const body = await readBody(c);
    const errors: Record<string, string> = {};
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const v = String(body.name ?? "").trim();
      if (!v || v.length > 60) errors.name = "Name must be 1 to 60 characters."; else patch.name = v;
    }
    if (body.bio !== undefined) {
      const v = String(body.bio ?? "").trim();
      if (v.length > 300) errors.bio = "Bio must be 300 characters or fewer."; else patch.bio = v || null;
    }
    if (body.tagline !== undefined) {
      const v = String(body.tagline ?? "").trim();
      if (v.length > 80) errors.tagline = "Tagline must be 80 characters or fewer."; else patch.tagline = v || null;
    }
    if (Object.keys(errors).length) throw new HttpError(422, "Validation failed.", errors);
    if (!Object.keys(patch).length) throw new HttpError(422, "Nothing to update.");

    const { data: before, error: be } = await supabase.from("users")
      .select("name, bio, tagline").eq("id", acct.user_id).single();
    if (be) throw be;
    const { error } = await supabase.from("users")
      .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", acct.user_id);
    if (error) throw error;

    const changes: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) changes[k] = { from: (before as any)[k] ?? null, to: patch[k] };
    await audit(supabase, userId, "account.edit", { kind: "user", id: acct.user_id }, { key: acct.account_key, changes });
    return json(await shape(supabase, acct, can));
  });

  // activate | suspend | recover. The SQL function writes the audit row itself (with this actor).
  app.post("/accounts/:key/status", async (c) => {
    const { supabase, userId, role } = await staffCtx(c, "accounts.manage");
    const acct = await loadAccount(supabase, c);
    const can = await accessFor(supabase, userId, role, acct);
    const action = String((await readBody(c)).action ?? "");
    if (!["activate", "suspend", "recover"].includes(action)) throw new HttpError(422, "Unknown action.");

    let next: string | null = null;
    if (action === "activate" && acct.status === "provisioned") next = "active";
    else if (action === "suspend" && acct.status !== "suspended") next = "suspended";
    else if (action === "recover" && acct.status === "suspended") next = acct.activated_at ? "active" : "provisioned";
    if (!next) throw new HttpError(409, `Can't ${action} an account that is ${acct.status}.`);

    if (action === "activate") {
      const { data: u } = await supabase.from("users").select("name, username").eq("id", acct.user_id).single();
      if (!u?.name || !u?.username) throw new HttpError(422, "Set a name before activating.");
    }

    const { error } = await supabase.rpc("platform_set_account_status", { p_key: acct.account_key, p_status: next, p_actor: userId });
    if (error) throw error;
    const { data: fresh, error: fe } = await supabase.from("platform_accounts")
      .select("user_id, account_key, status, created_at, activated_at, suspended_at").eq("user_id", acct.user_id).single();
    if (fe) throw fe;
    return json(await shape(supabase, fresh as Account, can));
  });

  // Who may publish or manage this account. Staff are assigned here; roles themselves live in /staff.
  app.get("/accounts/:key/admins", async (c) => {
    const { supabase, userId, role } = await staffCtx(c, "accounts.manage");
    const acct = await loadAccount(supabase, c);
    await accessFor(supabase, userId, role, acct);

    const { data: rows, error } = await supabase.from("platform_account_admins")
      .select("staff_user_id, can_publish, can_manage").eq("account_user_id", acct.user_id).is("revoked_at", null);
    if (error) throw error;
    const { data: staff, error: se } = await supabase.from("platform_staff").select("user_id, role").is("revoked_at", null);
    if (se) throw se;

    const roleBy = new Map((staff ?? []).map((s: any) => [s.user_id as number, s.role as string]));
    const users = await userMap(supabase, (staff ?? []).map((s: any) => s.user_id as number));
    const assigned = new Set((rows ?? []).map((r: any) => r.staff_user_id as number));

    return json({
      data: (rows ?? []).filter((r: any) => roleBy.has(r.staff_user_id)).map((r: any) => ({
        user_id: r.staff_user_id, role: roleBy.get(r.staff_user_id),
        can_publish: r.can_publish, can_manage: r.can_manage, ...liteUser(users.get(r.staff_user_id)),
      })),
      candidates: (staff ?? []).filter((s: any) => !assigned.has(s.user_id)).map((s: any) => ({
        user_id: s.user_id, role: s.role, ...liteUser(users.get(s.user_id)),
      })),
    });
  });

  // Assign or update (upsert; also reinstates a revoked assignment).
  app.post("/accounts/:key/admins", async (c) => {
    const { supabase, userId, role } = await staffCtx(c, "accounts.manage");
    const acct = await loadAccount(supabase, c);
    await accessFor(supabase, userId, role, acct);
    const body = await readBody(c);
    const target = posInt(body.staff_user_id);
    if (!target) throw new HttpError(422, "staff_user_id is required.");
    if (!(await loadStaffRole(supabase, target))) throw new HttpError(422, "That person is not active platform staff.");

    const { data: existing } = await supabase.from("platform_account_admins").select("can_publish, can_manage")
      .eq("account_user_id", acct.user_id).eq("staff_user_id", target).maybeSingle();
    const can_publish = typeof body.can_publish === "boolean" ? body.can_publish : (existing?.can_publish ?? true);
    const can_manage = typeof body.can_manage === "boolean" ? body.can_manage : (existing?.can_manage ?? false);

    const { error } = await supabase.from("platform_account_admins").upsert(
      { account_user_id: acct.user_id, staff_user_id: target, can_publish, can_manage, granted_by: userId, revoked_at: null },
      { onConflict: "account_user_id,staff_user_id" },
    );
    if (error) throw error;
    await audit(supabase, userId, "account.admin.set", { kind: "user", id: acct.user_id },
      { key: acct.account_key, staff_user_id: target, can_publish, can_manage });
    return json({ ok: true });
  });

  // Body carries the staff id (the web proxy caps paths at four segments).
  app.delete("/accounts/:key/admins", async (c) => {
    const { supabase, userId, role } = await staffCtx(c, "accounts.manage");
    const acct = await loadAccount(supabase, c);
    await accessFor(supabase, userId, role, acct);
    const target = posInt((await readBody(c)).staff_user_id);
    if (!target) throw new HttpError(422, "staff_user_id is required.");

    const { error } = await supabase.from("platform_account_admins").update({ revoked_at: new Date().toISOString() })
      .eq("account_user_id", acct.user_id).eq("staff_user_id", target).is("revoked_at", null);
    if (error) throw error;
    await audit(supabase, userId, "account.admin.remove", { kind: "user", id: acct.user_id },
      { key: acct.account_key, staff_user_id: target });
    return json({ ok: true });
  });
}
