import type { SupabaseClient } from "../auth.ts";

// A presence row older than this is treated as stale — the user isn't
// actually looking at that screen anymore (app backgrounded, killed, or
// lost connectivity without sending a final "clear" heartbeat). Comfortably
// longer than the Flutter client's 25s heartbeat interval so a screen left
// open indefinitely never goes stale between beats.
const PRESENCE_TTL_MS = 45_000;

interface PresenceInput {
  screen: string | null;
  entityType?: string | null;
  entityId?: number | null;
}

export async function updatePresence(supabase: SupabaseClient, userId: number, input: PresenceInput) {
  const { error } = await supabase.from("user_presence").upsert({
    user_id: userId,
    screen: input.screen,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });

  if (error) console.error("Failed to update presence:", error);
}

// Used by notifications-dispatch right before sending a push: if the
// recipient is *currently, actively* looking at the exact entity this
// notification is about, skip the push — the in-app UI / realtime layer
// already shows it live, so a push on top of that is just noise.
//
// Falls open (returns false = "not viewing, send the push") on any lookup
// failure or missing entity info. A missed suppression costs one
// unnecessary push; a wrongly-suppressed important notification costs the
// user missing something — the asymmetry is intentional.
export async function isViewingEntity(
  supabase: SupabaseClient,
  userId: number,
  entityType: string | null,
  entityId: number | null,
): Promise<boolean> {
  if (!entityType || !entityId) return false;

  const { data, error } = await supabase
    .from("user_presence")
    .select("entity_type, entity_id, updated_at")
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data) return false;

  const age = Date.now() - new Date(data.updated_at).getTime();
  if (age > PRESENCE_TTL_MS) return false;

  return data.entity_type === entityType && data.entity_id === entityId;
}