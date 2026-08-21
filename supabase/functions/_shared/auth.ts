/// <reference path="./deno-shim.d.ts" />
import { createClient } from "npm:@supabase/supabase-js@2";

// SupabaseClient type isn't exported from the npm: specifier in this environment,
// derive it from the createClient return type for typing.
export type SupabaseClient = ReturnType<typeof createClient>;

const TOKENABLE_TYPE = "App\\Models\\User";
const TOKEN_TTL_DAYS = 30;

function randomTokenString(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}

// Issues a Sanctum-compatible token: "{id}|{plaintext}", storing only the hash.
export async function issueToken(
  supabase: SupabaseClient,
  userId: number,
  deviceName = "mobile",
): Promise<string> {
  const plaintext = randomTokenString();
  const hashed = await sha256Hex(plaintext);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86_400_000).toISOString();

  const { data, error } = await supabase
    .from("personal_access_tokens")
    .insert({
      tokenable_type: TOKENABLE_TYPE,
      tokenable_id: userId,
      name: deviceName,
      token: hashed,
      expires_at: expiresAt,
    })
    .select("id")
    .single();

  if (error) throw error;
  return `${data.id}|${plaintext}`;
}

export async function verifyToken(supabase: SupabaseClient, token: string): Promise<number | null> {
  const sep = token.indexOf("|");
  if (sep === -1) return null;

  const id = token.slice(0, sep);
  const plaintext = token.slice(sep + 1);
  const hashed = await sha256Hex(plaintext);

  const { data, error } = await supabase
    .from("personal_access_tokens")
    .select("id, tokenable_id, expires_at")
    .eq("id", id)
    .eq("token", hashed)
    .eq("tokenable_type", TOKENABLE_TYPE)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  if (data.expires_at && new Date(data.expires_at) < new Date()) return null;

  supabase
    .from("personal_access_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", id)
    .then(
      () => {},
      (err: unknown) => console.error("last_used_at update failed:", err),
    );

  return data.tokenable_id;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

// Every protected Edge Function calls this first. Throws AuthError on failure.
export async function requireAuth(req: Request, supabase: SupabaseClient): Promise<number> {
  const header = req.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) {
    throw new AuthError("Unauthenticated.");
  }
  const token = header.slice(7).trim();
  const userId = await verifyToken(supabase, token);
  if (userId === null) {
    throw new AuthError("Unauthenticated.");
  }
  return userId;
}

// Like requireAuth, but returns null instead of throwing when there's no/invalid token.
// Used by endpoints that behave differently for guests vs logged-in users (e.g. username-check).
export async function verifyTokenOptional(req: Request, supabase: SupabaseClient): Promise<number | null> {
  const header = req.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return await verifyToken(supabase, token);
}
