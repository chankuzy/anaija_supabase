/// <reference path="../_shared/deno-shim.d.ts" />
import { serviceClient, requireAuth, AuthError } from "../_shared/auth.ts";
import { json, handleCors } from "../_shared/response.ts";
import { pollStates } from "../_shared/services/pollService.ts";

// GET  /polls?ids=1,2,3  -> poll states
// POST /polls            -> cast a vote
Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  try {
    const supabase = serviceClient();
    const userId = await requireAuth(req, supabase);

    if (req.method === "GET") {
      const ids = [...new Set((new URL(req.url).searchParams.get("ids") ?? "").split(",").map(Number)
        .filter((n) => Number.isInteger(n) && n > 0))].slice(0, 30);
      return json({ polls: await pollStates(supabase, userId, ids) });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const postId = Number(body?.post_id);
      const optionIds = [...new Set((Array.isArray(body?.option_ids) ? body.option_ids : []).map(Number))] as number[];
      if (!Number.isInteger(postId) || postId <= 0 || !optionIds.length || optionIds.some((n) => !Number.isInteger(n) || n < 0)) {
        return json({ message: "Choose an option." }, 422);
      }

      const s = (await pollStates(supabase, userId, [postId]))[postId];
      if (!s) return json({ message: "Poll not found." }, 404);
      if (s.closed) return json({ message: "Voting has closed." }, 409);
      if (s.mine.length) return json({ message: "You already voted." }, 409);
      if (!s.can_vote) return json({ message: "Join this community to vote." }, 403);
      if (optionIds.some((n) => n >= s.options)) return json({ message: "Invalid option." }, 422);
      if (!s.multiple && optionIds.length !== 1) return json({ message: "Choose one option." }, 422);

      const { error } = await supabase.from("poll_votes").insert(
        optionIds.map((option_id) => ({ post_id: postId, user_id: userId, option_id })),
      );
      if (error) {
        if ((error as { code?: string }).code === "23505") return json({ message: "You already voted." }, 409);
        throw error;
      }
      return json({ poll: (await pollStates(supabase, userId, [postId]))[postId] });
    }

    return json({ message: "Method not allowed." }, 405);
  } catch (err) {
    if (err instanceof AuthError) return json({ message: err.message }, err.status);
    console.error(err);
    return json({ message: "Something went wrong." }, 500);
  }
});
