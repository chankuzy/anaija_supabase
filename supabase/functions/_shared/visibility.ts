// Single source of truth for post visibility values.
// 'institution' is a legacy alias (older Flutter builds / saved drafts) for 'campus'.
export const VISIBILITIES = ["public", "followers", "campus", "private"] as const;
export type Visibility = typeof VISIBILITIES[number];

const ALIASES: Record<string, Visibility> = { institution: "campus" };

export function normalizeVisibility(v: unknown): Visibility | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if ((VISIBILITIES as readonly string[]).includes(s)) return s as Visibility;
  return ALIASES[s] ?? null;
}
