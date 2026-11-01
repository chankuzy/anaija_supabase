/// <reference path="../_shared/deno-shim.d.ts" />
import type { Hono } from "hono";
import { requireAuth, serviceClient } from "../_shared/auth.ts";
import { json } from "../_shared/response.ts";
import { HttpError, loadAccess } from "../_shared/services/communityAccess.ts";

const MODES = ["all", "mentions", "none"];

// A member's own notification preferences for one community. Chat push follows chat_notify
// (mirrored to the chat participant's mute flag); announce_notify gates announcement alerts.
export function registerPrefs(app: Hono<any, any, any>) {
  async function ctx(c: any) {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const a = await loadAccess(supabase, c.req.param("id"), userId);
    if (!a || a.banned) throw new HttpError(404, "Not found.");
    if (!a.role) throw new HttpError(403, "Join this community first.");
    return { supabase, userId, a };
  }

  app.get("/prefs/:id", async (c) => {
    const { supabase, userId, a } = await ctx(c);
    const { data } = await supabase.from("community_members").select("chat_notify, announce_notify")
      .eq("community_id", a.community.id).eq("user_id", userId).maybeSingle();
    return json({ chat_notify: data?.chat_notify ?? "mentions", announce_notify: data?.announce_notify ?? true });
  });

  app.post("/prefs/:id", async (c) => {
    const { supabase, userId, a } = await ctx(c);
    const b = await c.req.json().catch(() => ({}));
    const patch: Record<string, unknown> = {};
    if (b?.chat_notify !== undefined) {
      if (!MODES.includes(b.chat_notify)) return json({ message: "Invalid chat setting." }, 422);
      patch.chat_notify = b.chat_notify;
    }
    if (b?.announce_notify !== undefined) {
      if (typeof b.announce_notify !== "boolean") return json({ message: "Invalid announcement setting." }, 422);
      patch.announce_notify = b.announce_notify;
    }
    if (!Object.keys(patch).length) return json({ message: "Nothing to update." }, 422);
    const { error } = await supabase.from("community_members").update(patch)
      .eq("community_id", a.community.id).eq("user_id", userId);
    if (error) throw error;
    if (patch.chat_notify && a.community.chat_conversation_id) {
      await supabase.from("conversation_participants").update({ is_muted: patch.chat_notify !== "all" })
        .eq("conversation_id", a.community.chat_conversation_id).eq("user_id", userId);
    }
    return json({ ok: true });
  });
}
