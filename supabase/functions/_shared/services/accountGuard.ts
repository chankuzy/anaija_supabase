import type { SupabaseClient } from "../auth.ts";

/** Only ordinary people can sign in. Official (platform-owned) accounts have no credentials and no token path. */
export const isPerson = (u: { account_type?: string | null } | null | undefined) =>
  (u?.account_type ?? "person") === "person";

/** Brand and authority handles people may never claim. The DB trigger enforces the same rule as a backstop. */
export async function isReservedUsername(supabase: SupabaseClient, username: string): Promise<boolean> {
  const u = username.toLowerCase();
  if (u.startsWith("anaija")) return true;
  const { data } = await supabase.from("reserved_usernames").select("name").eq("name", u).maybeSingle();
  return !!data;
}
