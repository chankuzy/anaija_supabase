import type { SupabaseClient } from "../auth.ts";
import { sendPushToUser } from "./pushService.ts";
import { shouldPush, getPreferences } from "./preferencesService.ts";
import { isViewingEntity } from "./presenceService.ts";
import { isRateLimited, recordPushSent } from "./rateLimitService.ts";
import { buildCtx } from "./activityService.ts";
import { renderActivity } from "./activityCopy.ts";

const MAX_ATTEMPTS = 5;
const BACKOFF_MIN = [1, 2, 4, 8, 16];

type Outcome = { status: "sent" | "suppressed" | "retry" | "dead"; reason?: string; error?: string };
const supp = (reason: string): Outcome => ({ status: "suppressed", reason });

// kind -> legacy type name the preference/rate-limit helpers understand
const PREF_TYPE: Record<string, string> = {
  like: "like", story_like: "like", milestone: "like", repost: "repost",
  comment: "comment", reply: "comment", mention: "comment",
  follow: "follow", follow_back: "follow", message: "message",
};

export async function sweep(supabase: SupabaseClient) {
  const nowIso = new Date().toISOString();
  const stale = new Date(Date.now() - 120_000).toISOString();
  const { data } = await supabase.from("push_outbox").select("id")
    .or(`and(status.in.(pending,retry),next_attempt_at.lte.${nowIso}),and(status.eq.sending,claimed_at.lt.${stale})`)
    .order("id").limit(50);
  let n = 0;
  for (const r of data ?? []) { await dispatchOne(supabase, r.id); n++; }
  return { ok: true, processed: n };
}

export async function dispatchOne(supabase: SupabaseClient, id: number) {
  const stale = new Date(Date.now() - 120_000).toISOString();
  // Atomic claim: a duplicate webhook delivery (or a forged call) can't double-send.
  const { data: row } = await supabase.from("push_outbox")
    .update({ status: "sending", claimed_at: new Date().toISOString() })
    .eq("id", id)
    .or(`status.in.(pending,retry),and(status.eq.sending,claimed_at.lt.${stale})`)
    .select("*").maybeSingle();
  if (!row) return { ok: true, skipped: true };

  let out: Outcome;
  try {
    out = row.kind === "message" ? await processMessage(supabase, row) : await processActivity(supabase, row);
  } catch (e) {
    console.error("dispatch failed", id, e);
    out = { status: "retry", error: String((e as any)?.message ?? e) };
  }

  const attempts = (row.attempts ?? 0) + 1;
  let status = out.status;
  if (status === "retry" && attempts >= MAX_ATTEMPTS) status = "dead";
  await supabase.from("push_outbox").update({
    status, attempts, reason: out.reason ?? null, last_error: out.error ?? null,
    sent_at: status === "sent" ? new Date().toISOString() : null,
    next_attempt_at: status === "retry"
      ? new Date(Date.now() + BACKOFF_MIN[Math.min(attempts - 1, BACKOFF_MIN.length - 1)] * 60_000).toISOString()
      : row.next_attempt_at,
  }).eq("id", id);
  return { ok: true, status, reason: out.reason };
}

async function gates(
  supabase: SupabaseClient, userId: number, prefType: string,
  viewing: { entityType: string; entityId: number | null } | null,
): Promise<string | null> {
  if (!(await shouldPush(supabase, userId, prefType))) return "preferences";
  const { data: pres } = await supabase.from("user_presence")
    .select("screen, entity_type, entity_id, updated_at").eq("user_id", userId).maybeSingle();
  if (pres && Date.now() - new Date(pres.updated_at).getTime() < 45_000) {
    if (pres.entity_type === "activity" || pres.screen === "activity") return "viewing_activity";
  }
  if (viewing?.entityId && await isViewingEntity(supabase, userId, viewing.entityType, viewing.entityId)) {
    return "recipient_viewing_entity";
  }
  if (await isRateLimited(supabase, userId, prefType)) return "rate_limited";
  return null;
}

async function deliver(
  supabase: SupabaseClient, row: any, prefType: string,
  payload: { title: string; body: string; data: Record<string, string> }, tag: string,
): Promise<Outcome> {
  const res = await sendPushToUser(supabase, row.recipient_id, payload, { tag });
  if (res.devices === 0) return supp("no_device");
  if (res.delivered > 0) { await recordPushSent(supabase, row.recipient_id, prefType); return { status: "sent" }; }
  if (res.retryable > 0) return { status: "retry", error: "temporary_failure" };
  return { status: "dead", reason: "delivery_failed" };
}

