/// <reference path="../_shared/deno-shim.d.ts" />
import type { Hono } from "hono";
import { AuthError, serviceClient, requireAuth } from "../_shared/auth.ts";
import { json } from "../_shared/response.ts";
import {
  deleteMessage,
  markMessagesRead,
  toggleReaction,
  updateMessage,
} from "../_shared/services/messagingService.ts";

// Message-level routes keep the legacy "/x/" path segment so the web client's URLs don't change:
//   /conversations/message-update/{conversationId}/x/{messageId}
export function registerMessages(app: Hono<any, any, any>) {
  app.all("/message-update/:id/x/:messageId", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const conversationId = parseInt(c.req.param("id"), 10);
    const messageId = parseInt(c.req.param("messageId"), 10);
    if (!conversationId || !messageId) return json({ message: "Invalid id." }, 422);

    const body = await c.req.json().catch(() => ({}));
    if (!body || typeof body.body !== "string" || !body.body.trim()) {
      return json({ message: "Message body cannot be empty." }, 422);
    }

    const result = await updateMessage(supabase, conversationId, messageId, userId, { body: body.body });
    if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);
    if ("notFound" in result) return json({ message: "Not found." }, 404);
    if ("notOwner" in result) return json({ message: "You can only edit your own messages." }, 403);
    if ("deleted" in result) return json({ message: "Deleted messages cannot be edited." }, 422);
    if ("notEditable" in result) return json({ message: "Only text messages can be edited." }, 422);
    if ("tooLate" in result) return json({ message: "Messages can only be edited within 15 minutes of sending." }, 422);
    if ("invalidBody" in result) return json({ message: "Message body cannot be empty." }, 422);

    return json(result.message);
  });

  app.all("/message-destroy/:id/x/:messageId", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const conversationId = parseInt(c.req.param("id"), 10);
    const messageId = parseInt(c.req.param("messageId"), 10);
    if (!conversationId || !messageId) return json({ message: "Invalid id." }, 422);

    const body = await c.req.json().catch(() => ({}));
    const scope = body.scope === "everyone" ? "everyone" : "me";

    const result = await deleteMessage(supabase, conversationId, messageId, userId, scope);
    if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);
    if ("notFound" in result) return json({ message: "Not found." }, 404);
    if ("notOwner" in result) return json({ message: "You can only delete your own messages." }, 403);
    if ("tooLate" in result) return json({ message: "Messages can only be deleted within 5 minutes of sending." }, 422);
    if ("cannotHide" in result) return json({ message: "You can only hide your own messages from your view." }, 422);
    if ("everyone" in result) return json({ message: "Message deleted for everyone." });

    return json({ message: "Message hidden from your view." });
  });

  app.all("/message-react/:id/x/:messageId", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const conversationId = parseInt(c.req.param("id"), 10);
    const messageId = parseInt(c.req.param("messageId"), 10);
    if (!conversationId || !messageId) return json({ message: "Invalid id." }, 422);

    const body = await c.req.json();
    if (!body.emoji) return json({ message: "emoji is required." }, 422);

    const result = await toggleReaction(supabase, conversationId, messageId, userId, body.emoji);
    if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);
    if ("notFound" in result) return json({ message: "Not found." }, 404);

    return json({ reactions: result.reactions });
  });

  // Fire-and-forget: after auth this always answers 200, matching the Laravel contract.
  app.all("/message-read/:id", async (c) => {
    try {
      const supabase = serviceClient();
      const userId = await requireAuth(c.req.raw, supabase);
      const conversationId = parseInt(c.req.param("id"), 10);
      if (!conversationId) return json({ ok: false });

      const body = await c.req.json().catch(() => ({}));
      await markMessagesRead(supabase, conversationId, userId, body.message_ids ?? null, body.up_to_message_id ?? null);

      return json({ ok: true });
    } catch (err) {
      if (err instanceof AuthError) return json({ message: err.message }, err.status);
      console.error(err);
      return json({ ok: true });
    }
  });
}
