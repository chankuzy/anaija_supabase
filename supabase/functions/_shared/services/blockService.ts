import type { SupabaseClient } from "../auth.ts";

export async function isBlockedEitherWay(supabase: SupabaseClient, userA: number, userB: number): Promise<boolean> {
  const { data, error } = await supabase
    .from("user_blocks")
    .select("id")
    .or(`and(blocker_id.eq.${userA},blocked_id.eq.${userB}),and(blocker_id.eq.${userB},blocked_id.eq.${userA})`)
    .limit(1);
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function getFollowStatus(supabase: SupabaseClient, userA: number, userB: number) {
  const { data, error } = await supabase
    .from("follows")
    .select("follower_id, following_id")
    .or(`and(follower_id.eq.${userA},following_id.eq.${userB}),and(follower_id.eq.${userB},following_id.eq.${userA})`);
  if (error) throw error;

  const aFollowsB = (data ?? []).some((r: any) => r.follower_id === userA && r.following_id === userB);
  const bFollowsA = (data ?? []).some((r: any) => r.follower_id === userB && r.following_id === userA);

  return { aFollowsB, bFollowsA, mutual: aFollowsB && bFollowsA };
}

export async function toggleBlock(supabase: SupabaseClient, blockerId: number, blockedId: number) {
  const { data: existing } = await supabase
    .from("user_blocks").select("id").eq("blocker_id", blockerId).eq("blocked_id", blockedId).maybeSingle();

  if (existing) {
    await supabase.from("user_blocks").delete().eq("id", existing.id);
    return { blocked: false as const };
  }

  await supabase.from("user_blocks").insert({ blocker_id: blockerId, blocked_id: blockedId });

  // Blocking severs the follow relationship both ways — a block implies
  // "no connection with this person," not just "no messages."
  await supabase.from("follows").delete()
    .or(`and(follower_id.eq.${blockerId},following_id.eq.${blockedId}),and(follower_id.eq.${blockedId},following_id.eq.${blockerId})`);

  // Hide any shared conversation from the blocker's inbox going forward —
  // sets it declined on their side only, so getInbox's existing filter
  // catches it without a special case, and it stays alive for the other
  // participant (a block is one-sided by design).
  const { data: mine } = await supabase.from("conversation_participants").select("conversation_id").eq("user_id", blockerId);
  const { data: theirs } = await supabase.from("conversation_participants").select("conversation_id").eq("user_id", blockedId);
  const shared = (mine ?? [])
    .map((r: any) => r.conversation_id)
    .filter((id: number) => (theirs ?? []).some((t: any) => t.conversation_id === id));

  if (shared.length) {
    await supabase.from("conversation_participants")
      .update({ request_status: "declined" })
      .eq("user_id", blockerId)
      .in("conversation_id", shared);
  }

  return { blocked: true as const };
}