function previewOf(m: any): string {
  const t = (m.body ?? "").trim();
  if (t) return t.length > 100 ? `${t.slice(0, 100).trimEnd()}…` : t;
  switch (m.type) {
    case "image": return "Photo";
    case "video": return "Video";
    case "audio": return "Voice message";
    case "post_share": return "Shared a post";
    case "listing_share": return "Shared a listing";
    default: return "Sent a message";
  }
}

async function processMessage(supabase: SupabaseClient, row: any): Promise<Outcome> {
  const { data: msg } = await supabase.from("messages")
    .select("id, conversation_id, sender_id, type, body, created_at, deleted_at, sender:users!messages_sender_id_foreign(id, name, username, avatar_key, avatar)")
    .eq("id", row.message_id).maybeSingle();
  if (!msg || msg.deleted_at) return supp("message_gone");

  const { data: part } = await supabase.from("conversation_participants")
    .select("is_muted, request_status, last_read_at")
    .eq("conversation_id", row.conversation_id).eq("user_id", row.recipient_id).maybeSingle();
  if (!part) return supp("not_participant");
  if (part.is_muted) return supp("muted");
  if (part.request_status === "declined") return supp("declined");
  if (part.last_read_at && new Date(part.last_read_at + "Z") >= new Date(msg.created_at + "Z")) return supp("already_read");

  const why = await gates(supabase, row.recipient_id, "message", { entityType: "conversations", entityId: row.conversation_id });
  if (why) return supp(why);

  const { count } = await supabase.from("messages").select("id", { count: "exact", head: true })
    .eq("conversation_id", row.conversation_id).neq("sender_id", row.recipient_id)
    .is("deleted_at", null).gt("created_at", part.last_read_at ?? "1970-01-01T00:00:00");
  const unread = Math.max(1, count ?? 1);

  const { resolveAvatarUrl } = await import("../avatar.ts");
  const sender = msg.sender as any;
  const name = sender?.name || sender?.username || "New message";
  const prefs: any = await getPreferences(supabase, row.recipient_id);
  const hide = prefs.hide_message_preview === true;

  let body: string;
  if (part.request_status === "pending") body = "sent you a message request";
  else if (unread > 1) body = `${unread} new messages`;
  else body = hide ? "sent you a message" : previewOf(msg);

  const avatar = sender ? resolveAvatarUrl(sender.avatar_key ?? sender.avatar) : null;
  const data: Record<string, string> = {
    type: "message", dest: "conversation",
    conversation_id: String(row.conversation_id), title: name,
    username: String(sender?.username ?? ""), actor_username: String(sender?.username ?? ""),
    user_id: String(sender?.id ?? ""),
  };
  if (avatar) data.avatar = avatar;
  return await deliver(supabase, row, "message", { title: name, body, data }, `chat:${row.conversation_id}`);
}

async function processActivity(supabase: SupabaseClient, row: any): Promise<Outcome> {
  const { data: item } = await supabase.from("activity_items").select("*").eq("id", row.item_id).maybeSingle();
  if (!item || item.retracted_at || item.dismissed_at) return supp("item_unavailable");
  if (item.read_at) return supp("already_read");
  if (item.expires_at && new Date(item.expires_at).getTime() < Date.now()) return supp("expired");
  if (row.event_id) {
    const { data: ev } = await supabase.from("activity_events").select("retracted_at").eq("id", row.event_id).maybeSingle();
    if (ev?.retracted_at) return supp("event_retracted");
  }

  const { data: me } = await supabase.from("users").select("id, username").eq("id", row.recipient_id).maybeSingle();
  if (!me) return supp("recipient_gone");
  const ctx = await buildCtx(supabase, { id: me.id, username: me.username ?? "" }, [item]);
  const post = item.content_id ? ctx.posts.get(item.content_id) : undefined;
  if (item.content_id && post && !post.active && !String(item.kind).startsWith("story")) return supp("content_gone");

  const prefType = PREF_TYPE[item.kind] ?? "other";
  const why = await gates(supabase, row.recipient_id, prefType,
    item.content_id ? { entityType: "posts", entityId: item.content_id } : null);
  if (why) return supp(why);

  const view = renderActivity(item, ctx);
  const first = item.actors_preview?.length ? ctx.actors.get(item.actors_preview[0]) : undefined;
  const data: Record<string, string> = {
    type: item.kind, dest: String(view.destination.kind), item_id: String(item.id),
    viewer_username: me.username ?? "",
  };
  for (const [k, v] of Object.entries(view.destination)) {
    if (k !== "kind" && v != null) data[k] = String(v);
  }
  if (first?.username) data.actor_username = first.username;
  if (first?.avatar) data.avatar = first.avatar;
  if (view.thumb) data.image = view.thumb;

  const body = view.preview ? `${view.title}: “${view.preview}”` : view.title;
  return await deliver(supabase, row, prefType, { title: "Anaija", body, data }, `item:${item.id}`);
}
