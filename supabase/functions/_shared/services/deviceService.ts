import type { SupabaseClient } from "../auth.ts";

const PLATFORMS = ["fcm", "apns"];

export async function registerDevice(
  supabase: SupabaseClient,
  userId: number,
  pushToken: string,
  pushPlatform: string,
  deviceName?: string,
) {
  if (!pushToken || pushToken.length > 512) return { invalid: true as const, message: "push_token is required (max 512 chars)." };
  if (!PLATFORMS.includes(pushPlatform)) return { invalid: true as const, message: "push_platform must be fcm or apns." };

  // Upsert on push_token: if this token already exists for any user, claim it
  // — handles logging out and back in on the same device.
  const { error } = await supabase
    .from("user_devices")
    .upsert(
      {
        push_token: pushToken,
        user_id: userId,
        push_platform: pushPlatform,
        push_enabled: true,
        token_verified_at: new Date().toISOString(),
        device_name: deviceName ?? null,
      },
      { onConflict: "push_token" },
    );

  if (error) throw error;
  return { ok: true as const };
}

export async function unregisterDevice(supabase: SupabaseClient, userId: number, pushToken: string) {
  if (!pushToken) return { invalid: true as const, message: "push_token is required." };

  const { error } = await supabase
    .from("user_devices")
    .update({ push_enabled: false })
    .eq("push_token", pushToken)
    .eq("user_id", userId);

  if (error) throw error;
  return { ok: true as const };
}