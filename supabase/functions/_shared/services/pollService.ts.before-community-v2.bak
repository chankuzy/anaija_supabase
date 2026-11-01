import type { SupabaseClient } from "../auth.ts";
import { canViewPost } from "./contentAccess.ts";

export interface PollState {
  closed: boolean;
  options: number;
  multiple: boolean;
  /** Results are null until the viewer has voted, the poll closed, or the viewer is the author. */
  total: number | null;
  counts: number[] | null;
  mine: number[];
  can_vote: boolean;
}

export async function pollStates(supabase: SupabaseClient, viewerId: number, ids: number[]): Promise<Record<number, PollState>> {
  const out: Record<number, PollState> = {};
  if (!ids.length) return out;

  const { data: posts, error } = await supabase.from("posts")
    .select("id, user_id, type, subtype, visibility, institution_id, context, content, is_active, processing_status, deleted_at")
    .in("id", ids);
  if (error) throw error;

  const polls = (posts ?? []).filter((p: any) =>
    p.type === "post" && p.subtype === "poll" && p.is_active && !p.deleted_at &&
    p.processing_status === "ready" && Array.isArray(p.content?.options));
  const visible: any[] = [];
  await Promise.all(polls.map(async (p: any) => { if (await canViewPost(supabase, viewerId, p)) visible.push(p); }));
  if (!visible.length) return out;

  const vids = visible.map((p) => p.id);
  const [tally, mine] = await Promise.all([
    supabase.rpc("poll_tally", { p_posts: vids }),
    supabase.from("poll_votes").select("post_id, option_id").eq("user_id", viewerId).in("post_id", vids),
  ]);
  if (tally.error) throw tally.error;
  if (mine.error) throw mine.error;

  const mineBy = new Map<number, number[]>();
  for (const r of mine.data ?? []) mineBy.set(r.post_id, [...(mineBy.get(r.post_id) ?? []), r.option_id]);
  const countBy = new Map<number, number[]>();
  for (const p of visible) countBy.set(p.id, new Array(p.content.options.length).fill(0));
  for (const r of tally.data ?? []) {
    const arr = countBy.get(r.post_id);
    if (arr && r.option_id < arr.length) arr[r.option_id] = Number(r.votes);
  }

  const now = Date.now();
  for (const p of visible) {
    const closes = p.content.closes_at ? Date.parse(p.content.closes_at) : null;
    const closed = closes !== null && closes <= now;
    const my = (mineBy.get(p.id) ?? []).sort((a, b) => a - b);
    const showResults = closed || my.length > 0 || p.user_id === viewerId;
    const counts = countBy.get(p.id)!;
    out[p.id] = {
      closed,
      options: p.content.options.length,
      multiple: p.content.multiple === true,
      total: showResults ? counts.reduce((a, b) => a + b, 0) : null,
      counts: showResults ? counts : null,
      mine: my,
      can_vote: !closed && my.length === 0,
    };
  }
  return out;
}
