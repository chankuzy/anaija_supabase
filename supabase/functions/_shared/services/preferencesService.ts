import type { SupabaseClient } from "../auth.ts";

export interface NotificationPreferences {
  push_enabled: boolean;
  likes: boolean;
  comments: boolean;
  follows: boolean;
  messages: boolean;
  quiet_hours_enabled: boolean;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  timezone_offset_minutes: number;
}

const DEFAULTS: NotificationPreferences = {
  push_enabled: true,
  likes: true,
  comments: true,
  follows: true,
  messages: true,
  quiet_hours_enabled: false,
  quiet_hours_start: null,
  quiet_hours_end: null,
  timezone_offset_minutes: 0,
};

// A user with no row yet gets full defaults (everything on) rather than
// being silently blocked — the table only needs a row once someone
// actually changes a setting.
export async function getPreferences(supabase: SupabaseClient, userId: number): Promise<NotificationPreferences> {
  const { data } = await supabase
    .from("notification_preferences")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (!data) return DEFAULTS;
  return { ...DEFAULTS, ...data };
}

export async function updatePreferences(
  supabase: SupabaseClient,
  userId: number,
  patch: Partial<NotificationPreferences>,
) {
  const { error } = await supabase.from("notification_preferences").upsert(
    { user_id: userId, ...patch, updated_at: new Date().toISOString() },
    { onConflict: "user_id" },
  );
  if (error) throw error;
}

// Maps a notifications.type value to the preference category that governs
// it. A type with no entry here (any future type you add) falls through
// as "always allowed" rather than being silently blocked by an unmapped
// key — a missing mapping should never be a silent notification blackhole.
const TYPE_TO_CATEGORY: Record<string, keyof NotificationPreferences> = {
  like: "likes",
  repost: "likes",
  comment: "comments",
  follow: "follows",
  message: "messages",
};

function isWithinQuietHours(prefs: NotificationPreferences): boolean {
  if (!prefs.quiet_hours_enabled || prefs.quiet_hours_start == null || prefs.quiet_hours_end == null) {
    return false;
  }
  if (prefs.quiet_hours_start === prefs.quiet_hours_end) return false;

  const localMs = Date.now() + prefs.timezone_offset_minutes * 60_000;
  const localHour = new Date(localMs).getUTCHours();
  const { quiet_hours_start: start, quiet_hours_end: end } = prefs;

  // Same-day range (e.g. 1 -> 6) vs. a range crossing midnight (e.g. 22 -> 7).
  return start < end
    ? localHour >= start && localHour < end
    : localHour >= start || localHour < end;
}

// The single gate notifications-dispatch calls before sending any push.
// false = "don't push" — category muted, push disabled globally, or it's
// currently quiet hours for this user. The notifications row itself is
// never touched by this check, so it still shows up in-app regardless.
export async function shouldPush(
  supabase: SupabaseClient,
  userId: number,
  notificationType: string,
): Promise<boolean> {
  const prefs = await getPreferences(supabase, userId);
  if (!prefs.push_enabled) return false;

  const category = TYPE_TO_CATEGORY[notificationType];
  if (category && prefs[category] === false) return false;

  if (isWithinQuietHours(prefs)) return false;

  return true;
}