// Signed cursor + bounded server-side feed session. The client never supplies ranking/eligibility data:
// the cursor only names a session and a position inside the server-stored, already-composed list.
import type { SupabaseClient } from "../auth.ts";

export const SESSION_TTL_MS = 30 * 60_000;
export const SESSION_MAX_AGE_MS = 6 * 3600_000;
export const SESSION_MAX_ITEMS = 200;

export type SessionItem =
  | { t: "post"; id: number; src: string[]; score: number; stage: string; why: string[]; k?: "post" | "listing" }
  | { t: "people"; id: string; users: { id: number; reason: string }[] };

export interface FeedSession {
  id: string;
  user_id: number | null;
  mode: "auth" | "guest";
  scope: string;
  items: SessionItem[];
  pos: number;
  delivered: number;
  consumed: number;
  suggestions_shown: number;
  consumed_at_last_suggestion: number;
  rebuilds: number;
  config_version: string | null;
  created_at: string;
  expires_at: string;
}

// ─── cursor ──────────────────────────────────────────────────────────────────────────────────────
export interface CursorPayload { v: 1; s: string; p: number; u: number; e: number }
export type CursorFailure = "malformed" | "bad_signature" | "expired" | "wrong_user" | "version";
export type CursorResult = { ok: true; payload: CursorPayload } | { ok: false; reason: CursorFailure };

const enc = new TextEncoder();
let keyCache: { secret: string; key: CryptoKey } | null = null;

async function hmacKey(): Promise<CryptoKey> {
  const secret = Deno.env.get("FEED_CURSOR_SECRET") ?? "";
  if (secret.length < 16) throw new Error("FEED_CURSOR_SECRET is not configured (min 16 chars)");
  if (keyCache && keyCache.secret === secret) return keyCache.key;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  keyCache = { secret, key };
  return key;
}

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64(s: string): Uint8Array<ArrayBuffer> {
  const p = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(p);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function signCursor(payload: CursorPayload): Promise<string> {
  const body = b64(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(body));
  return `${body}.${b64(sig)}`;
}

export function newCursorPayload(sessionId: string, pos: number, userId: number | null): CursorPayload {
  return { v: 1, s: sessionId, p: pos, u: userId ?? 0, e: Date.now() + SESSION_TTL_MS };
}

export async function verifyCursor(token: string, expectedUser: number | null): Promise<CursorResult> {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 2 || !parts[0] || !parts[1] || token.length > 600) return { ok: false, reason: "malformed" };
  let valid = false;
  try {
    // crypto.subtle.verify compares in constant time
    valid = await crypto.subtle.verify("HMAC", await hmacKey(), unb64(parts[1]), enc.encode(parts[0]));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!valid) return { ok: false, reason: "bad_signature" };
  let p: CursorPayload;
  try {
    p = JSON.parse(new TextDecoder().decode(unb64(parts[0])));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (p?.v !== 1) return { ok: false, reason: "version" };
  if (typeof p.s !== "string" || !Number.isInteger(p.p) || p.p < 0 || !Number.isInteger(p.u) || !Number.isFinite(p.e)) {
    return { ok: false, reason: "malformed" };
  }
  if (p.e < Date.now()) return { ok: false, reason: "expired" };
  if (p.u !== (expectedUser ?? 0)) return { ok: false, reason: "wrong_user" };
  return { ok: true, payload: p };
}

// ─── store ───────────────────────────────────────────────────────────────────────────────────────
export async function createSession(
  supabase: SupabaseClient,
  o: { userId: number | null; mode: "auth" | "guest"; scope: string; items: SessionItem[]; configVersion: string },
): Promise<string> {
  const { data, error } = await supabase.from("feed_sessions").insert({
    user_id: o.userId, mode: o.mode, scope: o.scope,
    items: o.items.slice(0, SESSION_MAX_ITEMS), config_version: o.configVersion,
  }).select("id").single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function getSession(supabase: SupabaseClient, id: string): Promise<FeedSession | null> {
  const { data, error } = await supabase.from("feed_sessions").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const s = data as unknown as FeedSession;
  if (new Date(s.expires_at).getTime() < Date.now()) return null;
  if (new Date(s.created_at).getTime() < Date.now() - SESSION_MAX_AGE_MS) return null;
  return s;
}

/** Moves the session forward only. Returns true when this call actually advanced it (a first delivery, not a retry). */
export async function advanceSession(
  supabase: SupabaseClient, id: string, newPos: number,
  patch: { items?: SessionItem[]; suggestions_shown?: number; consumed_at_last_suggestion?: number; consumed?: number; rebuilds?: number } = {},
): Promise<boolean> {
  const { data, error } = await supabase.from("feed_sessions").update({
    ...patch, pos: newPos, delivered: newPos,
    updated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  }).eq("id", id).lt("pos", newPos).select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** Stores a rebuilt item list. Optimistic on `rebuilds` so two concurrent requests cannot both rebuild. */
export async function replaceSessionItems(
  supabase: SupabaseClient, id: string, items: SessionItem[], expectedRebuilds: number,
): Promise<boolean> {
  const { data, error } = await supabase.from("feed_sessions").update({
    items: items.slice(0, SESSION_MAX_ITEMS), rebuilds: expectedRebuilds + 1, updated_at: new Date().toISOString(),
  }).eq("id", id).eq("rebuilds", expectedRebuilds).select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** Keeps everything delivered (needed for retry replay + dedupe) and appends only genuinely new posts. */
export function mergeRebuild(existing: SessionItem[], fresh: SessionItem[], max = SESSION_MAX_ITEMS): SessionItem[] {
  const seen = new Set<number>();
  for (const it of existing) if (it.t === "post") seen.add(it.id);
  const out = existing.slice();
  for (const it of fresh) {
    if (out.length >= max) break;
    if (it.t === "post") {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
    }
    out.push(it);
  }
  return out;
}

/**
 * True when a rebuild batch carries at least one NEW non-listing post.
 * A batch of only surplus listings must not be merged: composition paces listings
 * (one per page, min gap), so merging them yields one-item pages, one per rebuild.
 */
export function rebuildAddsContent(existing: SessionItem[], fresh: SessionItem[]): boolean {
  const seen = new Set<number>();
  for (const it of existing) if (it.t === "post") seen.add(it.id);
  return fresh.some((it) => it.t === "post" && !seen.has(it.id) && it.k !== "listing");
}
