/// <reference path="../_shared/deno-shim.d.ts" />
import type { Hono } from "hono";
import type { SupabaseClient } from "../_shared/auth.ts";
import { json } from "../_shared/response.ts";
import { HttpError } from "../_shared/services/communityAccess.ts";
import { STAFF_ROLES } from "../_shared/services/platformStaff.ts";
import { audit, staffCtx } from "./core.ts";
import { liteUser, posInt, readBody, userMap } from "./util.ts";

const validRole = (r: unknown): r is (typeof STAFF_ROLES)[number] => STAFF_ROLES.includes(r as any);

async function otherSuperAdmins(supabase: SupabaseClient, except: number): Promise<number> {
  const { count, error } = await supabase.from("platform_staff").select("user_id", { count: "exact", head: true })
    .eq("role", "super_admin").is("revoked_at", null).neq("user_id", except);
  if (error) throw error;
  return count ?? 0;
}

async function activeRow(supabase: SupabaseClient, id: number) {
  const { data, error } = await supabase.from("platform_staff").select("user_id, role").eq("user_id", id).is("revoked_at", null).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, "Not found.");
  return data as { user_id: number; role: string };
}

// Staff management is super_admin only (staff.manage).
export function registerStaff(app: Hono<any, any, any>) {
  app.get("/staff", async (c) => {
    const { supabase } = await staffCtx(c, "staff.manage");
    const { data, error } = await supabase.from("platform_staff")
      .select("user_id, role, created_at").is("revoked_at", null).order("created_at", { ascending: true });
    if (error) throw error;
    const users = await userMap(supabase, (data ?? []).map((s: any) => s.user_id as number));
    return json({ data: (data ?? []).map((s: any) => ({ ...s, ...liteUser(users.get(s.user_id)) })) });
  });

  app.post("/staff", async (c) => {
    const { supabase, userId } = await staffCtx(c, "staff.manage");
    const body = await readBody(c);
    const username = String(body.username ?? "").trim().replace(/^@/, "");
    if (!username) throw new HttpError(422, "Validation failed.", { username: "Username is required." });
    if (!validRole(body.role)) throw new HttpError(422, "Validation failed.", { role: "Pick a valid role." });

    const { data: u, error } = await supabase.from("users").select("id, account_type").eq("username", username).maybeSingle();
    if (error) throw error;
    if (!u || (u.account_type ?? "person") !== "person") throw new HttpError(422, "Validation failed.", { username: "No person with that username." });

    const { data: cur } = await supabase.from("platform_staff").select("revoked_at").eq("user_id", u.id).maybeSingle();
    if (cur && !cur.revoked_at) throw new HttpError(409, "Already platform staff.");

    const { error: ue } = await supabase.from("platform_staff").upsert(
      { user_id: u.id, role: body.role, granted_by: userId, revoked_at: null, created_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    if (ue) throw ue;
    await audit(supabase, userId, "staff.grant", { kind: "user", id: u.id }, { role: body.role });
    return json({ ok: true });
  });

  app.patch("/staff/:id", async (c) => {
    const { supabase, userId } = await staffCtx(c, "staff.manage");
    const id = posInt(c.req.param("id"));
    if (!id) throw new HttpError(404, "Not found.");
    const role = (await readBody(c)).role;
    if (!validRole(role)) throw new HttpError(422, "Validation failed.", { role: "Pick a valid role." });
    if (id === userId) throw new HttpError(409, "You can't change your own role.");

    const row = await activeRow(supabase, id);
    if (row.role === role) return json({ ok: true });
    if (row.role === "super_admin" && (await otherSuperAdmins(supabase, id)) === 0) {
      throw new HttpError(409, "There must be at least one super admin.");
    }
    const { error } = await supabase.from("platform_staff").update({ role }).eq("user_id", id).is("revoked_at", null);
    if (error) throw error;
    await audit(supabase, userId, "staff.role", { kind: "user", id }, { from: row.role, to: role });
    return json({ ok: true });
  });

  app.delete("/staff/:id", async (c) => {
    const { supabase, userId } = await staffCtx(c, "staff.manage");
    const id = posInt(c.req.param("id"));
    if (!id) throw new HttpError(404, "Not found.");
    if (id === userId) throw new HttpError(409, "You can't remove yourself.");

    const row = await activeRow(supabase, id);
    if (row.role === "super_admin" && (await otherSuperAdmins(supabase, id)) === 0) {
      throw new HttpError(409, "There must be at least one super admin.");
    }
    const now = new Date().toISOString();
    const { error } = await supabase.from("platform_staff").update({ revoked_at: now }).eq("user_id", id).is("revoked_at", null);
    if (error) throw error;
    // Their per-account assignments go with the role.
    const { error: ae } = await supabase.from("platform_account_admins").update({ revoked_at: now }).eq("staff_user_id", id).is("revoked_at", null);
    if (ae) throw ae;
    await audit(supabase, userId, "staff.revoke", { kind: "user", id }, { role: row.role });
    return json({ ok: true });
  });
}
