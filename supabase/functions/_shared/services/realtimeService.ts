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

// Broadcasts to a single user's personal channel — for updates that need
// to reach someone regardless of which (if any) conversation screen they
// currently have open. This is what the Inbox screen subscribes to: a
// conversation-scoped broadcast only reaches someone already inside that
// specific conversation, which is fine for message bubbles but useless for
// "update this row in my conversation list" when I'm sitting on the Inbox
// looking at all of them at once.
//
// Kept as a separate function (not a loop calling broadcastToConversation
// with a synthetic channel name) so the channel-naming convention for
// user-scoped vs conversation-scoped events stays explicit and greppable.
export async function broadcastToUser(
  supabase: SupabaseClient,
  userId: number,
  event: string,
  payload: unknown,
) {
  try {
    const channel = supabase.channel(`user:${userId}`);
    await channel.send({ type: "broadcast", event, payload });
    await supabase.removeChannel(channel);
  } catch (err) {
    console.error("Realtime user broadcast failed:", err);
  }
}

// Many broadcasts, one HTTP request per 100 messages, via Realtime's REST
// endpoint. broadcastToUser above opens a channel per recipient, which is
// fine for a chat message (one recipient) but far too slow for fan-out to
// an author's whole follower list — this is what story updates use.
//
// `topic` is the plain channel name the client subscribes to (e.g.
// "stories:42"), same convention as the `user:{id}` / `conversation:{id}`
// topics above. Like the other helpers this never throws.
export async function broadcastBatch(
  messages: { topic: string; event: string; payload: Record<string, unknown> }[],
) {
  if (!messages.length) return;

  const base = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!base || !key) {
    console.error("Realtime batch broadcast skipped: missing SUPABASE_URL / service key.");
    return;
  }

  const url = `${base}/realtime/v1/api/broadcast`;

  for (let i = 0; i < messages.length; i += 100) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messages: messages.slice(i, i + 100) }),
      });
      if (!res.ok) {
        console.error("Realtime batch broadcast failed:", res.status, await res.text());
      }
    } catch (err) {
      console.error("Realtime batch broadcast error:", err);
    }
  }
}