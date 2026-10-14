import type { SupabaseClient } from "../auth.ts";
import { resolveAvatarUrl } from "../avatar.ts";
import { renderActivity, type Actor, type PostInfo, type RenderCtx } from "./activityCopy.ts";
import { getPreferences } from "./preferencesService.ts";
import { getPost } from "./postService.ts";
import { formatPost, formatListing } from "./feedService.ts";

const PAGE = 20;
const CDN_BASE = Deno.env.get("CDN_BASE_URL") ?? "";
const TARGETS_MAX = 30;
const KINDS: Record<string, string[] | null> = {
  all: null,
  unread: null,
  likes: ["like", "story_like", "repost", "milestone"],
  comments: ["comment", "reply", "mention"],
  follows: ["follow", "follow_back"],
};
// Kinds that are meaningless once their post is gone/inactive.
const NEEDS_POST = new Set(["like", "repost", "comment", "reply", "post_new", "inquiry", "story_like", "story_reply"]);

export type Me = { id: number; username: string };

const short = (s: string, n = 18) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
// timestamp-without-tz columns come back without a zone; they are UTC.
const iso = (s: string | null | undefined) =>
  !s ? new Date().toISOString() : /(Z|[+-]\d\d(:?\d\d)?)$/i.test(s) ? s : `${s}Z`;

export async function buildCtx(supabase: SupabaseClient, me: Me, items: any[]): Promise<RenderCtx> {
  const actorIds = [...new Set(items.flatMap((i) => (i.actors_preview ?? []) as number[]))];
  const postIds = [...new Set(
    items.flatMap((i) => [i.content_id, ...((i.targets_preview ?? []) as number[])]).filter(Boolean),
  )] as number[];
  const actors = new Map<number, Actor>();
  const posts = new Map<number, PostInfo>();
  const owners = new Map<number, string>();

  if (actorIds.length) {
    const { data } = await supabase.from("users")
      .select("id, name, username, avatar_key, avatar").in("id", actorIds);
    for (const u of data ?? []) {
      actors.set(u.id, {
        id: u.id, name: u.name ?? "", username: u.username ?? "",
        avatar: resolveAvatarUrl(u.avatar_key ?? u.avatar),
      });
    }
  }

  if (postIds.length) {
    const { data } = await supabase.from("posts")
      .select("id, user_id, type, caption, is_active, deleted_at, thumbnail_key, media:post_media(media_type, storage_key, thumbnail_key, sort_order), listing:listing_details(price_minor)")
      .in("id", postIds);
    for (const p of data ?? []) {
      const media = [...(p.media ?? [])].sort((a: any, b: any) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
      const first = media.find((m: any) => m.media_type === "image" || m.media_type === "video");
      const thumbKey = first ? (first.thumbnail_key || (first.media_type === "image" ? first.storage_key : null)) : null;
      const detail = Array.isArray(p.listing) ? p.listing[0] : p.listing;
      posts.set(p.id, {
        id: p.id, type: p.type, caption: p.caption, ownerId: p.user_id,
        noun: p.type === "story" ? "story" : p.type === "listing" ? "listing"
          : first?.media_type === "video" ? "reel" : "post",
        thumb: resolveAvatarUrl(thumbKey || p.thumbnail_key || null),
        active: !!p.is_active && !p.deleted_at,
        mediaCount: media.filter((m: any) => m.media_type === "image" || m.media_type === "video").length || 1,
        price: detail ? (detail.price_minor / 100).toLocaleString() : null,
      });
    }
    const ownerIds = [...new Set([...posts.values()].map((p) => p.ownerId).filter((id) => id !== me.id))];
    if (ownerIds.length) {
      const { data: us } = await supabase.from("users").select("id, name, username").in("id", ownerIds);
      for (const u of us ?? []) owners.set(u.id, u.name || u.username);
    }
  }
  return { meId: me.id, meUsername: me.username, actors, posts, owners, now: Date.now() };
}

export function isVisible(item: any, ctx: RenderCtx): boolean {
  if (!NEEDS_POST.has(item.kind)) return true;
  const targets = item.kind === "like" ? ((item.targets_preview ?? []) as number[]) : [];
  const pid = targets.length ? targets[0] : item.content_id;
  if (!pid) return true;
  const post = ctx.posts.get(pid);
  if (!post) return false;
  const expired = !!item.expires_at && new Date(item.expires_at).getTime() < ctx.now;
  return post.active || (String(item.kind).startsWith("story") && expired);
}

const enc = (t: string, id: number) => btoa(JSON.stringify({ t, id }));
const dec = (c?: string | null) => {
  try { return c ? JSON.parse(atob(c)) as { t: string; id: number } : null; } catch { return null; }
};

export async function getCounts(supabase: SupabaseClient, userId: number) {
  await supabase.from("user_activity_topics")
    .upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });
  const { data: t } = await supabase.from("user_activity_topics").select("topic").eq("user_id", userId).single();
  const base = () => supabase.from("activity_items").select("id", { count: "exact", head: true })
    .eq("recipient_id", userId).is("retracted_at", null).is("dismissed_at", null);
  const [unseen, unread] = await Promise.all([base().is("seen_at", null), base().is("read_at", null)]);
  return { unseen: unseen.count ?? 0, unread: unread.count ?? 0, topic: t?.topic ?? null };
}

