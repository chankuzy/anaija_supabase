/// <reference path="../_shared/deno-shim.d.ts" />
import type { Hono } from "hono";
import { r2ObjectExists, resolveAvatarUrl } from "../_shared/avatar.ts";
import { json } from "../_shared/response.ts";
import { HttpError } from "../_shared/services/communityAccess.ts";
import { hasCap } from "../_shared/services/platformStaff.ts";
import { audit, staffCtx } from "./core.ts";
import { readBody } from "./util.ts";

const KEY_RE = /^[a-z0-9_]{2,30}$/;

// Staff upload under their OWN R2 prefix via storage-sign-upload; this route verifies prefix + object, then attaches the key.
export function registerAccountAvatar(app: Hono<any, any, any>) {
  app.post("/accounts/:key/avatar", async (c) => {
    const { supabase, userId, role } = await staffCtx(c, "accounts.view");
    const key = c.req.param("key") ?? "";
    if (!KEY_RE.test(key)) throw new HttpError(404, "Not found.");
    const { data: acct, error } = await supabase.from("platform_accounts")
      .select("user_id, account_key").eq("account_key", key).maybeSingle();
    if (error) throw error;
    if (!acct) throw new HttpError(404, "Not found.");

    let allowed = hasCap(role, "accounts.manage");
    if (!allowed) {
      const { data } = await supabase.from("platform_account_admins").select("can_manage")
        .eq("account_user_id", acct.user_id).eq("staff_user_id", userId).eq("can_manage", true).is("revoked_at", null).maybeSingle();
      allowed = !!data;
    }
    if (!allowed) throw new HttpError(404, "Not found.");

    const storageKey = String((await readBody(c)).storage_key ?? "");
    if (!new RegExp(`^${userId}/[0-9a-f-]{36}\\.(jpg|jpeg|png|webp)$`, "i").test(storageKey)) {
      throw new HttpError(422, "File does not belong to you.");
    }
    if (!(await r2ObjectExists(storageKey))) throw new HttpError(422, "File not found in storage.");

    const { error: ue } = await supabase.from("users")
      .update({ avatar_key: storageKey, updated_at: new Date().toISOString() }).eq("id", acct.user_id);
    if (ue) throw ue;
    await audit(supabase, userId, "account.avatar", { kind: "user", id: acct.user_id }, { key, storage_key: storageKey });
    return json({ avatar: resolveAvatarUrl(storageKey) });
  });
}
