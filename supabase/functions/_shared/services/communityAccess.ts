// Single source of truth for "what may this viewer do in this community". Used by every community endpoint.
import type { SupabaseClient } from "../auth.ts";

export class HttpError extends Error {
  status: number;
  errors?: Record<string, string>;
  constructor(status: number, message: string, errors?: Record<string, string>) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

export const ROLES = ["member", "moderator", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];
/** member 1, moderator 2, admin 3, owner 4, anything else 0. */
export const rank = (r: string | null | undefined): number => (r ? ROLES.indexOf(r as Role) + 1 : 0);

export const ACTIONS = ["post", "chat", "invite", "session", "announce", "library"] as const;
export type Action = (typeof ACTIONS)[number];
const DEFAULT_MIN: Record<Action, Role> = {
  post: "member", chat: "member", invite: "moderator", session: "moderator", announce: "moderator", library: "moderator",
};

export interface Designation { id: number; kind: string; scope_label: string | null; can_announce: boolean }
export interface Access {
  community: any;
  role: Role | null; // null = not a member
  banned: boolean;
  designations: Designation[];
}

/** Community by id or slug (hidden when inactive or suspended) plus the viewer's standing in it. */
export async function loadAccess(
  supabase: SupabaseClient, ref: string | number, viewerId: number | null,
): Promise<Access | null> {
  const numeric = typeof ref === "number" || /^\d+$/.test(ref);
  const { data: c, error } = await supabase.from("communities").select("*")
    .eq(numeric ? "id" : "slug", numeric ? Number(ref) : String(ref).toLowerCase())
    .eq("is_active", true).neq("status", "suspended").maybeSingle();
  if (error) throw error;
  if (!c) return null;
  if (!viewerId) return { community: c, role: null, banned: false, designations: [] };

  const nowIso = new Date().toISOString();
  const [m, b, d] = await Promise.all([
    supabase.from("community_members").select("role").eq("community_id", c.id).eq("user_id", viewerId).maybeSingle(),
    supabase.from("community_bans").select("user_id").eq("community_id", c.id).eq("user_id", viewerId)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`).maybeSingle(),
    supabase.from("community_designations").select("id, kind, scope_label, can_announce")
      .eq("community_id", c.id).eq("user_id", viewerId).is("revoked_at", null),
  ]);
  return {
    community: c,
    role: (m.data?.role as Role | undefined) ?? null,
    banned: !!b.data,
    designations: (d.data ?? []) as Designation[],
  };
}

export function can(a: Access, action: Action): boolean {
  if (!a.role || a.banned || a.community.status !== "active") return false;
  if (action === "announce" && a.designations.some((d) => d.can_announce)) return true;
  const need = (a.community.permissions?.[action] ?? DEFAULT_MIN[action]) as string;
  return rank(a.role) >= rank(need);
}
export const isStaff = (a: Access) => !a.banned && rank(a.role) >= rank("moderator");
export const canManage = (a: Access) => !a.banned && rank(a.role) >= rank("admin");
/** Feed + About body. Chat and Library additionally require membership at their own endpoints. */
export const canRead = (a: Access) => !a.banned && (!!a.role || a.community.read_policy === "public_preview");

export function viewerCan(a: Access) {
  return {
    read: canRead(a),
    post: can(a, "post"), chat: can(a, "chat"), invite: can(a, "invite"),
    session: can(a, "session"), announce: can(a, "announce"), library: can(a, "library"),
    moderate: isStaff(a), manage: canManage(a),
  };
}