// One row per conversation with unread messages. Derived live from
// conversation_participants.unread_count (messaging stays the source of truth), never stored.
// A conversation whose only unread message is the listing-inquiry opener is skipped: the
// inquiry item already covers it.
async function messageRows(supabase: SupabaseClient, me: Me): Promise<any[]> {
  const { data: parts } = await supabase.from("conversation_participants")
    .select("conversation_id, unread_count, last_read_at, request_status")
    .eq("user_id", me.id).gt("unread_count", 0).eq("is_muted", false)
    .or("request_status.is.null,request_status.neq.declined")
    .limit(30);
  if (!parts?.length) return [];

  const ids = parts.map((x: any) => x.conversation_id);
  const reads = parts.map((x: any) => x.last_read_at);
  let sharesQ = supabase.from("messages").select("conversation_id, created_at")
    .in("conversation_id", ids).eq("type", "listing_share").neq("sender_id", me.id)
    .is("deleted_at", null).limit(500);
  if (reads.every(Boolean)) {
    sharesQ = sharesQ.gt("created_at", reads.reduce((a: string, b: string) => (a < b ? a : b)));
  }

  const [{ data: convs }, { data: others }, { data: shares }, prefs] = await Promise.all([
    supabase.from("conversations").select("id, last_message_body, last_message_at")
      .in("id", ids).eq("is_active", true),
    supabase.from("conversation_participants")
      .select("conversation_id, user:users(id, name, username, avatar_key, avatar)")
      .in("conversation_id", ids).neq("user_id", me.id),
    sharesQ,
    getPreferences(supabase, me.id) as Promise<any>,
  ]);

  const convMap = new Map((convs ?? []).map((c: any) => [c.id, c]));
  const otherMap = new Map<number, any>();
  for (const o of others ?? []) if (!otherMap.has(o.conversation_id)) otherMap.set(o.conversation_id, o.user);
  const hide = prefs?.hide_message_preview === true;

  const out: any[] = [];
  for (const part of parts as any[]) {
    const conv: any = convMap.get(part.conversation_id);
    if (!conv) continue;
    const unread = part.unread_count as number;

    const readAt = part.last_read_at ? Date.parse(iso(part.last_read_at)) : 0;
    const openers = (shares ?? []).filter((s: any) =>
      s.conversation_id === part.conversation_id && Date.parse(iso(s.created_at)) > readAt).length;
    if (openers >= unread) continue;

    const u = otherMap.get(part.conversation_id);
    const name = short(u?.name?.trim() || u?.username || "Someone");
    const avatar = u ? resolveAvatarUrl(u.avatar_key ?? u.avatar) : null;
    const pending = part.request_status === "pending";

    let preview: string | null = hide || pending ? null : (conv.last_message_body ?? "").trim() || null;
    const ph = preview?.match(/^\[(\w+)\]$/);
    if (ph) preview = ({ image: "Photo", video: "Video", audio: "Voice message" } as Record<string, string>)[ph[1]] ?? null;

    out.push({
      id: -part.conversation_id, kind: "message", key: unread > 1 ? "message.many" : "message", noun: "post",
      title: pending ? `${name} sent you a message request`
        : unread > 1 ? `${name} sent you ${unread} messages` : `${name} sent you a message`,
      preview, quote: !!preview, thumb: null,
      actors: u ? [{ id: u.id, name: u.name ?? "", username: u.username ?? "", avatar }] : [],
      actor_count: 1, event_count: unread,
      destination: {
        kind: "conversation", conversation_id: part.conversation_id, title: name,
        username: u?.username, user_id: u?.id, avatar,
      },
      is_read: false, is_seen: false, last_event_at: iso(conv.last_message_at), expires_at: null, follow_back: null,
    });
  }
  return out;
}

