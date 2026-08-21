import type { SupabaseClient } from "../auth.ts";

// Broadcasts an event to everyone subscribed to a conversation's channel.
// Fire-and-forget — a broadcast failure should never break the underlying
// DB write it's attached to.
export async function broadcastToConversation(
  supabase: SupabaseClient,
  conversationId: number,
  event: string,
  payload: unknown,
) {
  try {
    const channel = supabase.channel(`conversation:${conversationId}`);
    await channel.send({ type: "broadcast", event, payload });
    await supabase.removeChannel(channel);
  } catch (err) {
    console.error("Realtime broadcast failed:", err);
  }
}