/// <reference path="../_shared/deno-shim.d.ts" />
import { AwsClient } from "npm:aws4fetch@1";
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";

const R2_ACCESS_KEY_ID = Deno.env.get("R2_ACCESS_KEY_ID") ?? "";
const R2_SECRET_ACCESS_KEY = Deno.env.get("R2_SECRET_ACCESS_KEY") ?? "";
const R2_BUCKET = Deno.env.get("R2_BUCKET") ?? "";
const R2_ENDPOINT = Deno.env.get("R2_ENDPOINT") ?? "";

// 15 minutes — long enough for a slow mobile upload of a trimmed video,
// short enough that a leaked/logged URL isn't useful for long.
const PRESIGN_EXPIRY_SECONDS = 900;

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const { filename } = await req.json();

    if (!filename || typeof filename !== "string") {
      return json({ message: "filename is required." }, 422);
    }

    if (!R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_ENDPOINT) {
      console.error("R2 secrets are not fully configured.");
      return json({ message: "Upload storage is not configured." }, 500);
    }

    const ext = filename.includes(".") ? filename.split(".").pop() : "bin";
    // Same "{userId}/{uuid}.ext" convention as before — this is what
    // verifyMediaOwnership() in postService.ts checks against, and what
    // publicUrl() in feedService.ts builds read URLs from. Keeping the
    // shape identical means neither of those needed to change.
    const path = `${userId}/${crypto.randomUUID()}.${ext}`;

    const client = new AwsClient({
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
      service: "s3",
      region: "auto",
    });

    const objectUrl = `${R2_ENDPOINT.replace(/\/+$/, "")}/${R2_BUCKET}/${path}`;

    // Query-string (presigned URL) signing — deliberately NOT signing the
    // Content-Type header here, so the client is free to set whatever
    // Content-Type it wants on the actual PUT without needing it to match
    // a value baked into the signature. Simpler contract for the Flutter
    // client: just PUT bytes to this URL with any headers it likes.
    const signedRequest = await client.sign(objectUrl, {
      method: "PUT",
      aws: { signQuery: true, expires: PRESIGN_EXPIRY_SECONDS },
    });

    return json({
      path,
      signed_url: signedRequest.url,
      expires_in: PRESIGN_EXPIRY_SECONDS,
    });
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});