export async function listActivity(
  supabase: SupabaseClient, me: Me, opts: { cursor?: string | null; filter?: string | null },
) {
  const filter = opts.filter && opts.filter in KINDS ? opts.filter : "all";
  let q = supabase.from("activity_items").select("*")
    .eq("recipient_id", me.id).is("retracted_at", null).is("dismissed_at", null)
    .order("last_event_at", { ascending: false }).order("id", { ascending: false })
    .limit(PAGE + 1);
  if (filter === "unread") q = q.is("read_at", null);
  else if (KINDS[filter]) q = q.in("kind", KINDS[filter]!);
  const cur = dec(opts.cursor);
  if (cur) q = q.or(`last_event_at.lt.${cur.t},and(last_event_at.eq.${cur.t},id.lt.${cur.id})`);

  const { data, error } = await q;
  if (error) throw error;
  const hasMore = (data?.length ?? 0) > PAGE;
  const rows = (data ?? []).slice(0, PAGE);

  const ctx = await buildCtx(supabase, me, rows);

  const followIds = rows.filter((r: any) => r.kind === "follow" && (r.actors_preview ?? []).length)
    .map((r: any) => r.actors_preview[0]);
  const following = new Set<number>();
  if (followIds.length) {
    const { data: f } = await supabase.from("follows").select("following_id")
      .eq("follower_id", me.id).in("following_id", followIds);
    for (const r of f ?? []) following.add(r.following_id);
  }

  const out: any[] = [];
  for (const r of rows) {
    if (!isVisible(r, ctx)) continue;
    const view = renderActivity(r, ctx);
    const actors = ((r.actors_preview ?? []) as number[]).map((id) => ctx.actors.get(id)).filter(Boolean);
    out.push({
      id: r.id, kind: r.kind, key: view.key, noun: view.noun,
      title: view.title, preview: view.preview, quote: view.quote, thumb: view.thumb,
      thumb_count: view.thumbCount, content: view.content,
      actors, actor_count: r.actor_count, event_count: r.event_count,
      destination: view.destination,
      is_read: r.read_at !== null, is_seen: r.seen_at !== null,
      last_event_at: r.last_event_at, expires_at: r.expires_at,
      follow_back: r.kind === "follow" && r.actor_count === 1 && actors[0]
        ? following.has((actors[0] as Actor).id) : null,
    });
  }

  // Unread conversations ride along on the first page of the unfiltered views.
  const withMsgs = !opts.cursor && (filter === "all" || filter === "unread");
  const msgs = withMsgs ? await messageRows(supabase, me) : [];
  const merged = msgs.length
    ? [...out, ...msgs].sort((a, b) => Date.parse(b.last_event_at) - Date.parse(a.last_event_at))
    : out;

  const counts = await getCounts(supabase, me.id);
  const last = rows[rows.length - 1];
  return {
    data: merged,
    next_cursor: hasMore && last ? enc(last.last_event_at, last.id) : null,
    has_more: hasMore,
    unseen_count: counts.unseen, unread_count: counts.unread, topic: counts.topic,
  };
}

// Full post payloads (same shape as /posts-show) behind a "X liked N of your posts"
// item, most recently liked first, so the app can open them in a vertical feed.
// Recipient-only. These are always the recipient's own posts, so isFollowing is false.
export async function listTargets(supabase: SupabaseClient, userId: number, itemId: number) {
  if (!itemId) return { data: [] };
  const { data: item } = await supabase.from("activity_items").select("id")
    .eq("id", itemId).eq("recipient_id", userId).maybeSingle();
  if (!item) return { data: [] };

  const { data: evs } = await supabase.from("activity_events").select("target_id, occurred_at")
    .eq("item_id", itemId).is("retracted_at", null).not("target_id", "is", null)
    .order("occurred_at", { ascending: false }).limit(100);
  const ids = [...new Set((evs ?? []).map((e: any) => e.target_id as number))].slice(0, TARGETS_MAX);
  if (!ids.length) return { data: [] };

  const rows = await Promise.all(ids.map(async (id) => {
    try {
      const r = await getPost(supabase, id, userId);
      if ("notFound" in r || "expired" in r) return null;
      return r.post.type === "listing"
        ? await formatListing(supabase, r.post, CDN_BASE, false, r.isLiked, r.isBookmarked)
        : await formatPost(supabase, r.post, CDN_BASE, r.isLiked, r.isBookmarked, false);
    } catch (e) {
      console.error("listTargets", id, e);
      return null;
    }
  }));
  return { data: rows.filter(Boolean) };
}

export async function markSeen(supabase: SupabaseClient, userId: number, upTo?: string | null) {
  await supabase.from("activity_items").update({ seen_at: new Date().toISOString() })
    .eq("recipient_id", userId).is("seen_at", null).is("retracted_at", null)
    .lte("last_event_at", upTo || new Date().toISOString());
  return getCounts(supabase, userId);
}

export async function markRead(supabase: SupabaseClient, userId: number, id: number | null, all: boolean) {
  const now = new Date().toISOString();
  const upd = (patch: Record<string, string>, nullCol: string) => {
    let q = supabase.from("activity_items").update(patch).eq("recipient_id", userId).is(nullCol, null).is("retracted_at", null);
    if (id && !all) q = q.eq("id", id);
    return q;
  };
  await upd({ read_at: now }, "read_at");
  await upd({ closed_at: now }, "closed_at");
  await upd({ seen_at: now }, "seen_at");
  return getCounts(supabase, userId);
}

export async function dismissItem(supabase: SupabaseClient, userId: number, id: number) {
  const now = new Date().toISOString();
  await supabase.from("activity_items").update({ dismissed_at: now }).eq("id", id).eq("recipient_id", userId);
  await supabase.from("activity_items").update({ read_at: now }).eq("id", id).eq("recipient_id", userId).is("read_at", null);
  await supabase.from("activity_items").update({ closed_at: now }).eq("id", id).eq("recipient_id", userId).is("closed_at", null);
  return getCounts(supabase, userId);
}
