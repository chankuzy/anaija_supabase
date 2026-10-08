import type { SupabaseClient } from "../auth.ts";

interface LogInput {
  notificationId: string;
  userId: number;
  type: string;
  decision: "sent" | "suppressed";
  reason?: string | null;
}

// Fire-and-forget, same pattern as the notification-creation helpers — a
// logging hiccup must never affect whether a push actually sends. Writes
// to both console (shows up in the dashboard's live function logs) and
// the notification_dispatch_log table (queryable after the fact), so a
// "why didn't this arrive" investigation doesn't need to correlate two
// different sources by hand — the table is the durable copy of the same
// trace the console line shows in the moment.
export async function logDispatchDecision(supabase: SupabaseClient, input: LogInput) {
  const line = input.decision === "sent"
    ? `[dispatch] SEND notification=${input.notificationId} user=${input.userId} type=${input.type}`
    : `[dispatch] SUPPRESS notification=${input.notificationId} user=${input.userId} type=${input.type} reason=${input.reason}`;
  console.log(line);

  const { error } = await supabase.from("notification_dispatch_log").insert({
    notification_id: input.notificationId,
    user_id: input.userId,
    type: input.type,
    decision: input.decision,
    reason: input.reason ?? null,
  });
  if (error) console.error("Failed to write dispatch log:", error);

  // Amortized cleanup — no cron needed. Keeps ~7 days of trace history,
  // plenty for debugging without the table growing unbounded.
  if (Math.random() < 0.005) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000).toISOString();
    await supabase.from("notification_dispatch_log").delete().lt("checked_at", sevenDaysAgo);
  }
}