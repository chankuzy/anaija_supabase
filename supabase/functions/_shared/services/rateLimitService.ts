import type { SupabaseClient } from "../auth.ts";

// Baseline limits — generous enough not to interfere with normal use, but
// enough to stop a genuine storm. Aggregation (notifyAggregated /
// notifyMessage) already collapses repeats on the *same* target into one
// row, so this only ever kicks in for genuinely different targets in a
// short window — a comment war with different reply content each time, or
// someone messaging across many different conversations at once.
const HOURLY_LIMITS: Record<string, number> = {
  likes: 20,
  comments: 20,
  follows: 20,
  messages: 60, // legitimately higher-frequency than social actions
};
const DEFAULT_HOURLY_LIMIT = 20;

const CATEGORY_BY_TYPE: Record<string, string> = {
  like: "likes",
  repost: "likes",
  comment: "comments",
  follow: "follows",
  message: "messages",
};

function categoryFor(notificationType: string): string {
  return CATEGORY_BY_TYPE[notificationType] ?? notificationType;
}

// Checked right before sendPushToUser. Fails open (returns false = "not
// limited, go ahead and send") on any lookup error — same asymmetry as
// presence: a missed rate-limit costs one extra push, a wrongly-blocked
// one costs the user missing something real.
export async function isRateLimited(
  supabase: SupabaseClient,
  userId: number,
  notificationType: string,
): Promise<boolean> {
  const category = categoryFor(notificationType);
  const limit = HOURLY_LIMITS[category] ?? DEFAULT_HOURLY_LIMIT;

  const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  const { count, error } = await supabase
    .from("push_log")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("category", category)
    .gte("sent_at", hourAgo);

  if (error) {
    console.error("Rate limit lookup failed — failing open (allow send):", error);
    return false;
  }

  return (count ?? 0) >= limit;
}

// Called once per successful sendPushToUser — records that a push actually
// went out, so the next isRateLimited check for this user/category counts
// it.
export async function recordPushSent(
  supabase: SupabaseClient,
  userId: number,
  notificationType: string,
) {
  const category = categoryFor(notificationType);
  const { error } = await supabase.from("push_log").insert({ user_id: userId, category });
  if (error) console.error("Failed to record push_log entry:", error);

  // Cheap amortized cleanup instead of a cron job — ~1% of sends prune
  // anything older than the lookback window could ever need. At this
  // volume that's frequent enough to keep the table from growing unbounded
  // without needing pg_cron wired up for something this small.
  if (Math.random() < 0.01) {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    await supabase.from("push_log").delete().lt("sent_at", twoHoursAgo);
  }
}