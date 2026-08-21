import type { SupabaseClient } from "../auth.ts";

export const TYPE_LIKE = "like";
export const TYPE_REPOST = "repost";
export const TYPE_COMMENT = "comment";
export const TYPE_FOLLOW = "follow";

interface CreateNotificationInput {
  userId: number;
  actorId?: number | null;
  type: string;
  notifiableType?: string | null;
  notifiableId?: number | null;
  body?: string | null;
}

// Fire-and-forget: logs failures but never throws, so a notification
// hiccup can't break the like/repost/follow action itself.
// Ported dedup: skip if an identical notification (same user/type/actor/target)
// was already created in the last 5 minutes — matches NotificationService::create.
export async function createNotification(supabase: SupabaseClient, input: CreateNotificationInput) {
  if (input.actorId && input.actorId === input.userId) return; // never notify yourself

  if (input.notifiableId && input.actorId) {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const { data: recent } = await supabase
      .from("notifications")
      .select("id")
      .eq("user_id", input.userId)
      .eq("type", input.type)
      .eq("actor_id", input.actorId)
      .eq("notifiable_type", input.notifiableType ?? "")
      .eq("notifiable_id", input.notifiableId)
      .gte("created_at", fiveMinAgo)
      .maybeSingle();

    if (recent) return; // duplicate within the window — skip
  }

  const { error } = await supabase.from("notifications").insert({
    id: crypto.randomUUID(),
    user_id: input.userId,
    actor_id: input.actorId ?? null,
    type: input.type,
    notifiable_type: input.notifiableType ?? null,
    notifiable_id: input.notifiableId ?? null,
    body: input.body ?? null,
  });

  if (error) console.error("Failed to create notification:", error);
}