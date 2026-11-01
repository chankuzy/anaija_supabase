/// <reference path="../_shared/deno-shim.d.ts" />
import { Hono } from "hono";
import { AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { HttpError } from "../_shared/services/communityAccess.ts";
import { registerManage } from "./create.ts";
import { registerEntries } from "./entries.ts";
import { registerWars } from "./wars.ts";

// One function for every Moment (the project is at its edge-function limit).
//   manage:  settings create community show end cancel remind
//   entries: entries replies entry react vote answer queue moderate reveal report reports report-handle
//   wars:    war/respond war/join war/answer war/submit war/entries war/vote war/remove
const app = new Hono().basePath("/moments");

app.use("*", async (c, next) => {
  const cors = handleCors(c.req.raw);
  if (cors) return cors;
  await next();
});

app.onError((err) => {
  if (err instanceof AuthError) return json({ message: err.message }, err.status);
  if (err instanceof HttpError) return json({ message: err.message, ...(err.errors ? { errors: err.errors } : {}) }, err.status);
  console.error(err);
  return json({ message: "Something went wrong." }, 500);
});

app.notFound(() => json({ message: "Not found." }, 404));

registerManage(app);
registerEntries(app);
registerWars(app);

Deno.serve(app.fetch);
