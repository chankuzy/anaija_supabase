import type { SupabaseClient } from "../auth.ts";
import { resolveAvatarUrl } from "../avatar.ts";

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

// Signs a service-account JWT and exchanges it for an FCM v1 access token.
// Cached in-memory per warm isolate — Deno edge functions reuse isolates
// across invocations, so this avoids re-signing/re-exchanging on every push.
async function signJwt(serviceAccount: { client_email: string; private_key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: serviceAccount.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;

  const pemBody = serviceAccount.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const keyBytes = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64url(signature)}`;
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const raw = Deno.env.get("FIREBASE_SERVICE_ACCOUNT");
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT secret is not set.");
  const serviceAccount = JSON.parse(raw);

  const assertion = await signJwt(serviceAccount);
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`FCM token exchange failed: ${await res.text()}`);
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.value;
}

// ─── Payload resolution ─────────────────────────────────────────────────────
// Same image-resolution logic as notificationDisplayService.formatNotification,
// but re-fetched here since the Database Webhook only hands us the raw
// notifications row, not the joined actor/post data the list endpoint has.

interface PushPayload {
  title: string;
  body: string;
  data: Record<string, string>;
}

export async function resolvePushPayload(supabase: SupabaseClient, notification: any): Promise<PushPayload> {
  let actor: any = null;
  if (notification.actor_id) {
    const { data } = await supabase
      .from("users").select("id, name, username, avatar_key, avatar")
      .eq("id", notification.actor_id).maybeSingle();
    actor = data;
  }

  let image: string | null = null;
  let postId: number | null = null;
  let postType: string | null = null;
  if (notification.notifiable_type === "posts" && notification.notifiable_id) {
    const { data: post } = await supabase
      .from("posts")
      .select("id, type, media:post_media(media_type, thumbnail_key, storage_key)")
      .eq("id", notification.notifiable_id)
      .maybeSingle();
    if (post) {
      postId = post.id;
      postType = post.type ?? null;
      const firstImage = (post.media ?? []).find((m: any) => m.media_type === "image");
      if (firstImage) image = resolveAvatarUrl(firstImage.thumbnail_key || firstImage.storage_key);
    }
  }

  const avatar = actor ? resolveAvatarUrl(actor.avatar_key ?? actor.avatar) : null;

  const data: Record<string, string> = {
    notification_id: String(notification.id),
    type: notification.type,
  };
  if (postId) data.post_id = String(postId);
  if (postType) data.post_type = postType;
  if (actor?.username) data.actor_username = String(actor.username);
  if (notification.comment_id) data.comment_id = String(notification.comment_id);
  // Message notifications carry notifiable_type: "conversations" — this
  // is what NotificationRouter (Flutter side) needs to deep-link straight
  // into the right thread instead of just opening the inbox.
  if (notification.notifiable_type === "conversations" && notification.notifiable_id) {
    data.conversation_id = String(notification.notifiable_id);
  }
  if (image) data.image = image;
  if (avatar) data.avatar = avatar;

  return {
    title: actor?.name ?? "Anaija",
    body: notification.body ?? "You have new activity.",
    data,
  };
}

// ─── Send ───────────────────────────────────────────────────────────────────

export async function sendPushToUser(supabase: SupabaseClient, userId: number, payload: PushPayload) {
  const { data: devices, error } = await supabase
    .from("user_devices")
    .select("id, push_token")
    .eq("user_id", userId)
    .eq("push_enabled", true);
  if (error) throw error;
  if (!devices?.length) return;

  const accessToken = await getAccessToken();

  await Promise.all(devices.map(async (device: any) => {
    const message = {
      message: {
        token: device.push_token,
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
        android: {
          notification: { channel_id: "anaija_default_channel", image: payload.data.image },
        },
        apns: {
          payload: { aps: { "mutable-content": 1 } },
          fcm_options: payload.data.image ? { image: payload.data.image } : undefined,
        },
      },
    };

    const res = await fetch(FCM_SEND_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });

    if (!res.ok) {
      const errBody = await res.json().catch(() => null);
      const status = errBody?.error?.status;
      // Dead/unregistered token — stop sending to it instead of retrying
      // forever on every future notification.
      if (status === "UNREGISTERED" || status === "NOT_FOUND" || status === "INVALID_ARGUMENT") {
        await supabase.from("user_devices").update({ push_enabled: false }).eq("id", device.id);
      } else {
        console.error(`FCM send failed for device ${device.id}:`, errBody ?? await res.text());
      }
    }
  }));
}