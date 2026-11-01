/// <reference path="../_shared/deno-shim.d.ts" />
import type { Context } from "hono";
import type { SupabaseClient } from "../_shared/auth.ts";
import { resolveAvatarUrl } from "../_shared/avatar.ts";

export const readBody = async (c: Context): Promise<Record<string, any>> => {
  const b = await c.req.json().catch(() => ({}));
  return b && typeof b === "object" && !Array.isArray(b) ? b : {};
};

export const posInt = (v: unknown) => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export async function userMap(supabase: SupabaseClient, ids: number[]): Promise<Map<number, any>> {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return new Map();
  const { data, error } = await supabase.from("users").select("id, name, username, avatar_key, avatar").in("id", uniq);
  if (error) throw error;
  return new Map((data ?? []).map((u: any) => [u.id as number, u]));
}

export const liteUser = (u: any) => ({
  name: u?.name ?? null,
  username: u?.username ?? null,
  avatar: resolveAvatarUrl(u?.avatar_key ?? u?.avatar),
});
