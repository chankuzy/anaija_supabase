/// <reference path="../_shared/deno-shim.d.ts" />
import { Hono } from "hono";
import { AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { registerProfile } from "./profile.ts";
import { registerPeople } from "./people.ts";
import { registerHighlights } from "./highlights.ts";

// Routes (full path as the function sees it):
//   /users/me[/update|/complete|/avatar|/cover]      own profile
//   /users/show|posts|listings|reposts|stories|followers|following/:username
//   /users/follow/:id   /users/block/:id   /users/blocks   /users/username-check?username=
//   /users/highlights/:username   /users/highlights-store   /users/highlight-posts[/:hid[/:pid]]
// Legacy names (users-show/x, profile-get ...) are rewritten to these by the web proxy.
// app.all() keeps parity with the old functions, which never checked the HTTP method.
const app = new Hono().basePath("/users");

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

registerProfile(app);
registerPeople(app);
registerHighlights(app);

Deno.serve(app.fetch);
