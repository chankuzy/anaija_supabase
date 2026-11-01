/// <reference path="../_shared/deno-shim.d.ts" />
import type { Hono } from "hono";
import { serviceClient, requireAuth } from "../_shared/auth.ts";
import { json } from "../_shared/response.ts";
import {
  clearConversation,
  getConversationInfo,
  getInbox,
  listMessages,
  openDirect,
  respondToRequest,
  sendMessage,
  setConversationMuted,
} from "../_shared/services/messagingService.ts";

const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";

export function registerConversations(app: Hono<any, any, any>) {
  app.all("/inbox", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    return json(await getInbox(supabase, userId, CDN_BASE));
  });

  app.all("/open", async (c) => {
    const supabase = serviceClient();
    const myId = await requireAuth(c.req.raw, supabase);
    const body = await c.req.json();
    const otherId = parseInt(body.user_id, 10);
    if (!otherId) return json({ message: "user_id is required." }, 422);

    const result = await openDirect(supabase, myId, otherId);
    if ("blocked" in result) return json({ message: "You can't message this user." }, 403);
    if ("selfConversation" in result) return json({ message: "Cannot start a conversation with yourself." }, 422);
    if ("notFound" in result) return json({ message: "User not found." }, 422);

    return json({ conversation_id: result.conversation_id, existing: result.existing }, result.existing ? 200 : 201);
  });

  app.all("/messages/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const conversationId = parseInt(c.req.param("id"), 10);
    const cursor = c.req.query("cursor") ?? null;
    if (!conversationId) return json({ message: "Invalid conversation id." }, 422);

    const result = await listMessages(supabase, conversationId, userId, cursor, CDN_BASE);
    if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);
    return json(result);
  });

  app.all("/send/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const conversationId = parseInt(c.req.param("id"), 10);
    if (!conversationId) return json({ message: "Invalid conversation id." }, 422);

    const body = await c.req.json();
    const result = await sendMessage(supabase, conversationId, userId, body, CDN_BASE);
    if ("forbidden" in result) return json({ message: result.forbidden }, 403);
    if ("invalidMedia" in result) return json({ message: "Invalid media." }, 422);
    if ("blocked" in result) return json({ message: "You can't message this user." }, 403);
    if ("requestLimitReached" in result) {
      return json({ message: "Message request limit reached — wait for a response before sending more." }, 429);
    }
    if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);

    return json(result.message, 201);
  });

  app.all("/info/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const conversationId = parseInt(c.req.param("id"), 10);
    if (!conversationId) return json({ message: "Invalid conversation id." }, 422);

    const result = await getConversationInfo(supabase, conversationId, userId, c.req.query("media") === "1");
    if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);
    return json(result);
  });

  // The id can come from the path (/mute/12), the body or the query string.
  app.all("/mute/:id?", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);

    let body: any = {};
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      try {
        body = await c.req.json();
      } catch {
        // body could be empty
      }
    }

    const pathId = parseInt(c.req.param("id") ?? "", 10);
    const conversationId = !isNaN(pathId)
      ? pathId
      : (body.conversation_id
        ? parseInt(body.conversation_id, 10)
        : parseInt(c.req.query("conversation_id") ?? "", 10));

    if (!conversationId || isNaN(conversationId)) {
      return json({ message: "Invalid conversation id." }, 422);
    }

    const isMuted = typeof body.is_muted === "boolean"
      ? body.is_muted
      : (c.req.query("is_muted") === "false" ? false : true);

    const result = await setConversationMuted(supabase, conversationId, userId, isMuted);
    if ("unauthorized" in result) {
      return json({ message: "Conversation not found or access denied." }, 403);
    }
    return json(result);
  });

  app.all("/respond/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const conversationId = parseInt(c.req.param("id"), 10);
    if (!conversationId) return json({ message: "Invalid conversation id." }, 422);

    const body = await c.req.json();
    const action = body.action;
    if (!["accept", "decline", "block"].includes(action)) {
      return json({ message: "action must be accept, decline, or block." }, 422);
    }

    const result = await respondToRequest(supabase, conversationId, userId, action);
    if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);
    return json(result);
  });

  app.all("/clear/:id", async (c) => {
    const supabase = serviceClient();
    const userId = await requireAuth(c.req.raw, supabase);
    const conversationId = parseInt(c.req.param("id"), 10);
    if (!conversationId) return json({ message: "Invalid conversation id." }, 422);

    const result = await clearConversation(supabase, conversationId, userId);
    if ("unauthorized" in result) return json({ message: "Unauthorized." }, 403);
    return json({ message: "Chat cleared." });
  });
}
