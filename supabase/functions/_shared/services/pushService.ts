import type { SupabaseClient } from "../auth.ts";

const PROJECT_ID = Deno.env.get("FIREBASE_PROJECT_ID") ?? "anaija-3c934";
const FCM_SEND_URL = `https://fcm.googleapis.com/v1/projects/${PROJECT_ID}/messages:send`;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

let cachedToken: { value: string; expiresAt: number } | null = null;

function base64url(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signJwt(serviceAccount: { client_email: string; private_key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = { iss: serviceAccount.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const pemBody = serviceAccount.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const keyBytes = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "pkcs8", keyBytes, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(signature)}`;
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const raw = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT secret is not set.");
  const assertion = await signJwt(JSON.parse(raw));
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) throw new Error(`FCM token exchange failed: ${await res.text()}`);
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

export interface PushPayload { title: string; body: string; data: Record<string, string> }

// ── Send ────────────────────────────────────────────────────────────────────
export interface PushResult { devices: number; delivered: number; retryable: number; dead: number }

const TEMP_STATUS = new Set(["UNAVAILABLE", "INTERNAL", "QUOTA_EXCEEDED", "DEADLINE_EXCEEDED"]);
const DEAD_STATUS = new Set(["UNREGISTERED", "NOT_FOUND", "INVALID_ARGUMENT"]);

export async function sendPushToUser(
  supabase: SupabaseClient, userId: number, payload: PushPayload, opts: { tag?: string } = {},
): Promise<PushResult> {
  const result: PushResult = { devices: 0, delivered: 0, retryable: 0, dead: 0 };
  const { data: devices, error } = await supabase
    .from("user_devices").select("id, push_token").eq("user_id", userId).eq("push_enabled", true);
  if (error) throw error;
  if (!devices?.length) return result;
  result.devices = devices.length;

  const accessToken = await getAccessToken();
  const tag = opts.tag;
  const data: Record<string, string> = { ...payload.data };
  if (tag) data.tag = tag;

  await Promise.all(devices.map(async (device: any) => {
    const message = {
      message: {
        token: device.push_token,
        notification: { title: payload.title, body: payload.body },
        data,
        android: { notification: { channel_id: "anaija_default_channel", image: data.image, tag } },
        apns: {
          headers: tag ? { "apns-collapse-id": tag.slice(0, 60) } : undefined,
          payload: { aps: { "mutable-content": 1 } },
          fcm_options: data.image ? { image: data.image } : undefined,
        },
      },
    };
    try {
      const res = await fetch(FCM_SEND_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(message),
      });
      if (res.ok) { result.delivered++; return; }
      const errBody = await res.json().catch(() => null);
      const status = errBody?.error?.status as string | undefined;
      if (status && DEAD_STATUS.has(status)) {
        await supabase.from("user_devices").update({ push_enabled: false }).eq("id", device.id);
        result.dead++;
      } else if (res.status === 429 || res.status >= 500 || (status && TEMP_STATUS.has(status))) {
        result.retryable++;
      } else {
        console.error(`FCM send failed for device ${device.id}:`, errBody);
        result.dead++;
      }
    } catch (e) {
      console.error("FCM network error:", e);
      result.retryable++;
    }
  }));
  return result;
}
