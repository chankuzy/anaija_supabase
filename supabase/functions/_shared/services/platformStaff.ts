// Platform staff roles and capabilities. Single source of truth: every privileged platform route and the
// community access override read it from here. Roles live in platform_staff, never on users or community_members.
import type { SupabaseClient } from "../auth.ts";

export const STAFF_ROLES = ["super_admin", "comms_admin", "editor", "moderator", "analyst"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const CAPS = [
  "staff.manage",
  "accounts.view", "accounts.manage",
  "content.write", "content.publish",
  "communities.manage", "communities.moderate",
  "campaigns.create", "campaigns.approve", "campaigns.broadcast_all",
  "analytics.view", "audit.view",
] as const;
export type Cap = (typeof CAPS)[number];

export const ROLE_CAPS: Record<StaffRole, readonly Cap[]> = {
  super_admin: CAPS,
  comms_admin: [
    "accounts.view", "accounts.manage", "content.write", "content.publish",
    "communities.manage", "communities.moderate", "campaigns.create", "campaigns.approve",
    "analytics.view", "audit.view",
  ],
  editor: ["accounts.view", "content.write", "campaigns.create", "analytics.view"],
  moderator: ["communities.moderate"],
  analyst: ["accounts.view", "analytics.view"],
};

export const hasCap = (role: StaffRole | null | undefined, cap: Cap): boolean =>
  !!role && ROLE_CAPS[role].includes(cap);

/** The staff member's active role, or null. Throws on a database error (callers decide whether to fail closed). */
export async function loadStaffRole(supabase: SupabaseClient, userId: number): Promise<StaffRole | null> {
  const { data, error } = await supabase.from("platform_staff").select("role")
    .eq("user_id", userId).is("revoked_at", null).maybeSingle();
  if (error) throw error;
  return (data?.role as StaffRole | undefined) ?? null;
}

/** The community role staff exercise inside platform-owned communities. Derived, never stored as a membership. */
export function communityRoleFor(role: StaffRole | null): "admin" | "moderator" | null {
  if (role === "super_admin" || role === "comms_admin") return "admin";
  if (role === "editor" || role === "moderator") return "moderator";
  return null;
}
