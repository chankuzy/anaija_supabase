/// <reference path="../_shared/deno-shim.d.ts" />
import { Hono } from "hono";
import { AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { registerConversations } from "./conversations.ts";
import { registerMessages } from "./messages.ts";

// Routes (full path as the function sees it):
//   /conversations/inbox   /conversations/open
//   /conversations/messages|send|info|respond|clear/:id   /conversations/mute/:id?
//   /conversations/message-update|message-destroy|message-react/:id/x/:messageId
//   /conversations/message-read/:id
// Legacy names (conversations-inbox, messages-update/...) are rewritten to these by the web proxy.
// app.all() keeps parity with the old functions, which never checked the HTTP method.
const app = new Hono().basePath("/conversations");

app.use("*", async (c, next) => {
  const cors = handleCors(c.req.raw);
  if (cors) return cors;
  await next();
});

app.onError((err) => {
  if (err instanceof AuthError) return json({ message: err.message }, err.status);
  console.error(err);
  return json({ message: "Something went wrong." }, 500);
});

app.notFound(() => json({ message: "Not found." }, 404));

registerConversations(app);
registerMessages(app);

Deno.serve(app.fetch);
