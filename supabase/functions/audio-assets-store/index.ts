/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { createAudioAsset, AudioValidationError } from "../_shared/services/audioAssetService.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);
    const body = await req.json();

    const result = await createAudioAsset(supabase, userId, body);
    return json(result, 201);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    if (err instanceof AudioValidationError) return json({ message: "Validation failed.", errors: err.errors }, 422);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});