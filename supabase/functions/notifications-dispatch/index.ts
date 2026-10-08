/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { resolvePushPayload, sendPushToUser } from "../_shared/services/pushService.ts";
import { isViewingEntity } from "../_shared/services/presenceService.ts";
import { shouldPush } from "../_shared/services/preferencesService.ts";
import { isRateLimited, recordPushSent } from "../_shared/services/rateLimitService.ts";
import { logDispatchDecision } from "../_shared/services/dispatchLogService.ts";

// Triggered by a Supabase Database Webhook on INSERT/UPDATE of `notifications`.
// Postgres is the caller here, not a logged-in user, so this checks a shared
// secret header instead of requireAuth — deploy with --no-verify-jwt.
Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const secret = Deno.env.get("DISPATCH_WEBHOOK_SECRET");
    if (secret && req.headers.get("x-webhook-secret") !== secret) {
      return json({ message: "Unauthorized." }, 401);
    }

    const payload = await req.json();
    const notification = payload.record;
    if (!notification) return json({ message: "No record in payload." }, 400);

    const supabase = serviceClient();
    const trace = (decision: "sent" | "suppressed", reason?: string) =>
      logDispatchDecision(supabase, {
        notificationId: notification.id,
        userId: notification.user_id,
        type: notification.type,
        decision,
        reason,
      });

    // Gate order: cheapest / most likely to short-circuit first.

    // 1. Preferences — muted category, push disabled globally, or quiet hours.
    const allowed = await shouldPush(supabase, notification.user_id, notification.type);
    if (!allowed) {
      await trace("suppressed", "preferences");
      return json({ ok: true, suppressed: "preferences" });
    }

    // 2. Presence — "don't notify what they're already seeing".
    const viewing = await isViewingEntity(
      supabase,
      notification.user_id,
      notification.notifiable_type,
      notification.notifiable_id,
    );
    if (viewing) {
      await trace("suppressed", "recipient_viewing_entity");
      return json({ ok: true, suppressed: "recipient_viewing_entity" });
    }

    // 3. Rate limit — protects against a storm of genuinely-different
    // targets that aggregation alone doesn't catch.
    const limited = await isRateLimited(supabase, notification.user_id, notification.type);
    if (limited) {
      await trace("suppressed", "rate_limited");
      return json({ ok: true, suppressed: "rate_limited" });
    }

    const pushPayload = await resolvePushPayload(supabase, notification);
    await sendPushToUser(supabase, notification.user_id, pushPayload);
    await recordPushSent(supabase, notification.user_id, notification.type);
    await trace("sent");

    return json({ ok: true });
  } catch (err) {
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});